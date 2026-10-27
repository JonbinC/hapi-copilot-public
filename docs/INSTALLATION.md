# Self-Hosted HAPI and HAPI Copilot Installation Guide

This guide describes how to install, configure, and operate HAPI Copilot with a self-hosted HAPI instance, including standard stdio MCP operation and an optional HTTPS OAuth / Bearer MCP gateway reference architecture.

---

## 1. Architecture Overview

HAPI Copilot acts as a model-neutral personal operator over your existing self-hosted HAPI infrastructure.

```text
  +-----------------------------------------------------------+
  |              MCP Host / AI Assistant                      |
  |  (Claude Desktop, Cursor, or ChatGPT via Private Tunnel)   |
  +-----------------------------+-----------------------------+
                                | JSON-RPC (stdio or HTTPS)
                                v
  +-----------------------------------------------------------+
  |                   HAPI Copilot Bridge                     |
  |  - Request deduplication & durable SQLite ledger          |
  |  - AGY permission guards & readback verification          |
  |  - Model catalogs, session spawn & native terminal jobs   |
  +-----------------------------+-----------------------------+
                                | REST API + /terminal WebSocket
                                v
  +-----------------------------------------------------------+
  |               Self-Hosted HAPI Hub                        |
  |  - Central coordination, session storage & auth           |
  +-----------------------------+-----------------------------+
                                | WebSocket RPC
                                v
  +-----------------------------------------------------------+
  |               HAPI Runner(s) on Hosts                     |
  |  - Local execution: AGY, Codex, Cursor, shell commands    |
  |  - Native workspace root boundary enforcement             |
  +-----------------------------------------------------------+
```

---

## 2. Prerequisites

- **Node.js**: `v22.16.0` or higher (Node 24 LTS recommended for deployment).
- **Runtime Dependencies**: Zero external npm dependencies. Uses standard Node.js built-ins (`node:sqlite`, `node:crypto`, `node:http`, etc.).
- **Upstream HAPI**: Unmodified official HAPI (`v0.30.7`+). HAPI Copilot does not patch HAPI or require modified binaries.
- **Target OS**: Linux (x86_64 or ARM64) or macOS. File operations and native terminal helpers target POSIX environments with Python 3 available on the target runner.

---

## 3. Quickstart Installation

### 3.1 Clone and Verify

```sh
git clone https://github.com/JonbinC/hapi-copilot-public.git
cd hapi-copilot-public

# Verify all tests and offline smoke test pass cleanly
npm run test:all
npm run smoke
```

### 3.2 Environment Configuration

Create a private environment file `.env` (or set environment variables in your service manager):

```sh
# URL of your self-hosted HAPI Hub REST API
HAPI_API_URL=http://127.0.0.1:3006

# File path containing your HAPI access token (mode 0600)
HAPI_ACCESS_TOKEN_FILE=/etc/hapi-copilot/access-token

# Dedicated private directory for SQLite ledger and operation state (mode 0700)
HAPI_COPILOT_STATE_DIR=/var/lib/hapi-copilot/state

# Policy configuration file path
HAPI_OPERATOR_POLICY_FILE=/etc/hapi-copilot/policy.json
```

Ensure credential and state directory permissions are strictly enforced:

```sh
chmod 700 /var/lib/hapi-copilot/state
chmod 600 /etc/hapi-copilot/access-token
```

### 3.3 Operator Policy Selection

HAPI Copilot supports two primary policy modes:

1. **Observer Mode** (`config/observer.example.json`):
   - Read-only browsing of machines, model catalogs, sessions, and messages.
   - Mutating tools, command execution, and session spawning are disabled.
   - Recommended for inspection or auditing.

2. **Owner Mode** (`config/owner.example.json`):
   - Enables full session lifecycle: spawn, resume, command execution, file editing, and task graphs.
   - Intended **strictly for a private, single-user connection**.
   - Requires explicit acknowledgement (`private_connection_acknowledged: true`).

---

## 4. MCP Client Setup

### Stdio Mode (Recommended)

Stdio MCP is the standard and most secure transport because it avoids exposing network listeners.

**Claude Desktop / Cursor MCP Configuration (`claude_desktop_config.json`):**

```json
{
  "mcpServers": {
    "hapi-copilot": {
      "command": "node",
      "args": ["/opt/hapi-copilot/server/index.mjs"],
      "env": {
        "HAPI_API_URL": "http://127.0.0.1:3006",
        "HAPI_ACCESS_TOKEN_FILE": "/etc/hapi-copilot/access-token",
        "HAPI_COPILOT_STATE_DIR": "/var/lib/hapi-copilot/state",
        "HAPI_OPERATOR_POLICY_FILE": "/etc/hapi-copilot/owner.json"
      }
    }
  }
}
```

---

## 5. Optional HTTPS OAuth / Bearer MCP Gateway Reference

For remote MCP hosts (such as cloud assistant connectors) that require an HTTP(S) endpoint, HAPI Copilot provides an authenticated HTTP transport reference (`server/legacy/remote.mjs`).

### Security Architecture

```text
[ Remote MCP Client ]
         |
         | HTTPS (TLS 1.3) with Bearer token / OAuth
         v
[ Reverse Proxy: Caddy / Nginx / Cloudflare Access ]
         | (Terminates TLS, enforces WAF / rate limiting / OAuth verification)
         v
[ Local Loopback: 127.0.0.1:8787/mcp ]
         |
[ HAPI Copilot HTTP Server (server/legacy/remote.mjs) ]
         | - Constant-time bearer token check (MCP_GATEWAY_TOKEN >= 32 chars)
         | - Rejects browser origins (CORS disabled to prevent CSRF)
         | - Enforces payload size limits (<= 1MB)
         v
[ Internal HAPI Hub: 127.0.0.1:3006 ]
```

### Security Rules for Gateway Operation

1. **Strict Credential Separation**:
   `MCP_GATEWAY_TOKEN` must be a high-entropy secret (at least 32 characters) completely distinct from `HAPI_ACCESS_TOKEN`. The gateway rejects startup if the gateway secret matches any HAPI access token.
2. **Loopback Only**:
   The HTTP server binds to `127.0.0.1` by default and refuses non-loopback binding unless explicitly overridden. All public access must pass through a TLS-terminating reverse proxy.
3. **No Live Token Exposure**:
   No upstream HAPI tokens, user credentials, or machine SSH keys are ever returned to the MCP client or exposed via HTTP headers.
4. **No Direct Browser Access**:
   Requests with an `Origin` header are blocked (HTTP 403) to prevent unauthorized browser-side requests.

### Gateway Launch Example

```sh
export HAPI_API_URL="http://127.0.0.1:3006"
export HAPI_ACCESS_TOKEN="<internal-hapi-token>"
export MCP_LISTEN_HOST="127.0.0.1"
export MCP_LISTEN_PORT="8787"
export MCP_GATEWAY_TOKEN="<random-secure-token-at-least-32-chars>"

node server/legacy/remote.mjs
```

### Reverse Proxy (Caddy) Example with OAuth / Token Auth

```caddy
mcp.example.com {
    tls internal  # Or standard Let's Encrypt certificates

    # Enforce OAuth proxy or forward bearer token
    reverse_proxy 127.0.0.1:8787 {
        header_up Host {host}
        header_up X-Real-IP {remote}
    }
}
```

---

## 6. Model Quota Tracking

HAPI Copilot treats provider quota responsibly:

- **Evidence-Backed**: Quota observations are recorded using `record_quota_observation` based on explicit, timestamped evidence (e.g., from local status tools such as the `CodexBar` CLI, user reports, or documented command outputs).
- **No Provider API Inventions**: HAPI Copilot does not pretend to call private, undocumented provider quota APIs or scrape billing dashboards.
- **Fail-Closed to Unknown**: Expired or unobserved quotas are explicitly reported as `unknown`, preventing false assumptions about model capacity.
- **Historical Tokens vs Quota**: Historical HAPI token counters describe past usage; they are never mislabeled as remaining subscription allowance.

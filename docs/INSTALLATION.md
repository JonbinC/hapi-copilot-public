# Self-Hosted HAPI and HAPI Copilot Installation Guide

This guide describes how to install, configure, and operate HAPI Copilot with a self-hosted HAPI instance, including standard stdio MCP operation and the limits of remote access.

---

## 1. Architecture Overview

HAPI Copilot acts as a model-neutral personal operator over your existing self-hosted HAPI infrastructure.

```text
  +-----------------------------------------------------------+
  |              MCP Host / AI Assistant                      |
  |  (local MCP client, or a separately secured bridge)   |
  +-----------------------------+-----------------------------+
                                | JSON-RPC (stdio)
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
- **Upstream HAPI**: Unmodified official HAPI (v0.30.7 is the documented protocol baseline only; check actual capabilities on other versions, whose compatibility is not established). HAPI Copilot does not patch HAPI or require modified binaries.
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

Create a private environment file `.env` in the repository, or set these variables in your service manager. Replace the example paths with paths you have created and can access; copy `config/observer.example.json` to the policy path first. Start with observer mode:

```sh
# URL of your self-hosted HAPI Hub REST API
HAPI_API_URL=http://127.0.0.1:3006

# File path containing your HAPI access token (mode 0600)
HAPI_ACCESS_TOKEN_FILE=/etc/hapi-copilot/access-token

# Dedicated private directory for SQLite ledger and operation state (mode 0700)
HAPI_COPILOT_STATE_DIR=/var/lib/hapi-copilot/state

# Policy configuration file path
HAPI_OPERATOR_POLICY_FILE=/etc/hapi-copilot/observer.json
```

Create the token file and state directory at the chosen paths and restrict access. For the example paths (when owned by your user):

```sh
chmod 700 /var/lib/hapi-copilot/state
chmod 600 /etc/hapi-copilot/access-token
```

Node does not automatically read `.env`, and this project has no dotenv dependency. From the repository directory, use `node --env-file=.env server/index.mjs` (supported by the required Node 22+), or explicitly export the variables before running `node server/index.mjs`. Secure the `.env` file as well (`chmod 600 .env`). MCP clients must receive the variables through their own configuration or use the `--env-file` argument with an absolute path.

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
        "HAPI_OPERATOR_POLICY_FILE": "/etc/hapi-copilot/observer.json"
      }
    }
  }
}
```

---

## 5. Remote clients and legacy HTTP

The public v0.4.1 modern service exposes its 53 offline-discovered MCP tools through `node server/index.mjs` over stdio. For a remote client such as the ChatGPT webpage, the owner must separately set up and secure an OAuth-compatible HTTPS MCP bridge or gateway that actually connects to this modern stdio service. Such a bridge is not bundled or verified here. TLS termination or a reverse proxy alone does not implement OAuth or authenticate clients.

`server/legacy/remote.mjs` runs the older v0.3 server with a limited tool set and static Bearer-token authentication. It does not implement OAuth and is not the 53-tool modern service. Its token-separation check compares environment variables; it does not compare the contents of `HAPI_ACCESS_TOKEN_FILE`. Do not rely on that check to establish credential separation. This guide does not provide a public Internet exposure recipe.

Begin with observer mode. Use owner mode only after verifying that the entire connection is private and accessible exclusively to the intended single user; a policy acknowledgement is not identity verification.

---

## 6. Model Quota Tracking

HAPI Copilot treats provider quota responsibly:

- **Evidence-Backed**: Quota observations are recorded using `record_quota_observation` based on explicit, timestamped evidence (e.g., from local status tools such as the `CodexBar` CLI, user reports, or documented command outputs).
- **No Provider API Inventions**: HAPI Copilot does not pretend to call private, undocumented provider quota APIs or scrape billing dashboards.
- **Fail-Closed to Unknown**: Expired or unobserved quotas are explicitly reported as `unknown`, preventing false assumptions about model capacity.
- **Historical Tokens vs Quota**: Historical HAPI token counters describe past usage; they are never mislabeled as remaining subscription allowance.

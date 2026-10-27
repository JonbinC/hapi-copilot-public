# HAPI Copilot (Open Edition)

**A model-neutral personal operator for your self-hosted HAPI.**

Tell your assistant what you want. It can discover your machines, choose any supported agent and model, create or resume sessions, send prompts, inspect evidence, run native terminal commands, work on files, and coordinate a task graph. Agent client, model, task role and machine are separate choices. There is no mandated "AGY executes / Codex reviews" pipeline.

> **Release Edition Notice:** This public open edition is based on the stable **v0.4.1** codebase and **does not claim v0.4.2 parity** or include unreleased private development features. The repository was reviewed with no obvious known secrets found; this is not a guarantee that none remain. See [verification](docs/VERIFICATION.md).

> **Breaking AGY dispatch requirement:** `dispatch_task` on an AGY session requires `required_permission_mode` (`request-review` for intentional review or `always-proceed` for authorized coding). The bridge reads the actual session first, then validates and compares the mode immediately before sending. Missing, unsupported, or mismatched modes are blocked before the message is sent. Codex/Cursor and other agents keep their existing dispatch behavior. `send_session_message` remains backward compatible and accepts the same precondition optionally.

## What it reuses

```text
Your assistant / MCP host
          |
  stdio (or a separately secured bridge)
          |
  HAPI Copilot (this repository)
          | REST + native /terminal client namespace
  unmodified official HAPI Hub
          |
  existing HAPI CLI / Runners on your machines
          |
  any installed supported agent, model, project or native terminal
```

No new Runner, SSH service, AI-model proxy, subscription-token relay, or fork of HAPI is introduced. The bridge does not execute remote commands on its own host by mistake: native terminal operations are tied to a verified HAPI session on the target machine.

## Implemented

- Machine and agent discovery; dynamic native model catalogs, with explicit user model/permission selection.
- Owner-scoped messaging across all sessions visible to the authenticated HAPI namespace. No fixed session allowlist in the new operator tools.
- Spawn, resume, reopen, rename, abort, archive, fork, pin, control handoff, model/configuration and native approval handling.
- AGY spawn/resume require an explicit `request-review` or `always-proceed` mode and verify the returned session's native metadata. Mismatched or unreadable mode results preserve the session ID and block dispatch when a mode precondition is requested.
- Native directory browsing, filename search, base64 file reads and Git evidence.
- Native HAPI terminal open/read/write/close, POSIX command jobs, project creation and guarded UTF-8 writes.
- Persistent request deduplication, explicit unknown-delivery state, command evidence and structured errors.
- `get_message_delivery` reconciles native queued/invoked/unknown state by `localId` and reports a timestamped activity snapshot. Invocation and agent claims are not task completion; plan evidence and explicit user acceptance stay manual.
- Generic task graphs, dependencies, handoff and optional independent review using **any chosen agent**.
- **Timestamped, evidence-backed quota observations.** Quota observations are derived from timestamped CLI evidence (such as local `CodexBar` status or explicit operator reports). HAPI Copilot makes no promise of private provider quota APIs, never scrapes private account endpoints or fabricates subscription allowance, and treats unobserved or expired quota strictly as `unknown`.
- A lightweight MCP Apps dashboard. All UI tool calls pass through the host; the iframe receives no Hub token.
- All 14 previous bridge tool names retained. Legacy task/review tools retain their original policy and ledger; use the new operator tools for unrestricted namespace-level orchestration.

See [tool reference](docs/TOOLS.md), [installation guide](docs/INSTALLATION.md), [architecture](docs/ARCHITECTURE.md), [migration](docs/MIGRATION.md), and [deployment handoff](docs/DEPLOYMENT_HANDOFF.md).

### AGY permission modes

Pass `permission_mode: "request-review"` or `permission_mode: "always-proceed"` explicitly to `spawn_session` and `resume_session` for AGY. `request-review` is a valid intentional choice and keeps native approval prompts in effect; `always-proceed` is never selected implicitly. AGY `spawn_session` rejects `yolo: true` because its effect on native permission mode is unverified; it is not treated as an alias. After AGY spawn, resume, or permission configuration, the bridge performs at most four read-only session checks within a 1.4-second budget. It reports `permission_verified` only when a returned session has the exact requested mode. `unverified` means the bridge could not confirm the mode in that window; it does not mean HAPI denied the operation. The result keeps the session ID, requested mode, last observed mode (or `null`), and `dispatch_blocked: true`. Use `get_session` to inspect the current mode and correct it explicitly if needed; do not repeat a possibly successful spawn, resume, or config write.

`reopen_session` preserves the existing AGY mode and reports the observed current value with one read. It does not switch to `always-proceed`. `set_session_config` accepts only the two AGY modes and confirms the change from session metadata rather than treating a Hub acknowledgement as proof. Since `dispatch_task` targets a session ID whose flavor is learned at runtime, its schema keeps `required_permission_mode` optional for generic callers; the controller requires it after reading an AGY session and accepts only `request-review` or `always-proceed`, then requires an exact match to actual `permissionMode` before sending. A read-only task intended to operate under `request-review` can declare that mode as its precondition. Existing callers that dispatch tasks to AGY must add the precondition; those calls now fail closed until updated. `send_session_message` remains generic and backward compatible, with an optional mode precondition for callers that want the same check.

`get_message_delivery` makes one read-only queued-state lookup and one session read. It retains the legacy queue-array fields but filters each to the requested `localId` only. Invocation is correlated only by that ID; conflicting native states return unknown with `schema_conflict`. The tool reports `active`, `thinking`, and pending native approval count as a point-in-time snapshot. A missing endpoint or uncertain schema leaves delivery unknown and reports evidence availability. It does not fetch or infer a correlated agent reply. `task_outcome`, `completion`, and `user_acceptance` remain `unverified`; attach independent evidence to a plan step and record `reported_done` manually, then set `accepted` only after explicit user acceptance.

Regression coverage uses a deterministic mock Hub for stale/null reads, transient failures, persistent mismatches and read failure. It does not spawn a live AGY session or change the deployed HAPI/Hub/tunnel. Updating bridge code does not update ChatGPT's cached tool schema; reconnect the MCP client to discover current schemas.

## Run and test

Node.js **22.16+** (24 LTS preferred for deployment). There are **no npm runtime dependencies**. Node's built-in `node:sqlite` emits an experimental warning on the tested Node 22 release; it goes to stderr, never MCP stdout.

```sh
npm run test:all
npm run smoke
```

For read-only local use, configure `HAPI_API_URL`, `HAPI_ACCESS_TOKEN_FILE` (0600) and `HAPI_COPILOT_STATE_DIR` (private 0700 directory), then:

```sh
node server/index.mjs
```

`config/observer.example.json` is the conservative default. To intentionally enable personal owner control, copy `config/owner.example.json` to an **operator-owned** configuration path and point `HAPI_OPERATOR_POLICY_FILE` at it. Copying the owner policy is an explicit trust decision for a **single-owner, private connection**; this package does not verify a ChatGPT user's identity independently.

See [docs/INSTALLATION.md](docs/INSTALLATION.md) for full setup instructions, including stdio MCP configuration and the limitations of remote access. The modern 53-tool service is stdio only; an OAuth-compatible HTTPS gateway for ChatGPT is not bundled or verified here.

## Freedom and boundaries

Owner mode operates in the same authenticated HAPI namespace and under the real runner/session OS permissions. Without native workspace roots, browsing/spawning may cover any OS-accessible directory; with roots configured, HAPI enforces them. Native terminal commands have HAPI's native terminal authority, **not an OS sandbox created by this bridge**.

Normal development operations use standing owner authorization, not a per-session allowlist. Destructive dedicated tools such as deleting a session require explicit confirmation. Arbitrary shell input is inherently powerful: neither a tool annotation nor a prompt is a security sandbox. The assistant and host must still respect the user's scope and seek confirmation for destructive, financial, production-disrupting or credential changes not already authorized.

## Important limits

- This is not a background thinking agent. Plans persist, and already-started command processes can continue while the bridge runs, but no model is automatically called to keep planning after the chat ends.
- Native terminal integration implements the tested text-event WebSocket subset of HAPI's Socket.IO/Engine.IO protocol. It has no long-polling fallback or automatic command replay. Direct wire and local fixture tests pass; real HAPI terminal acceptance remains to be done.
- `run_command`, `create_project` and `write_session_file` currently target POSIX hosts. The structured file helpers also require Python 3 on the **target**. Windows native terminal input is possible, but the POSIX helpers are not advertised as Windows-compatible.
- Provider quota APIs are not invented. The quota tools store explicitly sourced observations; they do not scrape private account endpoints or add subscription capacity.
- Session-spawn availability checks do not prove login, quota, model selection or successful execution.
- The source supports integration testing, not proof that future HAPI versions will never change. Upgrade HAPI independently, then run contract checks.

## License and inspiration

New source: MIT. The compatibility layer comes from the previous user-owned HAPI Agent Console source package. HAPI is a separate AGPL-licensed upstream project; WebCodex was studied as an architectural reference. Neither project's implementation or UI is assumed to be vendored. These notes are not a legal audit. See [third-party notes](THIRD_PARTY_NOTICES.md).

Chinese delivery guide: [中文接入说明](docs/QUICKSTART.zh-CN.md).

# Migrating from HAPI Agent Console v0.3.x

This is an additive release. Do not overwrite an existing deployment directory (e.g. `/opt/hapi-agent-console`) blindly without first comparing changes and staging side-by-side.

## Preserve these independently

- Official HAPI package and Hub database: unchanged.
- Existing tunnel resource, credentials and connection identity: unchanged.
- Configuration policies and credentials: operator-controlled.
- Existing state directory: keep existing v1 task ledger and unresolved records intact.
- Host-specific maintenance scripts: retain and review during updates.

## What changes

The new MCP entrypoint is `server/index.mjs`. Original v0.3 server/tasks code resides under `server/legacy/`, with credential-file support and redaction fixes. All 14 original tool names remain discoverable. New owner tools do not require listing every session ID in the old policy.

Set `HAPI_CONSOLE_STATE_DIR` and `HAPI_CONSOLE_POLICY_FILE` exactly as before to retain legacy behavior. Set a **different** `HAPI_COPILOT_STATE_DIR` for new operations/plans. The new service does not reclassify, close or accept the previously failed task.

The old `send_task`, `request_review` and `record_task_decision` keep their per-session policy. For new unrestricted namespace-level coordination, use `dispatch_task`, `send_session_message`, `review_operation`, and generic plans. This avoids silently changing the authority of existing callers.

Tools with shared names such as `get_capabilities`, `get_session`, `list_sessions`, `read_session_messages`, `get_session_changes` and `open_dashboard` use the richer v0.4 output. Callers must read current schemas/outputs; retaining a name is not a promise of identical response shape. The old dashboard resource remains readable for compatibility.

## Source of truth

Use a reviewed, pinned public repository commit as the bridge source of truth. The package version comes from `package.json`. `get_integration_status.bridge.code_revision` is populated only when the running module path contains an exact 40-hex `/releases/<SHA>/` directory segment; `revision_source: "release_directory_name"` describes that naming convention and is not cryptographic attestation. Otherwise revision fields are `null`. Do not redeploy an older Plugin Creator archive over new on-machine fixes. Updating code does not update ChatGPT's cached tool schema; reconnect the MCP client after changing the server to rediscover schemas.

## Rollback

Before switching the tunnel's MCP command, record the exact previous command, package commit, service identity and environment. Stage the new release side-by-side. On failed acceptance, restore the old MCP command and restart only the bridge/tunnel service in the approved window. Do not roll back HAPI's database merely because a new bridge fails. Keep both old/new ledgers for reconciliation.


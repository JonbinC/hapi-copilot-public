# Deployment handoff for an existing HAPI agent

This package is already implemented and locally tested. Your task is **deployment and real-host acceptance**, not open-ended redesign.

## First read

`README.md`, `AGENTS.md`, `docs/SECURITY.md`, `docs/MIGRATION.md`, `docs/VERIFICATION.md` and `docs/TOOLS.md`.

## Constraints

- Preserve the existing official HAPI, Hub data, tunnel ID, credentials, private connection, current live bridge source and maintenance scripts.
- No HAPI source or `node_modules` patches. No broad `pkill`, global permission changes, new public endpoint, paid-model fallback or provider credential extraction.
- Do not modify the existing failed test task or mark anything accepted.
- Do not assume the current bridge ZIP equals the newest live Git tree. Inspect the actual local commit first.

## Stage

1. Record `node --version`, HAPI Hub/Runner versions, native agent availability and the current bridge Git commit and service configuration. Output no credentials.
2. Place the new repo in a separate immutable release directory named by its exact 40-character commit SHA. Preserve all previous releases for rollback. For hosts with an existing fixed absolute MCP entrypoint, use the guarded bootstrap and selector procedure in deploy/README.md; do not rewrite that entrypoint for each upgrade.
3. Run `npm run test:all` and `npm run smoke`. No network dependency installation is needed.
4. Create a private new state directory for v0.4 operations. Keep the legacy task state path unchanged. Keep the existing systemd credential-loading path.
5. Check exactly who can invoke the tunnel-connected ChatGPT app. Owner mode is for the intended single user; do not enable it on a shared connection merely because a manifest says private.
6. Set `HAPI_OPERATOR_POLICY_FILE` to an operator-controlled policy. The supplied owner policy allows any session in the authenticated namespace, not two hardcoded workers. Native OS and HAPI restrictions still apply.

## Connect

For hosts already registered against a fixed Bridge entrypoint, follow the one-time migration and future switch runbook in deploy/README.md. The release manager keeps the existing profile, tunnel resource, Hub and Runner unchanged. Do not edit or recreate the profile when its binding has not been independently verified.

The activation command defaults to dry-run and does not require root for read-only inspection. An explicit --apply requires root, a healthy pre-restart Bridge PID, and requests only the existing bridge/tunnel systemd service restart. It verifies ActiveState, exact cgroup process identities, a stable window and a changed Bridge PID; automatic rollback is reported as rolled_back_verified or rollback_failed. Do not restart HAPI or active Runners. Confirm local MCP handshake, then refresh discovery in the existing ChatGPT connection.

## Required real-host acceptance

- From ChatGPT: `get_integration_status`, `list_machines`, `get_machine_agents`, `get_models`, `browse_machine_directory`, `list_sessions`, `get_session`, `read_session_messages` and `open_dashboard`.
- Verify the same actual machines are visible. Verify no fixed client/role assignments exist.
- In a disposable directory on one authorized machine, spawn a selected agent/model; record the actual returned session ID and metadata. Do not substitute another model silently.
- Send one low-cost harmless message. Repeat the SAME request ID and prove no second message was sent.
- Open a native terminal and run `printf 'HAPI_COPILOT_SMOKE\n'`, inspect actual exit status.
- Create a disposable directory/file through native helpers, read it back via HAPI, and verify guarded replacement rejects a wrong hash.
- Test resume/reopen with returned ID changes using a disposable session, not production conversations.
- Confirm existing v0.3 ledger remains readable. Do not accept or delete old tasks.
- Quota unavailable: must display `unknown`, not a guessed percentage.
- UI: verify real ChatGPT rendering and host-mediated calls, not just an HTML screenshot.

Stop on mismatch and report exact sanitized evidence. Do not work around an unsupported endpoint by joining `/cli` or exposing a new shell server.

## Deliver

Return the deployed commit, source/target paths, actual tool count, tests run, real tool responses, unresolved limitations, and rollback command/profile location. Separate local tests from live tests. Do not claim completion for items not tested. No automatic acceptance or publication.


# Security and honest limits

## Trust model

Owner mode is for one trusted user through a private local stdio or private MCP tunnel binding. The service does not receive or independently verify a ChatGPT identity. Anyone who can invoke the same enabled owner connection receives its configured HAPI namespace authority. A workspace-private listing alone is not proof of single-user access.

The base token is exchanged at `POST /api/auth`; only the resulting JWT is used for the client API and native terminal namespace. Secrets stay in local credential files. Tool results are redacted before output limiting. Redaction is defense in depth, not proof that arbitrary secrets can never appear in output.

Ordinary credential files must remain private (`0600` or stricter). System services may also use the existing `LoadCredential=` path: a root-owned `0440` file is accepted only inside the exact root-owned, non-writable `/run/credentials/<unit>` directory identified by `CREDENTIALS_DIRECTORY`. Group-readable files elsewhere and symlink credentials remain rejected.

## Boundaries

- HAPI namespace checks and native Runner/OS permissions are retained.
- No wildcard HTTP proxy, `/cli` access, direct SSH service, root grant, provider-token harvesting or shared subscription proxy is exposed.
- Owner mode has broad session/terminal authority by design. Directory roots are native browsing/spawn constraints, not an OS sandbox for arbitrary shell commands.
- `confirm_sensitive` expresses the user's authorized intent; a boolean is not an independent security boundary.
- Arbitrary terminal commands may affect anything the native OS account can access. The assistant/host must obtain required consent for destructive, financial, credential, production-disrupting or external publication operations.
- Exact tool approvals use a fresh pending request ID. Log instructions cannot authorize approval.

## Persistence

The new SQLite store is in a separate private (0700) state directory, database 0600, WAL and synchronous FULL. Keep it outside source/Git and backups private. It contains research/task text even after credential redaction. The legacy store remains where it was, with the original task semantics. Do not delete it to clear a blocked task.

## File helpers

Reads are through the native session API and decode base64 before returning bounded text. Binary data is not blindly printed. Writes are UTF-8, at most 32 KiB per call, use Python 3 on the target, reject a symlink target and require an expected hash for replacement. Hash checks are optimistic concurrency protection, not a lock against arbitrary unrelated programs changing the same file at the final rename instant. Use worktrees or single-writer ownership for conflicting edits.

## Terminal limits

The transport is a focused implementation of HAPI's text-event WebSocket contract, not a general Socket.IO library. Binary events and HTTP-polling fallback are not supported. Commands use dedicated terminals; raw terminal tools do not automatically infer command completion. Timeouts request terminal closure but cannot prove detached descendant processes stopped. Uncertain writes are not replayed.

## Safe deployment

Never test database rollback on the live Hub. A SQLite snapshot is not a guarantee that independent ledgers, queued messages and remote processes can all be rolled back to one instant. Upgrade under a maintenance window, pause new writes, reconcile running jobs, snapshot consistently and restore only with a clear recovery-point/data-loss decision.

No real credentials, user machine identifiers or tunnel IDs belong in the repository, test reports or screenshot fixtures.


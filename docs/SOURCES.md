# Source grounding

Inspected on 2026-10-24. The implementation is written independently; these are protocol/architecture references, not vendored source.

## HAPI baseline: v0.30.7

- https://github.com/tiann/hapi/blob/v0.30.7/shared/src/apiTypes.ts
  - SpawnSessionRequestSchema, MachineListDirectoryRequestSchema, message/cursor types.
  - Inspected schema blob SHA: `4a871fa576b29b3294da514f00fb311322862913`.
- https://github.com/tiann/hapi/blob/v0.30.7/hub/src/web/routes/machines.ts
  - Machine availability, directory listing, model catalogs and spawn. A failed spawn can be HTTP 200 with `type:error`.
- https://github.com/tiann/hapi/blob/v0.30.7/hub/src/web/routes/sessions.ts
  - Lifecycle/configuration. Resume/reopen can return a new session ID.
- https://github.com/tiann/hapi/blob/v0.30.7/hub/src/web/routes/messages.ts
  - Message `localId`, queue/steer, and queued-state reconciliation.
- https://github.com/tiann/hapi/blob/v0.30.7/hub/src/web/routes/permissions.ts
  - Native pending requests and response routes.
- https://github.com/tiann/hapi/blob/v0.30.7/hub/src/web/routes/git.ts
  - Session files are base64; directory/file/Git APIs are RPC wrapped.
- https://github.com/tiann/hapi/blob/v0.30.7/web/src/hooks/useTerminalSocket.ts
  - Native `/terminal` client JWT, `terminal:create`, `terminal:ready`, `terminal:output`, `terminal:write`, `terminal:exit`, `terminal:error`.
  - Inspected file blob SHA: `d96c452ee03bd426de3d8e96ce54444f23636cc6`.
- https://github.com/tiann/hapi/blob/v0.30.7/hub/src/socket/handlers/terminal.ts
- https://github.com/tiann/hapi/blob/v0.30.7/hub/src/socket/server.ts
- https://hapi.run/docs/api/client-contract/rest
- https://hapi.run/docs/guide/installation

## WebCodex architectural reference

- https://github.com/yyjeqhc/webcodex/tree/main
- https://github.com/yyjeqhc/webcodex/blob/main/README.md
  - Inspected README blob SHA: `b2becddfb06f9e7de0a2b051ad38a8c97bbcd76c`.
- https://github.com/yyjeqhc/webcodex/blob/main/docs/ARCHITECTURE.md

Useful ideas: client/server/runner separation, observable long-running jobs, explicit handoff/continuity, and the distinction between execution authority and coordination records. This project intentionally reuses HAPI instead of implementing a second WebCodex runtime.

## MCP and UI

- https://developers.openai.com/plugins/build/mcp-server
- https://modelcontextprotocol.io/docs/develop/build-server

MCP stdio must keep stdout JSON-RPC-only. This server negotiates the explicitly implemented protocol versions and does not pretend to implement newer protocol features merely because a documentation page exists.


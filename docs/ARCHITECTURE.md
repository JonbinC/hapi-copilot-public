# Architecture and design decisions

## Goals

Act as a user's delegate over the HAPI they already operate. The assistant chooses a machine, project, agent client, model and task strategy based on current conditions. No fixed vendor/role mapping is used. HAPI owns sessions, agent integrations, machine routing, native controls and its own persistence. This repository owns the MCP presentation, request deduplication and optional coordination state.

## Components

| Module | Responsibility |
|---|---|
| `server/index.mjs` | MCP lifecycle, discovery, resources, UI and compatibility routing |
| `server/controller.mjs` | Named native-client operations and generic workflow tools |
| `server/hub.mjs` | JWT exchange, bounded HTTP, explicit read/mutation behavior |
| `server/terminal.mjs` | Native `/terminal` text-event transport and observable command jobs |
| `server/store.mjs` | SQLite request ledger, plans and quota observations |
| `server/config.mjs` | Local operator policy; observer/owner authority |
| `server/security.mjs` | Validation, secret redaction and request identity hashing |
| `server/legacy/` | Previous v0.3 task/review protocol, retained without state migration |
| `ui/console.html` | Host-mediated neutral session/model console |

## A deliberately smaller scope than WebCodex

WebCodex supplies its own Server, Runner, project registry, durable agent/goal/job domains and multiple product surfaces. HAPI already supplies much of the machine/session runtime we need. We adopt the useful separation of continuity, evidence and execution authority, but do not implement a second Runner or clone all of WebCodex.

This makes the integration smaller in scope; it does not establish faster performance, better security or greater reliability. Those require real deployment measurements.

## Request identity

A mutating request is recorded before forwarding. `(principal scope, request_id)` is unique; the action and arguments are fingerprinted. Reusing the ID with identical arguments returns the existing record. Reusing it with different arguments fails. Network uncertainty creates an `unknown` record and never automatically reruns the action.

The scope includes a digest of the Hub origin and configured credential. Credential rotation therefore creates a separate scope. Do not rotate while operations are unresolved without deliberately reconciling/migrating their records. No credentials are stored in ledger payloads.

The ledger guarantees no *automatic replay by this bridge for the same request ID*, not universal exactly-once remote execution. HAPI spawn has no assumed idempotency token; an uncertain response may represent a successfully created process. Reconcile native sessions rather than spawning again.

## Model and quota freedom

Agent availability, native model catalogs, configured model, historical token usage, and provider quota are different facts. They must not be collapsed into one green availability badge. Quota observations include provider, account label, shared pool, model (optional), source, time and expiry. Unknown remains unknown.

Quota observations are grounded strictly in timestamped CLI evidence (such as local CodexBar / status bar evidence, explicit user reporting, or documented command outputs). HAPI Copilot intentionally makes no promise of private provider quota APIs, does not scrape provider billing dashboards or subscription endpoints, does not fabricate remaining allowance numbers, and treats unobserved or expired quota as `unknown`.

There is no artificial quota pooling across providers. No subscription OAuth token is converted into a general API credential. Automatic paid overage is not enabled by this service.

## Native commands

HAPI's client terminal namespace is `/terminal` using a client JWT. The bridge never joins `/cli`. A command uses a fresh dedicated native terminal, a POSIX readiness marker and nonce-framed start/end output. Persistent operation IDs fence replay; longer commands return a job ID. On bridge restart, unfinished in-memory command attachments become unknown. Reconnection is not a license to repeat them.

The minimal transport deliberately supports text events over WebSocket only. It is exercised through an actual local WebSocket endpoint in tests, but needs real HAPI acceptance before production command use. HAPI/OS permissions remain authoritative; the bridge is not a sandbox.

## Task graphs and ongoing work

Plans store the user goal, step dependencies, assignments, evidence and revisions. Creating a graph does not launch agents. The assistant deliberately dispatches and inspects each step using tools. `reported_done` is distinct from `accepted`; acceptance requires explicit user intent. No hidden model, scheduler or recurring paid process is introduced.

`get_message_delivery` uses the recorded operation ID, request ID and localId to read HAPI's native queued-state endpoint plus one session snapshot. It preserves the legacy queue-array field names but filters every array to the one requested localId (at most one entry per array). Exact localId matches can establish queued or invoked delivery; contradictory states produce unknown with `schema_conflict`. `active`, `thinking` and native pending approval count describe only the timestamped session snapshot. Missing endpoint data and schema uncertainty fail closed. HAPI's client contract does not supply task completion or user acceptance, and native conversation replies do not carry an assumed task correlation marker, so this tool leaves `response_evidence` unattributed and all task outcome fields unverified. Independent file/test evidence and plan-step state remain manual.

Protocol evidence is pinned to HAPI v0.30.7: the [messages route](https://github.com/tiann/hapi/blob/v0.30.7/hub/src/web/routes/messages.ts#L662-L699) validates the read-only queued-state request and returns the native queue result; [shared session schemas](https://github.com/tiann/hapi/blob/v0.30.7/shared/src/schemas.ts#L2042-L2077) define `active`, `thinking`, and `agentState`; [AgentState](https://github.com/tiann/hapi/blob/v0.30.7/shared/src/schemas.ts#L1852-L1876) stores pending requests separately from transcript messages.

## Upgrade boundary

HAPI, tunnel-client, bridge code, local policy and runtime state are separate lifecycles. Routine HAPI upgrades should not require a new tunnel or plugin identity, but API/protocol compatibility still requires testing. The package never edits the official HAPI installation.

The production Bridge release lifecycle is managed separately in deploy/. Its one-time fixed-entrypoint bootstrap reads a root-owned commit-SHA selector, adjusts Node's process.argv[1] to preserve ESM direct-launch checks, and imports an immutable staged release. The dry-run-first activation command switches the selector atomically and verifies the active systemd unit, exact cgroup process identities, stability window and changed Bridge PID; failed switches restore the prior selector and verify rollback health. It does not alter tunnel profiles or add a service. See deploy/README.md for the guarded migration and rollback procedure.


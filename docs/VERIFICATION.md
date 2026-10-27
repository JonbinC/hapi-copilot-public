# Verification report - HAPI Copilot 0.4.1 Open Edition

Date: 2026-10-27. Status: **locally tested sanitized open edition (v0.4.1 baseline); not deployed to production HAPI**.

## Build environment

- Linux ARM64 (aarch64), Node.js 22.23.1, npm 10.9.2, Git 2.47.3.
- No npm runtime dependencies and no authenticated provider calls in the test suite.
- SQLite is Node's built-in `node:sqlite`. Its experimental warning on this Node release is emitted on stderr.
- Upstream API reference: HAPI `v0.30.7`; exact sources are recorded in `SOURCES.md`.

## Automated results

| Check | Actual result |
| --- | --- |
| `npm run check` | JavaScript and JSON syntax checks passed |
| `npm test` | 98 tests passed, 0 failed |
| `npm run test:legacy` | 26 tests passed, 0 failed |
| Total Node tests | **124 passed, 0 failed** |
| `npm run smoke` | Offline MCP initialize, tools/list and UI resource checks passed |
| Discovered tools | **53 unique tool names**, including the original 14 names |
| `node scripts/scan-secrets.mjs` | Basic release-pattern scan passed; not a guarantee that no secret can exist |

The test suite includes:

- A real child-process stdio MCP handshake and operational requests against a mock HTTP HAPI Hub.
- An actual local WebSocket connection to a fixture implementing the HAPI text-event Socket.IO/Engine.IO flow, including namespace JWT authentication and heartbeat handling.
- Local temporary shell/file fixtures for command markers, exit status, project creation, exclusive file writes and hash-guarded replacement. These do not access remote machines.
- Persistent request deduplication, conflicting request IDs, uncertain delivery, incomplete response bodies, process restart state and explicit message reconciliation.
- Native response contract checks, observer/owner gates, local-control versus shared-session behavior, returned session-ID changes and approval handling.
- AGY permission mode guards, readback bounds, and fail-closed dispatch validation.
- Generic dependency graphs, revision conflicts, handoff to a different client, optional review and explicit final acceptance.
- Expiring evidence-backed quota observations via timestamped CLI evidence; absence is unknown rather than a fabricated quota.
- Credential redaction, bounded file decoding and output, legacy state compatibility and the observer-mode guard over legacy writes.

## UI checks

Python Playwright with Chromium exercised `ui/console.html` through an in-memory mock host. No browser policy was disabled, and no live Hub or account data was used.

| Viewport | JavaScript errors | Horizontal overflow | Interaction checks |
| --- | --- | --- | --- |
| 1440 x 1000 | None | None | Session selection, send, stable repeated request ID, machine/model choices |
| 390 x 844 | None | None | Same checks |

Desktop screenshot was visually inspected. Screenshots are mock-data previews, **not proof of rendering inside ChatGPT**.

## Explicitly not verified

- Actual end-to-end operation of the v0.4 tools against a production self-hosted HAPI Hub, real runners and installed agent versions.
- Real ChatGPT MCP App rendering, refresh of its tool definitions, and tunnel restart behavior.
- Whether a particular workspace connection is accessible only to its intended owner. That is a deployment prerequisite, not a check enforced by this source alone.
- Windows command helpers, a full Socket.IO implementation, HTTP long-polling fallback or every network failure mode.
- Live provider subscription quota APIs. This release stores sourced observations (e.g. from CodexBar CLI or user reports) and reads HAPI historical usage; it does not claim automatic access to all providers' remaining allowance or promise provider quota APIs.
- User-side backup/restore, database migrations, future HAPI compatibility, production load or an independent security audit.
- Unreleased v0.4.2 development features: this public edition is explicitly based on stable sanitized v0.4.1 and does not claim v0.4.2 parity.

## Effects of this build

No production HAPI, runner, tunnel, credential or task acceptance record was changed. No model task was dispatched, no public endpoint was opened, and existing live tools remain on the deployed version until an authorized operator installs and validates this release.

An implementation test passing is not the same as successful deployment, a worker reporting completion, independent validation, or user acceptance. Keep those states separate.

## Deployment compatibility patch

Real systemd staging exposed a startup rejection: `LoadCredential=` supplied a protected root-owned `0440` credential, while the original loader required owner-only permissions. The loader now recognizes that specific systemd credential location without weakening checks on ordinary credential files. A regression test keeps ordinary group-readable files and symlinks rejected.

After this patch and subsequent test suite enhancements (including AGY permission guard readbacks, task outcome evidence, and release manager verification), Linux ARM64 with Node.js 22.23.1 passes **98 new tests + 26 legacy tests = 124 tests**, with 0 failures. Offline discovery reports **53 tools**. Real-host staging and final ChatGPT acceptance must still be recorded separately; these automated tests alone do not claim a live deployment.

Read-only staging also confirmed the native AGY catalog uses `availableModels` with `modelId`, while other catalogs use `models` with `id` and `displayName`. The dashboard accepts both arrays and explicitly displays `unknown` when no quota observations exist. The mock browser check covers both catalog forms and the expanded quota panel; it remains separate from real ChatGPT host acceptance.

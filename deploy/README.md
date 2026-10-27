# Production Bridge release manager

This is a reusable release manager for HAPI Copilot deployments. It manages deployment lifecycle transitions for the bridge service (e.g. `hapi-console-tunnel.service` or custom unit). It does not touch HAPI, Runner, tunnel identity, credentials, or the Hub. It has no daemon, scheduler, SSH component, or third-party dependency.

## Guard model

The installed `bridge-bootstrap.mjs` derives the release root from its own fixed location under `releases/<sha>/server/index.mjs`. It reads the root-owned `current-release` selector, accepts exactly a lowercase 40-character commit SHA with an optional final newline, resolves only `releases/<sha>/server/index.mjs`, and sets `process.argv[1]` before dynamic import. This preserves Node's direct-execution guard. The root and all its ancestors, releases directory, selected release and server directory must be owned by the expected owner and not group/world writable. The selector is root-owned, readable by the service account (mode 0644), and never group/world writable; the SHA is a release identifier, not a secret. Release directories and entrypoints cannot be symlinks. Do not replace the registered entrypoint with a symlink.

Activation is dry-run by default and does not require root. Dry-run inspects files only and does not run systemctl. For CI or a non-root preview, `--owner-uid` defaults to the current UID; pass `--owner-uid 0` when previewing files installed as root. Apply requires root and root-owned deployment files.

Apply requires an existing valid selector and a healthy prior service so it can record the Bridge PID. It atomically replaces the selector and restarts only the managed service. The gate checks systemd ActiveState, the exact service cgroup, exactly one tunnel-client and one Bridge Node, each process's PID plus `/proc` start time, and an unchanged identity set for 15 seconds after startup (up to 45 seconds). The Bridge PID must differ from the pre-restart PID. Success is reported as `switched_verified`.

On activation failure the manager restores the old selector, restarts that same service once, and verifies the active unit, process identities, stability window and changed Bridge PID. It reports `rolled_back_verified` only after that verification. If any rollback step or health check fails, it reports `rollback_failed`. Do not treat a restart request alone as a verified rollback.

The process check needs systemd and readable `/proc/<pid>/{cgroup,cmdline,stat}`. It fails closed if these observations are missing. It has been exercised with offline fixtures, not on a production target host.

In hardened systemd environments (e.g. running under a dedicated service user like `hapi-console` with `ProtectSystem=strict` and `ReadWritePaths=/var/lib/hapi-console`), the service can read the selector but cannot change `/opt`; an independent root maintenance channel performs selector writes. The `/opt` and releases directories are root-owned and on the same filesystem. The fixed registered entrypoint remains in use, avoiding direct symlink switching.

## One-time migration

The paths and commit hashes below are illustrative examples to pass explicitly to the installer, not hardcoded defaults. Do not edit the tunnel profile, start a second tunnel, or alter HAPI/Runner.

1. Verify the staged initial release at `/opt/hapi-copilot/releases/<initial-sha>` and inspect its `server/index.mjs`. Verify `/opt/hapi-copilot` and each ancestor are root owned and not group/world writable. Verify that the current registered entrypoint is the expected forwarder to the initial release.
2. The operator must identify the preserved original file and independently verify its SHA256. The installer requires the path and digest explicitly and never edits or deletes that original backup:
   - Example backup path: `/opt/hapi-copilot/release-backups/index.mjs.original.backup`
   - Example SHA256: `<expected-original-sha256>`
3. Stage this reviewed `deploy/` directory on the deployment host with root ownership, directories mode `0755` and source files mode `0644`. Preview the migration (root is not required for this read-only command):

        node <staged>/activate-release.mjs --root /opt/hapi-copilot --owner-uid 0 --install-bootstrap --registered-entrypoint releases/<registered-sha>/server/index.mjs --initial-release <initial-sha> --original-backup /opt/hapi-copilot/release-backups/index.mjs.original.backup --original-backup-sha256 <expected-original-sha256>

   Review the target and generated backup path from the dry-run output.
4. In the maintenance window, run the identical command with `--apply` as root. It validates the supplied original backup hash, snapshots the currently registered forwarder to a new root-owned backup, initializes and validates `current-release` before replacing the registered entrypoint atomically, then restarts only the service and checks active state, stable process identities and Bridge PID change. A failed migration restores the saved forwarder and performs the same verified rollback gate.
5. Require `installed_verified` in the success output. On failure, read the JSON status: `rolled_back_verified` means the forwarder and service health were verified; `rollback_failed` requires manual recovery through your standard maintenance channel. Then check MCP handshake and `get_integration_status` through the existing connection.

`get_integration_status` reports a revision inferred from the release directory name; it is not cryptographically attested and does not prove which source bytes are running by itself. Use it only as corroborating build metadata after the release manager has verified the active service and a changed Bridge PID.

## Future switch and rollback

Stage a new immutable, root-owned release directory named by its exact commit SHA. Preview as an unprivileged user if desired, specifying the expected owner UID:

        node /opt/hapi-copilot/releases/<manager-sha>/deploy/activate-release.mjs --root /opt/hapi-copilot --owner-uid 0 --release <40-hex-sha>

After reviewing the prior and target SHA, explicitly apply as root:

        node /opt/hapi-copilot/releases/<manager-sha>/deploy/activate-release.mjs --root /opt/hapi-copilot --release <40-hex-sha> --apply

Capture the JSON result's `from` field. Rollback by applying that SHA through the same manager:

        node /opt/hapi-copilot/releases/<manager-sha>/deploy/activate-release.mjs --root /opt/hapi-copilot --release <previous-40-hex-sha> --apply

An identical SHA is an idempotent no-op. Do not delete old releases or backups. A successful rollback must report `switched_verified`; an automatic rollback following failed activation reports `rolled_back_verified` only after its health gate passes.

## Offline coverage and limits

`tests/deploy-release.test.mjs` covers Node ESM direct launch, shell-character paths, malformed hashes and traversal, symlink and permission rejection, unprivileged dry-run, exact cgroup process identification, active-state checks, PID change and stability, selector ordering during migration, preserved original backup, successful switch and both verified/failed rollback outcomes. Tests use fake service control and temporary files; they do not run systemd or make remote writes. Real-host acceptance remains required.

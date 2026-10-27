# Third-party notes

No official HAPI or WebCodex implementation code is assumed to be bundled or forked here. Their protocol contracts and architecture were referenced. This note is not a completed legal audit.

- HAPI: https://github.com/tiann/hapi (upstream AGPL-3.0). Installed and upgraded separately. Copying upstream implementation/UI in the future requires a separate license review.
- WebCodex: https://github.com/yyjeqhc/webcodex (upstream Apache-2.0). Architecture reference only; no source copied.
- Node.js: runtime dependency, distributed separately under its own license. No npm runtime packages are required.
- `server/legacy/`, `ui/legacy-dashboard.html`, `tests/legacy/`: reported to be retained from a HAPI Agent Console v0.3.0 package previously generated for the user. Their provenance and licensing have not been independently audited and must be verified; no formal license compliance is asserted here.


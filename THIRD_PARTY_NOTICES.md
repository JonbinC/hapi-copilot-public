# Third-party notes

This repository does not bundle or fork official HAPI or WebCodex implementation code. Their protocol contracts and architecture were referenced.

- HAPI: https://github.com/tiann/hapi (upstream AGPL-3.0). Installed and upgraded separately. Copying upstream implementation/UI in the future requires a separate license review.
- WebCodex: https://github.com/yyjeqhc/webcodex (upstream Apache-2.0). Architecture reference only; no source copied.
- Node.js: runtime dependency, distributed separately under its own license. No npm runtime packages are required.
- `server/legacy/`, `ui/legacy-dashboard.html`, `tests/legacy/`: retained from the HAPI Agent Console v0.3.0 package previously generated for the user. They are compatibility source, not upstream HAPI code.


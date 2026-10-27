#!/bin/sh
set -eu
umask 077
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# HAPI credential is read directly by the Node process from the protected file.
# Do not inject tunnel control-plane keys into the bridge environment.
unset CONTROL_PLANE_API_KEY OPENAI_API_KEY OPENAI_ADMIN_KEY
exec node "$ROOT/server/index.mjs"


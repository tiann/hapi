#!/usr/bin/env bash
# Audit web/dist vs merged driver web/src (no build). Exit 1 if stale.
set -euo pipefail

PRIMARY="${HAPI_PRIMARY:-$HOME/coding/hapi}"
DRIVER="${HAPI_DRIVER:-$HOME/coding/hapi/driver}"
BUN="${BUN:-$HOME/.bun/bin/bun}"

exec "$BUN" run "$PRIMARY/scripts/tooling/verify-soup-web-dist.mjs" "$DRIVER"

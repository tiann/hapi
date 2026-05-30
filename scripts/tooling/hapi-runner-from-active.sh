#!/usr/bin/env bash
# systemd ExecStart helper: run hapi runner from whatever tree hapi-active points at.
set -euo pipefail

BUN="${BUN:-$HOME/.bun/bin/bun}"
ACTIVE_LINK="${HAPI_ACTIVE_LINK:-$HOME/coding/hapi-active}"
ACTIVE="$(readlink -f "$ACTIVE_LINK")"
CLI_DIR="$ACTIVE/cli"
CODING_ROOT="${HAPI_CODING_ROOT:-$HOME/coding}"

if [[ ! -f "$CLI_DIR/src/index.ts" ]]; then
    echo "ERROR: active tree missing cli: $CLI_DIR" >&2
    exit 1
fi

if [[ ! -d "$ACTIVE/node_modules" ]]; then
    echo "ERROR: active tree missing node_modules — run: cd $ACTIVE && bun install" >&2
    exit 1
fi

export HAPI_API_URL="${HAPI_API_URL:-http://127.0.0.1:3006}"
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin"

cd "$CLI_DIR"
exec "$BUN" run src/index.ts runner start-sync \
    --workspace-root "$CODING_ROOT" \
    --workspace-root "$ACTIVE"

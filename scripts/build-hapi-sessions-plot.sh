#!/usr/bin/env bash
# Build the native AGENTS chart renderer (optional; auto-built by hapi-sessions-health.sh when cc exists).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="$ROOT/hapi-sessions-plot.c"
OUT="${HAPI_SESSIONS_PLOT:-$ROOT/hapi-sessions-plot}"
cc -O2 -Wall -Wextra -o "$OUT" "$SRC"
echo "built: $OUT"

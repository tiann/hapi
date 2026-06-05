#!/usr/bin/env bash
# Roll back ~/coding/hapi-driver/web/dist to the previous build.
#
# Pairs with hapi-driver-rebuild's atomic swap: each --build-web run
# preserves the outgoing bundle as web/dist.prev. This script promotes
# that prev bundle back to live without re-running vite, so a regression
# spotted in :3006 can be reverted in well under a second.
#
# Hub serves web/dist from disk; no service restart is needed and live
# agent sessions are not interrupted. Browsers see the rollback on next
# asset fetch (hard-reload to force).
#
# Usage:
#   hapi-driver-rollback-web              # promote dist.prev back to dist
#   hapi-driver-rollback-web --keep-broken # rename current dist to dist.broken-<ts> instead of deleting
set -euo pipefail

DRIVER="${HAPI_DRIVER:-$HOME/coding/hapi/driver}"
WEB="$DRIVER/web"
DIST="$WEB/dist"
PREV="$WEB/dist.prev"

KEEP_BROKEN=1
while [[ $# -gt 0 ]]; do
    case "$1" in
        --discard-broken) KEEP_BROKEN=0; shift ;;
        --keep-broken) KEEP_BROKEN=1; shift ;;
        -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
done

if [[ ! -d "$WEB" ]]; then
    echo "ERROR: driver web dir not found: $WEB" >&2
    exit 1
fi

if [[ ! -d "$PREV" ]]; then
    echo "ERROR: no previous bundle to roll back to ($PREV missing)" >&2
    echo "       Atomic swap only keeps the most recent prior build." >&2
    exit 1
fi

if [[ ! -f "$PREV/index.html" ]]; then
    echo "ERROR: $PREV exists but has no index.html; refusing to swap" >&2
    exit 1
fi

ts="$(date -u +%Y%m%dT%H%M%SZ)"
broken="$WEB/dist.broken-$ts"

if [[ -d "$DIST" ]] || [[ -L "$DIST" ]]; then
    mv "$DIST" "$broken"
fi
mv "$PREV" "$DIST"

if [[ "$KEEP_BROKEN" -eq 0 ]]; then
    rm -rf "$broken"
    echo "Rolled back: $DIST (broken bundle discarded)"
else
    echo "Rolled back: $DIST"
    echo "Replaced bundle saved at: $broken (rm when verified)"
fi
echo "Hub serves from disk on :3006 — no restart needed. Hard-reload the browser to pick up."

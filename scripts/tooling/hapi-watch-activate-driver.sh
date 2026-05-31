#!/usr/bin/env bash
# Poll session health until no WORKING agents, then swing hapi-active to daily driver.
#
# Usage:
#   hapi-watch-activate-driver              # foreground, 30s interval
#   hapi-watch-activate-driver --once       # exit 0 if activated, 2 if still working
#   hapi-watch-activate-driver --interval 15
#
set -euo pipefail

PRIMARY="${HAPI_PRIMARY:-$HOME/coding/hapi}"
HEALTH="${HAPI_SESSIONS_HEALTH:-$HOME/coding/server-setup/scripts/hapi/hapi-sessions-health.sh}"
INTERVAL="${HAPI_WATCH_INTERVAL:-30}"
ONCE=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --once) ONCE=1; shift ;;
        --interval) INTERVAL="$2"; shift 2 ;;
        -h|--help)
            sed -n '2,10p' "$0"
            exit 0
            ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
done

if [[ ! -x "$HEALTH" ]]; then
    echo "ERROR: missing $HEALTH" >&2
    exit 1
fi

count_working() {
    "$HEALTH" --json 2>/dev/null | jq '[.sessions[]? | select(.status == "WORKING")] | length'
}

working="$(count_working)"
echo "hapi-watch-activate-driver: WORKING=${working} (poll every ${INTERVAL}s)"

if [[ "$working" -eq 0 ]]; then
    echo "No WORKING sessions — activating daily driver..."
    export HAPI_STACK_SWITCH_YES=1
    exec hapi-use-driver
fi

if [[ "$ONCE" -eq 1 ]]; then
    echo "Still ${working} WORKING session(s) — not activating" >&2
    exit 2
fi

while true; do
    sleep "$INTERVAL"
    working="$(count_working)"
    ts="$(date '+%Y-%m-%d %H:%M:%S')"
    if [[ "$working" -eq 0 ]]; then
        echo "$ts WORKING=0 — activating daily driver..."
        export HAPI_STACK_SWITCH_YES=1
        exec hapi-use-driver
    fi
    echo "$ts WORKING=${working} — waiting"
done

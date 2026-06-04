#!/usr/bin/env bash
# Wait until no WORKING agent sessions, then swing hapi-active and restart hub + runner.
#
# Usage:
#   hapi-patient-stack-restart <worktree-path>
#   hapi-patient-stack-restart ~/coding/hapi-driver
#
# Options:
#   --interval SEC   poll interval (default: HAPI_WATCH_INTERVAL or 30)
#   --timeout SEC    fail if still WORKING after SEC (default: 0 = no limit)
#   --once           exit 2 if any WORKING session (no wait, no restart)
#
# Non-interactive restart requires HAPI_STACK_SWITCH_YES=1 (same as hapi-use-worktree).
#
set -euo pipefail

PRIMARY="${HAPI_PRIMARY:-$HOME/coding/hapi}"
HEALTH="${HAPI_SESSIONS_HEALTH:-$PRIMARY/scripts/hapi-sessions-health.sh}"
INTERVAL="${HAPI_WATCH_INTERVAL:-30}"
TIMEOUT=0
ONCE=0
WORKTREE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --interval) INTERVAL="$2"; shift 2 ;;
        --timeout) TIMEOUT="$2"; shift 2 ;;
        --once) ONCE=1; shift ;;
        -h|--help)
            sed -n '2,16p' "$0"
            exit 0
            ;;
        -*) echo "Unknown option: $1" >&2; exit 2 ;;
        *)
            if [[ -z "$WORKTREE" ]]; then
                WORKTREE="$1"
            else
                echo "Unexpected argument: $1" >&2
                exit 2
            fi
            shift
            ;;
    esac
done

if [[ -z "$WORKTREE" ]]; then
    echo "Usage: hapi-patient-stack-restart <worktree-path>" >&2
    exit 2
fi

WORKTREE="$(realpath "$WORKTREE")"

if [[ ! -x "$HEALTH" ]]; then
    echo "ERROR: missing $HEALTH" >&2
    exit 1
fi

count_working() {
    "$HEALTH" --json 2>/dev/null | jq '[.sessions[]? | select(.status == "WORKING")] | length'
}

working="$(count_working)"
echo "hapi-patient-stack-restart: WORKING=${working} target=${WORKTREE} (poll every ${INTERVAL}s)"

if [[ "$ONCE" -eq 1 && "$working" -gt 0 ]]; then
    echo "Still ${working} WORKING session(s) — not restarting" >&2
    exit 2
fi

started_at=$SECONDS
while [[ "$working" -gt 0 ]]; do
    if [[ "$ONCE" -eq 1 ]]; then
        exit 2
    fi
    if [[ "$TIMEOUT" -gt 0 && $((SECONDS - started_at)) -ge "$TIMEOUT" ]]; then
        echo "ERROR: timed out after ${TIMEOUT}s with WORKING=${working}" >&2
        exit 1
    fi
    ts="$(date '+%Y-%m-%d %H:%M:%S')"
    echo "$ts WORKING=${working} — waiting for agents to finish"
    sleep "$INTERVAL"
    working="$(count_working)"
done

echo "WORKING=0 — restarting hub + runner from ${WORKTREE}"
export HAPI_STACK_SWITCH_YES=1
exec hapi-use-worktree "$WORKTREE"

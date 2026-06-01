#!/usr/bin/env bash
# hapi-restart-hub [--impatient] [--no-runner]
#
# Patient restart of hapi-hub.service (and hapi-runner.service unless
# --no-runner). Does NOT change hapi-active, does NOT touch the DB, does
# NOT rebuild the driver. Use this when you need to bounce the hub
# (env change, hung process, stuck websocket) but stay on the current
# stack.
#
# Why this exists
#   Raw `sudo systemctl restart hapi-hub.service` yanks the hub
#   regardless of who's mid-turn. That has been the dominant interruption
#   pattern. This wrapper polls WORKING sessions, waits up to
#   HAPI_PATIENT_TIMEOUT seconds (default 600s = 10 min), then restarts.
#
# Bypass
#   --impatient            restart immediately, kill live sessions
#   HAPI_IMPATIENT=1       same, via env (for scripts / watchdogs)
#
# Coordination
#   Takes the same "switch" flock as hapi-use-worktree so a stack switch
#   and a hub bounce don't race. Exits 75 if another switch is in flight.
#   Inspect: hapi-driver-status

set -euo pipefail

IMPATIENT=0
RUNNER=1

while [[ $# -gt 0 ]]; do
    case "$1" in
        --impatient) IMPATIENT=1; shift ;;
        --no-runner) RUNNER=0; shift ;;
        -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
        *) echo "Unknown flag: $1" >&2; exit 2 ;;
    esac
done
[[ "${HAPI_IMPATIENT:-}" == "1" ]] && IMPATIENT=1

PRIMARY="${HAPI_PRIMARY:-$HOME/coding/hapi}"
PATIENT_TIMEOUT="${HAPI_PATIENT_TIMEOUT:-600}"
PATIENT_INTERVAL="${HAPI_PATIENT_INTERVAL:-30}"
HEALTH_SCRIPT="${HAPI_SESSIONS_HEALTH:-$PRIMARY/scripts/hapi-sessions-health.sh}"

SCRIPT_DIR="$(dirname "$(readlink -f "$0")")"
# shellcheck source=lib/driver-status.sh
source "$SCRIPT_DIR/lib/driver-status.sh"

if [[ "${HAPI_SKIP_DRIVER_LOCK:-}" != "1" ]]; then
    driver_status_init
    driver_status_acquire switch
    ACTIVE_NOW="$(readlink -f "$HOME/coding/hapi-active" 2>/dev/null || echo unknown)"
    driver_status_begin switch "$ACTIVE_NOW"
    driver_status_set switch "from=$ACTIVE_NOW" "to=$ACTIVE_NOW"
    trap 'driver_status_end switch "$?"' EXIT
fi

patient_drain() {
    [[ "$IMPATIENT" -eq 1 ]] && { echo "patient: skipped (--impatient)"; return 0; }
    if [[ ! -x "$HEALTH_SCRIPT" ]]; then
        echo "patient: WARN $HEALTH_SCRIPT not executable -- skipping drain" >&2
        return 0
    fi
    local working start elapsed
    working="$("$HEALTH_SCRIPT" --json 2>/dev/null | jq -r '[.sessions[]? | select(.status == "WORKING")] | length' 2>/dev/null || echo 0)"
    [[ "$working" -eq 0 ]] && { echo "patient: WORKING=0, no drain needed"; return 0; }
    echo "patient: WORKING=$working sessions in flight; waiting up to ${PATIENT_TIMEOUT}s (poll ${PATIENT_INTERVAL}s)"
    echo "patient: bypass with --impatient or HAPI_IMPATIENT=1"
    start=$SECONDS
    while [[ "$working" -gt 0 ]]; do
        elapsed=$((SECONDS - start))
        if [[ "$PATIENT_TIMEOUT" -gt 0 && "$elapsed" -ge "$PATIENT_TIMEOUT" ]]; then
            echo "patient: TIMEOUT after ${elapsed}s with WORKING=$working -- proceeding anyway" >&2
            "$HEALTH_SCRIPT" --json 2>/dev/null | jq -r '.sessions[]? | select(.status == "WORKING") | "  still WORKING: id=\(.id // "?") tag=\(.tag // "?")"' >&2 || true
            return 0
        fi
        echo "  $(date '+%H:%M:%S')  WORKING=$working  elapsed=${elapsed}s  budget=${PATIENT_TIMEOUT}s"
        sleep "$PATIENT_INTERVAL"
        working="$("$HEALTH_SCRIPT" --json 2>/dev/null | jq -r '[.sessions[]? | select(.status == "WORKING")] | length' 2>/dev/null || echo 0)"
    done
    echo "patient: WORKING=0 after $((SECONDS - start))s -- proceeding"
}

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [[ "$IMPATIENT" -eq 1 ]]; then
    echo "  HUB RESTART (IMPATIENT) — kills live agent sessions NOW"
else
    echo "  HUB RESTART — patient drain, then restart"
fi
echo "  Stack:    $(readlink -f "$HOME/coding/hapi-active" 2>/dev/null || echo unknown)"
echo "  Services: hapi-hub.service$([[ "$RUNNER" -eq 1 ]] && echo ' + hapi-runner.service')"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

patient_drain

if [[ "$RUNNER" -eq 1 ]]; then
    echo "Restarting hapi-hub + hapi-runner ..."
    sudo systemctl restart hapi-hub.service hapi-runner.service
else
    echo "Restarting hapi-hub ..."
    sudo systemctl restart hapi-hub.service
fi

echo ""
echo "  hub:    $(systemctl is-active hapi-hub.service)"
[[ "$RUNNER" -eq 1 ]] && echo "  runner: $(systemctl is-active hapi-runner.service)"

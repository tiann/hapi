#!/usr/bin/env bash
# hapi-restart-hub [--impatient] [--no-runner] [--patient-include-self]
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
# Self-exempt (auto)
#   When invoked from inside a Cursor agent session (CURSOR_AGENT=1), the
#   caller is itself a WORKING session and patient-mode would deadlock
#   forever waiting on its own tool call. We subtract 1 from the WORKING
#   count to account for the caller. If WORKING==1, skip drain entirely.
#   Disable: --patient-include-self  /  HAPI_RESTART_INCLUDE_SELF=1
#
# Bypass
#   --impatient            restart immediately, kill live sessions
#   HAPI_IMPATIENT=1       same, via env (for scripts / watchdogs)
#
# --impatient is operator-only since 2026-06-13. Refuses if the caller
# has no controlling terminal and HAPI_IMPATIENT_BATCH=1 is not set.
# Cron jobs / watchdog scripts that legitimately need impatient restart
# from a non-tty context must set HAPI_IMPATIENT_BATCH=1 explicitly to
# acknowledge they are killing live sessions on purpose. The default
# path (just --impatient or HAPI_IMPATIENT=1 from an agent shell)
# fails closed because that is the failure mode that took out 8
# sessions on 2026-06-13 16:52 - operator's backup agent verified a
# wrapper fix by running --impatient from its agent shell, called it
# 'a brief test', killed unrelated work in flight.
#
# Coordination
#   Takes the same "switch" flock as hapi-use-worktree so a stack switch
#   and a hub bounce don't race. Exits 75 if another switch is in flight.
#   Inspect: hapi-driver-status

set -euo pipefail

IMPATIENT=0
RUNNER=1
INCLUDE_SELF=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --impatient) IMPATIENT=1; shift ;;
        --no-runner) RUNNER=0; shift ;;
        --patient-include-self) INCLUDE_SELF=1; shift ;;
        -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
        *) echo "Unknown flag: $1" >&2; exit 2 ;;
    esac
done
[[ "${HAPI_IMPATIENT:-}" == "1" ]] && IMPATIENT=1
[[ "${HAPI_RESTART_INCLUDE_SELF:-}" == "1" ]] && INCLUDE_SELF=1

# TTY check for --impatient. Operator at SSH/tmux/console: parent has
# tty_nr != 0. Agent tool-call shell: tty_nr=0. Allow when caller has
# tty OR HAPI_IMPATIENT_BATCH=1 is explicitly set (cron/watchdog).
_caller_has_tty() {
    local _stat _tty_nr
    [ -r "/proc/$PPID/stat" ] || return 1
    _stat="$(cat "/proc/$PPID/stat" 2>/dev/null)" || return 1
    _tty_nr=$(printf '%s' "$_stat" | sed 's/.*) //' | awk '{print $5}')
    [ -n "$_tty_nr" ] && [ "$_tty_nr" != "0" ]
}
if [[ "$IMPATIENT" -eq 1 ]] && ! _caller_has_tty && [[ "${HAPI_IMPATIENT_BATCH:-}" != "1" ]]; then
    cat >&2 <<EOF

REFUSE: --impatient (or HAPI_IMPATIENT=1) requires a controlling terminal.

This script kills live agent sessions when --impatient is set. The
caller has no controlling tty - which means this is almost certainly
an agent tool-call shell, where 'just verifying' or 'just a quick
test' has unrelated work in flight as collateral damage.

Did you actually mean one of these?

  hapi-restart-hub                                  patient drain
                                                    (default; waits
                                                    for in-flight
                                                    sessions to
                                                    finish, up to
                                                    10 min)

  sudo systemctl restart --dry-run hapi-hub.service  verify the wrapper
                                                    chain without
                                                    actually restarting

  hapi-driver-status                                see who is in
                                                    flight first

If you are an operator at a real terminal: run from there, the gate
will allow it.

If you are a cron job or watchdog that legitimately needs impatient
restart from a non-tty context: set HAPI_IMPATIENT_BATCH=1 to
acknowledge that you are killing live sessions on purpose. That env
var is documented as the explicit non-tty opt-in.

This refusal landed because on 2026-06-13 16:52 BST an operator's
backup agent (me) ran --impatient from its tool-call shell to verify
a wrapper fix, killed 8 unrelated in-flight sessions, called it a
brief test. Same failure shape as the morning's mermaid-feedback
violation, different costume.

EOF
    exit 1
fi

# Auto-detect: are we being called from inside a Cursor agent session?
# If so, the caller is one of the WORKING sessions and patient-mode would
# wait forever on itself unless we exempt it from the count.
SELF_EXEMPT=0
if [[ "$INCLUDE_SELF" -ne 1 ]] && [[ "${CURSOR_AGENT:-}" == "1" || "${CURSOR_INVOKED_AS:-}" == "agent" ]]; then
    SELF_EXEMPT=1
fi

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
    ACTIVE_NOW="$(readlink -f "$HOME/coding/hapi/active" 2>/dev/null || echo unknown)"
    driver_status_begin switch "$ACTIVE_NOW"
    driver_status_set switch "from=$ACTIVE_NOW" "to=$ACTIVE_NOW"
    trap 'driver_status_end switch "$?"' EXIT
fi

# Subtract 1 from $1 when SELF_EXEMPT is set, but never go below 0.
adjust_for_self() {
    local raw="$1"
    if [[ "$SELF_EXEMPT" -eq 1 && "$raw" -gt 0 ]]; then
        echo $((raw - 1))
    else
        echo "$raw"
    fi
}

patient_drain() {
    [[ "$IMPATIENT" -eq 1 ]] && { echo "patient: skipped (--impatient)"; return 0; }
    if [[ ! -x "$HEALTH_SCRIPT" ]]; then
        echo "patient: WARN $HEALTH_SCRIPT not executable -- skipping drain" >&2
        return 0
    fi
    local raw working start elapsed
    raw="$("$HEALTH_SCRIPT" --json 2>/dev/null | jq -r '[.sessions[]? | select(.status == "WORKING")] | length' 2>/dev/null || echo 0)"
    working="$(adjust_for_self "$raw")"
    if [[ "$SELF_EXEMPT" -eq 1 ]]; then
        echo "patient: caller appears to be a Cursor agent (CURSOR_AGENT=$CURSOR_AGENT); subtracting 1 from WORKING count to avoid self-deadlock. Override: --patient-include-self / HAPI_RESTART_INCLUDE_SELF=1"
        echo "patient: WORKING raw=$raw effective=$working"
    fi
    [[ "$working" -eq 0 ]] && { echo "patient: effective WORKING=0, no drain needed"; return 0; }
    echo "patient: WORKING=$working other session(s) in flight; waiting up to ${PATIENT_TIMEOUT}s (poll ${PATIENT_INTERVAL}s)"
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
        raw="$("$HEALTH_SCRIPT" --json 2>/dev/null | jq -r '[.sessions[]? | select(.status == "WORKING")] | length' 2>/dev/null || echo 0)"
        working="$(adjust_for_self "$raw")"
    done
    echo "patient: effective WORKING=0 after $((SECONDS - start))s -- proceeding"
}

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [[ "$IMPATIENT" -eq 1 ]]; then
    echo "  HUB RESTART (IMPATIENT) — kills live agent sessions NOW"
else
    echo "  HUB RESTART — patient drain, then restart"
fi
echo "  Stack:    $(readlink -f "$HOME/coding/hapi/active" 2>/dev/null || echo unknown)"
echo "  Services: hapi-hub.service$([[ "$RUNNER" -eq 1 ]] && echo ' + hapi-runner.service')"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

patient_drain

# Supported-wrapper bypass: by this point patient_drain has already validated
# the safety contract (effective WORKING=0, or operator chose --impatient
# consciously). The override env is set ON THE SUDO LINE so the systemctl
# wrapper at /usr/local/sbin/systemctl trusts the call. Bare-sudo agent
# invocations that skip this script still get blocked because they never
# set the env.
if [[ "$RUNNER" -eq 1 ]]; then
    echo "Restarting hapi-hub + hapi-runner ..."
    sudo HAPI_OPERATOR_SYSTEMCTL_OVERRIDE=1 systemctl restart hapi-hub.service hapi-runner.service
else
    echo "Restarting hapi-hub ..."
    sudo HAPI_OPERATOR_SYSTEMCTL_OVERRIDE=1 systemctl restart hapi-hub.service
fi

echo ""
echo "  hub:    $(systemctl is-active hapi-hub.service)"
[[ "$RUNNER" -eq 1 ]] && echo "  runner: $(systemctl is-active hapi-runner.service)"

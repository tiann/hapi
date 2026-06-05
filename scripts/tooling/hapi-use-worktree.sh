#!/usr/bin/env bash
# hapi-use-worktree <path-to-worktree> [--impatient]
# Swings hapi-active and restarts hub + runner together from that tree.
#
# Patient by default: waits for WORKING sessions to finish (poll every 30s)
# before tearing the hub down. Times out after HAPI_PATIENT_TIMEOUT seconds
# (default 600 = 10 min) and logs who's still WORKING before proceeding.
#
# Bypass:
#   --impatient            yank the hub immediately, kill live sessions
#   HAPI_IMPATIENT=1       same, via env (for non-interactive callers)

set -euo pipefail

IMPATIENT=0
WORKTREE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --impatient) IMPATIENT=1; shift ;;
        -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
        -*) echo "Unknown flag: $1" >&2; exit 2 ;;
        *)
            if [[ -z "$WORKTREE" ]]; then WORKTREE="$1"; shift
            else echo "Unexpected arg: $1" >&2; exit 2; fi
            ;;
    esac
done

[[ -n "$WORKTREE" ]] || { echo "Usage: hapi-use-worktree <path-to-worktree> [--impatient]" >&2; exit 2; }
[[ "${HAPI_IMPATIENT:-}" == "1" ]] && IMPATIENT=1

WORKTREE="$(realpath "$WORKTREE")"
ACTIVE_LINK="${HAPI_ACTIVE_LINK:-$HOME/coding/hapi/active}"
HUB_ENV="${HAPI_HUB_ENV:-$HOME/.hapi/hub.env}"
BUN="${BUN:-$HOME/.bun/bin/bun}"
DRIVER="${HAPI_DRIVER:-$HOME/coding/hapi/driver}"
PATIENT_TIMEOUT="${HAPI_PATIENT_TIMEOUT:-600}"
PATIENT_INTERVAL="${HAPI_PATIENT_INTERVAL:-30}"
SCRIPT_DIR="$(dirname "$(readlink -f "$0")")"
HEALTH_SCRIPT="${HAPI_SESSIONS_HEALTH:-$SCRIPT_DIR/../hapi-sessions-health.sh}"

if [[ ! -d "$WORKTREE/hub" ]] || [[ ! -d "$WORKTREE/cli" ]]; then
    echo "ERROR: $WORKTREE must be a full HAPI worktree (hub/ + cli/)" >&2
    exit 1
fi

# Patient drain: poll WORKING session count and wait until it reaches 0 (or
# we hit the timeout). The drain happens AFTER lock acquire (below) but
# BEFORE the systemctl stop, so a second patient caller is held by flock at
# the gate rather than draining in parallel.
patient_drain() {
    [[ "$IMPATIENT" -eq 1 ]] && { echo "patient: skipped (--impatient)"; return 0; }
    if [[ ! -x "$HEALTH_SCRIPT" ]]; then
        echo "patient: WARN $HEALTH_SCRIPT not executable -- skipping drain" >&2
        return 0
    fi
    local working start now elapsed
    working="$("$HEALTH_SCRIPT" --json 2>/dev/null | jq -r '[.sessions[]? | select(.status == "WORKING")] | length' 2>/dev/null || echo 0)"
    [[ "$working" -eq 0 ]] && { echo "patient: WORKING=0, no drain needed"; return 0; }
    echo "patient: WORKING=$working sessions in flight; waiting up to ${PATIENT_TIMEOUT}s (poll ${PATIENT_INTERVAL}s)"
    echo "patient: bypass next time with --impatient or HAPI_IMPATIENT=1"
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

# Concurrency guard + status reporting (see lib/driver-status.sh).
# Bypassable: HAPI_SKIP_DRIVER_LOCK=1 (testing only).
LIB_DIR="$(dirname "$(readlink -f "$0")")/lib"
# shellcheck source=lib/driver-status.sh
source "$LIB_DIR/driver-status.sh"
if [[ "${HAPI_SKIP_DRIVER_LOCK:-}" != "1" ]]; then
    driver_status_init
    driver_status_acquire switch
    PREV_ACTIVE="$(readlink -f "$ACTIVE_LINK" 2>/dev/null || echo unknown)"
    driver_status_begin switch "$WORKTREE"
    driver_status_set switch "from=$PREV_ACTIVE" "to=$WORKTREE"
    trap 'driver_status_end switch "$?"' EXIT
fi

if [[ ! -e "$WORKTREE/hub/.env" ]]; then
    echo "Linking $HUB_ENV → $WORKTREE/hub/.env"
    ln -sfn "$HUB_ENV" "$WORKTREE/hub/.env"
fi

if [[ ! -d "$WORKTREE/node_modules" ]]; then
    echo "Installing dependencies in $WORKTREE ..."
    (cd "$WORKTREE" && "$BUN" install)
fi

if [[ ! -f "$WORKTREE/web/dist/index.html" ]]; then
    echo "WARNING: $WORKTREE/web/dist/index.html missing — hub UI may be stale." >&2
    if [[ -t 0 ]]; then
        read -rp "Build web now? [y/N] " yn
        if [[ "${yn,,}" == "y" ]]; then
            (cd "$WORKTREE/web" && "$BUN" run build)
        fi
    fi
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [[ "$IMPATIENT" -eq 1 ]]; then
    echo "  STACK SWITCH (IMPATIENT) — kills live agent sessions NOW"
else
    echo "  STACK SWITCH — patient drain, then restart hub + runner"
fi
echo "  Target:   $WORKTREE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [[ -t 0 ]]; then
    read -rp "Proceed? [y/N] " confirm
    [[ "${confirm,,}" == "y" ]] || { echo "Aborted."; exit 1; }
elif [[ "${HAPI_STACK_SWITCH_YES:-}" != "1" ]]; then
    echo "Refusing stack switch without TTY. Export HAPI_STACK_SWITCH_YES=1 to confirm." >&2
    exit 1
fi

# Drain BEFORE we touch the symlink or stop the hub. We're inside the switch
# lock; second concurrent caller is blocked at the gate, not racing the drain.
patient_drain

echo "Pointing hapi-active → $WORKTREE"
ln -sfn "$WORKTREE" "$ACTIVE_LINK"

# DB jiu-jitsu: ensure ~/.hapi/hapi.db schema matches the target tree before the
# hub starts. Skip with HAPI_SKIP_DB_PREP=1 (not recommended).
DB_PREP="$(dirname "$(readlink -f "$0")")/hapi-driver-db-prep.sh"
if [[ "${HAPI_SKIP_DB_PREP:-}" != "1" && -x "$DB_PREP" ]]; then
    echo ""
    echo "Stopping hub to prep DB ..."
    sudo systemctl stop hapi-hub.service || true
    if ! "$DB_PREP" "$WORKTREE"; then
        echo "ERROR: DB prep failed; refusing to restart hub on incompatible schema" >&2
        echo "       Live DB and backup are untouched if downgrade aborted." >&2
        echo "       Restart hub manually after resolving: sudo systemctl start hapi-hub.service" >&2
        exit 1
    fi
    echo ""
    echo "Starting hub + restarting runner ..."
    sudo systemctl start hapi-hub.service
    sudo systemctl restart hapi-runner.service
else
    if [[ "${HAPI_SKIP_DB_PREP:-}" == "1" ]]; then
        echo "WARN: HAPI_SKIP_DB_PREP=1 -- skipping DB schema check + backup" >&2
    else
        echo "WARN: hapi-driver-db-prep.sh not found at $DB_PREP -- skipping" >&2
    fi
    echo "Restarting hapi-hub.service + hapi-runner.service ..."
    sudo systemctl restart hapi-hub.service hapi-runner.service
fi

echo ""
echo "Active stack:"
echo "  hapi-active → $(readlink -f "$ACTIVE_LINK")"
echo "  hub:    $(systemctl is-active hapi-hub.service)"
echo "  runner: $(systemctl is-active hapi-runner.service)"
systemctl show hapi-runner.service -p ExecStart --value | sed 's/^/  runner ExecStart: /'

if [[ "$WORKTREE" == "$(realpath "$DRIVER")" ]]; then
    echo "Daily driver active."
else
    echo "Restore daily driver: hapi-use-driver"
fi

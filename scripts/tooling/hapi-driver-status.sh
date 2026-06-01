#!/usr/bin/env bash
# hapi-driver-status -- read the driver-stack coordination state.
#
# Pretty-prints ~/.hapi/driver-status.json (written by hapi-driver-rebuild
# and hapi-use-worktree) so agents can answer:
#   - is a rebuild or switch in progress right now?
#   - if yes: by whom, since when, with what args?
#   - if no:  when did the last one finish, and what landed?
#   - what is hapi-active pointing at, and when was it last swung?
#
# Usage:
#   hapi-driver-status              # human-readable summary
#   hapi-driver-status --json       # raw JSON for scripts
#   hapi-driver-status --quiet      # exit code only: 0 idle, 75 busy, 2 stale
#   hapi-driver-status --watch      # poll every 2s (Ctrl-C to stop)
#
# Exit codes
#   0   both rebuild + switch are idle
#   75  at least one operation is running (matches lib EX_TEMPFAIL convention)
#   2   one or more pids look stale (process dead, status not reset)
#   1   status file missing or unreadable

set -euo pipefail

STATUS_FILE="${HAPI_STATUS_FILE:-$HOME/.hapi/driver-status.json}"
MODE=human

while [[ $# -gt 0 ]]; do
    case "$1" in
        --json) MODE=json; shift ;;
        --quiet|-q) MODE=quiet; shift ;;
        --watch|-w) MODE=watch; shift ;;
        -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
        *) echo "Unknown flag: $1" >&2; exit 2 ;;
    esac
done

if [[ ! -f "$STATUS_FILE" ]]; then
    echo "no driver-status file yet at $STATUS_FILE" >&2
    echo "(it appears after the first hapi-driver-rebuild or hapi-use-worktree)" >&2
    exit 1
fi
command -v jq >/dev/null 2>&1 || { echo "jq required" >&2; exit 1; }

humanize_age() {
    local ts="$1"
    [[ -z "$ts" || "$ts" == "null" ]] && { echo "(never)"; return; }
    local epoch now diff
    epoch="$(date -u -d "$ts" +%s 2>/dev/null || echo 0)"
    now="$(date -u +%s)"
    diff=$((now - epoch))
    (( diff < 0 )) && diff=0
    if   (( diff < 60   )); then echo "${diff}s ago"
    elif (( diff < 3600 )); then echo "$((diff/60))m $((diff%60))s ago"
    elif (( diff < 86400)); then echo "$((diff/3600))h $((diff%3600/60))m ago"
    else                         echo "$((diff/86400))d $((diff%86400/3600))h ago"
    fi
}

pid_alive() {
    local pid="$1"
    [[ "$pid" =~ ^[0-9]+$ ]] || return 1
    kill -0 "$pid" 2>/dev/null
}

render_op() {
    local op="$1" out
    out="$(jq -r ".${op}" "$STATUS_FILE")"
    local state pid started_at started_by completed_at exit_code args
    state="$(echo "$out" | jq -r '.state // "?"')"
    pid="$(echo "$out" | jq -r '.pid // "null"')"
    started_at="$(echo "$out" | jq -r '.started_at // "null"')"
    started_by="$(echo "$out" | jq -r '.started_by // "?"')"
    completed_at="$(echo "$out" | jq -r '.completed_at // "null"')"
    exit_code="$(echo "$out" | jq -r '.exit_code // "?"')"
    args="$(echo "$out" | jq -r '.args // [] | join(" ")')"

    local label color reset
    if [[ -t 1 ]]; then color="\033[1m"; reset="\033[0m"; else color=""; reset=""; fi
    printf '%b%-8s%b ' "$color" "$op" "$reset"

    if [[ "$state" == "running" ]]; then
        if pid_alive "$pid"; then
            printf 'RUNNING  pid=%s  by=%s  since=%s (%s)\n' \
                "$pid" "$started_by" "$started_at" "$(humanize_age "$started_at")"
            [[ "$op" == "rebuild" && -n "$args" ]] && printf '         args: %s\n' "$args"
            if [[ "$op" == "switch" ]]; then
                local from to
                from="$(echo "$out" | jq -r '.from // "?"')"
                to="$(echo "$out"   | jq -r '.to   // "?"')"
                printf '         %s -> %s\n' "$from" "$to"
            fi
            return 1
        else
            printf 'STALE    pid=%s (dead)  recorded-start=%s  by=%s\n' \
                "$pid" "$started_at" "$started_by"
            printf '         crashed without releasing status. To clear:\n'
            printf '           rm %s/locks/%s.lock\n' "${HAPI_STATE_DIR:-$HOME/.hapi}" "$op"
            printf '           (status auto-resets on next run)\n'
            return 2
        fi
    fi

    printf 'idle     last=%s (%s)  exit=%s  by=%s\n' \
        "$completed_at" "$(humanize_age "$completed_at")" "$exit_code" "$started_by"
    if [[ "$op" == "rebuild" ]]; then
        local sha subject layers
        sha="$(echo "$out"     | jq -r '.head_sha // "?"')"
        subject="$(echo "$out" | jq -r '.head_subject // "?"')"
        layers="$(echo "$out"  | jq -r '.manifest_layer_count // "?"')"
        printf '         head=%s "%s"  layers=%s\n' "$sha" "$subject" "$layers"
    elif [[ "$op" == "switch" ]]; then
        local from to
        from="$(echo "$out" | jq -r '.from // "?"')"
        to="$(echo "$out"   | jq -r '.to   // "?"')"
        printf '         last switch: %s -> %s\n' "$from" "$to"
    fi
    return 0
}

render_working() {
    local health="${HAPI_SESSIONS_HEALTH:-$HOME/coding/hapi/scripts/hapi-sessions-health.sh}"
    if [[ ! -x "$health" ]]; then
        echo "working   (health script not available)"
        return 0
    fi
    local count
    count="$("$health" --json 2>/dev/null | jq -r '[.sessions[]? | select(.status == "WORKING")] | length' 2>/dev/null || echo 0)"
    if [[ "$count" == "0" ]]; then
        echo "working   WORKING=0  (safe to restart hub without --impatient)"
    else
        echo "working   WORKING=$count  (a restart will yank these unless you wait or use hapi-restart-hub)"
        local color="" reset=""
        [[ -t 1 ]] && { color="\033[33m"; reset="\033[0m"; }
        printf '          %busage: hapi-restart-hub  (patient by default, 10min timeout)%b\n' "$color" "$reset"
    fi
}

render_human() {
    echo "=== hapi-driver-status ($STATUS_FILE) ==="
    echo ""

    local rebuild_rc=0 switch_rc=0
    render_op rebuild || rebuild_rc=$?
    echo ""
    render_op switch  || switch_rc=$?
    echo ""

    local active_target is_driver mtime
    active_target="$(jq -r '.active.target // "(no symlink)"' "$STATUS_FILE")"
    is_driver="$(jq -r '.active.is_driver // false' "$STATUS_FILE")"
    mtime="$(jq -r '.active.symlink_mtime // "null"' "$STATUS_FILE")"
    local tag="DAILY DRIVER"
    [[ "$is_driver" == "true" ]] || tag="FEATURE WORKTREE"
    echo "active    -> $active_target"
    echo "          [$tag]  last swung $mtime ($(humanize_age "$mtime"))"
    echo ""
    render_working

    # Aggregate exit code: 75 busy > 2 stale > 0 idle.
    (( rebuild_rc == 1 || switch_rc == 1 )) && return 75
    (( rebuild_rc == 2 || switch_rc == 2 )) && return 2
    return 0
}

case "$MODE" in
    json)
        cat "$STATUS_FILE"
        ;;
    quiet)
        render_human >/dev/null
        exit $?
        ;;
    watch)
        while true; do
            clear
            render_human || true
            echo ""
            echo "(refresh 2s, Ctrl-C to stop)"
            sleep 2
        done
        ;;
    human)
        render_human
        ;;
esac

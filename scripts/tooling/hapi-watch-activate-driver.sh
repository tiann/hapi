#!/usr/bin/env bash
# Poll session health until no WORKING agents (excluding this turn), then hapi-use-driver.
#
# NEVER run from inside a HAPI Cursor agent turn without --exclude-agent-session:
# this session stays WORKING until the agent exits, so WORKING never hits 0 (ouroboros).
#
# Usage:
#   hapi-watch-activate-driver                    # external shell only
#   hapi-watch-activate-driver --exclude-sid 17f4a977
#   hapi-watch-activate-driver --exclude-agent-session 6904d349-f576-489f-bcd7-972f37f3942a
#   HAPI_WATCH_EXCLUDE_AGENT_SESSION=<cursor-id> hapi-watch-activate-driver
#   hapi-watch-activate-driver --once --interval 20
#
set -euo pipefail

PRIMARY="${HAPI_PRIMARY:-$HOME/coding/hapi}"
HEALTH="${HAPI_SESSIONS_HEALTH:-$HOME/coding/server-setup/scripts/hapi/hapi-sessions-health.sh}"
INTERVAL="${HAPI_WATCH_INTERVAL:-30}"
EXCLUDE_SID="${HAPI_WATCH_EXCLUDE_SID:-}"
EXCLUDE_AGENT="${HAPI_WATCH_EXCLUDE_AGENT_SESSION:-}"
ONCE=0
FORCE_UNSAFE=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --once) ONCE=1; shift ;;
        --interval) INTERVAL="$2"; shift 2 ;;
        --exclude-sid) EXCLUDE_SID="$2"; shift 2 ;;
        --exclude-agent-session) EXCLUDE_AGENT="$2"; shift 2 ;;
        --force-unsafe) FORCE_UNSAFE=1; shift ;;
        -h|--help)
            sed -n '2,16p' "$0"
            exit 0
            ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
done

if [[ ! -x "$HEALTH" ]]; then
    echo "ERROR: missing $HEALTH" >&2
    exit 1
fi

launched_under_agent() {
    local pid="${PPID:-}"
    local depth=0
    while [[ -n "$pid" && "$pid" -gt 1 && "$depth" -lt 12 ]]; do
        local cmd
        cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
        if [[ "$cmd" == *"/agent "* ]] || [[ "$cmd" == *"cursor-agent"* ]] || [[ "$cmd" == *"cursor agent"* ]]; then
            return 0
        fi
        pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
        depth=$((depth + 1))
    done
    return 1
}

# Returns JSON array of WORKING sessions after excludes (auto-drops watch-runner procs).
filter_working_json() {
    "$HEALTH" --json 2>/dev/null | jq \
        --arg sid "$EXCLUDE_SID" \
        --arg agent "$EXCLUDE_AGENT" \
        '
        [.sessions[]?
          | select(.status == "WORKING")
          | select(
              ($sid | length) == 0
              or (
                .sid != $sid and .sid8 != $sid
                and ((.sid | startswith($sid)) | not)
                and (($sid | startswith(.sid8)) | not)
              )
            )
          | select(
              ($agent | length) == 0
              or (
                (.agentSessionId // "") as $aid
                | $aid != $agent
                and ($aid | startswith($agent) | not)
                and ($agent | startswith($aid) | not)
              )
            )
          | select(
              any(.procs[]?; .cmd | test("hapi-watch-activate-driver")) | not
            )
        ]
        '
}

count_working_filtered() {
    filter_working_json | jq 'length'
}

list_working_filtered() {
    filter_working_json | jq -r '.[] | "\(.sid8) \(.project // "?") agent=\(.agentSessionId // "-") \(.note // "")"'
}

count_working_raw() {
    "$HEALTH" --json 2>/dev/null | jq '[.sessions[]? | select(.status == "WORKING")] | length'
}

if launched_under_agent && [[ -z "$EXCLUDE_SID" && -z "$EXCLUDE_AGENT" && "$FORCE_UNSAFE" -ne 1 ]]; then
    echo "ERROR: hapi-watch-activate-driver started under a Cursor/agent parent (ouroboros risk)." >&2
    echo "  This HAPI session stays WORKING until the agent turn ends, so WORKING never reaches 0." >&2
    echo "  Fix: run from an external terminal, or pass:" >&2
    echo "    --exclude-agent-session <cursor-agent-session-id>" >&2
    echo "    --exclude-sid <hub-session-uuid-prefix>" >&2
    echo "  Emergency only: --force-unsafe (will still deadlock if only this session is WORKING)" >&2
    exit 3
fi

raw="$(count_working_raw)"
working="$(count_working_filtered)"

echo "hapi-watch-activate-driver: WORKING=${working} (raw=${raw}, poll every ${INTERVAL}s)"
if [[ -n "$EXCLUDE_SID" ]]; then
    echo "  exclude sid: $EXCLUDE_SID"
fi
if [[ -n "$EXCLUDE_AGENT" ]]; then
    echo "  exclude agent session: $EXCLUDE_AGENT"
fi
if [[ "$working" -gt 0 ]]; then
    echo "  waiting on:"
    list_working_filtered | sed 's/^/    /'
fi

if [[ "$working" -eq 0 ]]; then
    echo "No blocking WORKING sessions — activating daily driver..."
    export HAPI_STACK_SWITCH_YES=1
    exec hapi-use-driver
fi

if [[ "$ONCE" -eq 1 ]]; then
    echo "Still ${working} WORKING session(s) after excludes — not activating" >&2
    exit 2
fi

while true; do
    sleep "$INTERVAL"
    working="$(count_working_filtered)"
    ts="$(date '+%Y-%m-%d %H:%M:%S')"
    if [[ "$working" -eq 0 ]]; then
        echo "$ts WORKING=0 (after excludes) — activating daily driver..."
        export HAPI_STACK_SWITCH_YES=1
        exec hapi-use-driver
    fi
    echo "$ts WORKING=${working} (raw=$(count_working_raw)) — waiting"
done

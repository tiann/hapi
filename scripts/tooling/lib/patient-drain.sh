#!/usr/bin/env bash
# patient-drain.sh — shared WORKING-session filter for patient drain paths.
#
# hapi-watch-activate-driver excludes the spawning agent before calling
# hapi-use-driver; hapi-use-worktree must apply the same excludes during its
# own patient_drain or the switch deadlocks on the session watch already cleared.
#
# Env (either prefix works; PATIENT_* is canonical):
#   HAPI_PATIENT_EXCLUDE_SID / HAPI_WATCH_EXCLUDE_SID
#   HAPI_PATIENT_EXCLUDE_AGENT_SESSION / HAPI_WATCH_EXCLUDE_AGENT_SESSION

patient_drain_resolve_excludes() {
    PATIENT_EXCLUDE_SID="${PATIENT_EXCLUDE_SID:-${HAPI_PATIENT_EXCLUDE_SID:-${HAPI_WATCH_EXCLUDE_SID:-}}}"
    PATIENT_EXCLUDE_AGENT="${PATIENT_EXCLUDE_AGENT:-${HAPI_PATIENT_EXCLUDE_AGENT_SESSION:-${HAPI_WATCH_EXCLUDE_AGENT_SESSION:-}}}"
}

# JSON array of WORKING sessions after excludes (drops hapi-watch-activate-driver procs).
patient_drain_filter_working_json() {
    local health="${1:?health script required}"
    patient_drain_resolve_excludes
    "$health" --json 2>/dev/null | jq \
        --arg sid "$PATIENT_EXCLUDE_SID" \
        --arg agent "$PATIENT_EXCLUDE_AGENT" \
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

patient_drain_count_working_raw() {
    local health="${1:?health script required}"
    "$health" --json 2>/dev/null | jq '[.sessions[]? | select(.status == "WORKING")] | length'
}

patient_drain_count_working_filtered() {
    local health="${1:?health script required}"
    patient_drain_filter_working_json "$health" | jq 'length'
}

patient_drain_list_working_filtered() {
    local health="${1:?health script required}"
    patient_drain_filter_working_json "$health" | jq -r '.[] | "\(.sid8) \(.project // "?") agent=\(.agentSessionId // "-") \(.note // "")"'
}

# Subtract 1 when caller is a Cursor agent turn (hapi-restart-hub pattern).
patient_drain_adjust_for_self() {
    local raw="$1"
    if [[ "${PATIENT_SELF_EXEMPT:-0}" -eq 1 && "$raw" -gt 0 ]]; then
        echo $((raw - 1))
    else
        echo "$raw"
    fi
}

patient_drain_detect_self_exempt() {
    PATIENT_SELF_EXEMPT=0
    if [[ "${HAPI_PATIENT_INCLUDE_SELF:-}" == "1" ]]; then
        return 0
    fi
    if [[ "${CURSOR_AGENT:-}" == "1" || "${CURSOR_INVOKED_AS:-}" == "agent" ]]; then
        PATIENT_SELF_EXEMPT=1
    fi
}

#!/usr/bin/env bash
# context-mode-cull-spinners — SIGKILL runaway context-mode MCP bun processes.
#
# Known bug: orphaned or stale context-mode/start.mjs can busy-loop at ~100% CPU
# (ppid=1 or dead Cursor parent). Legit idle servers sit near 0% CPU.
#
# Usage:
#   context-mode-cull-spinners.sh           # dry-run (default)
#   context-mode-cull-spinners.sh --kill    # SIGKILL matches + ntfy on kills
#   context-mode-cull-spinners.sh --kill --min-cpu 30 --min-age-secs 300
#
# Env:
#   CONTEXT_MODE_SPIN_MIN_CPU / CONTEXT_MODE_SPIN_MIN_AGE_SECS
#   CONTEXT_MODE_CULL_NTFY_TOPIC (default: context-mode-spinners)
#   NTFY_URL / NTFY_USER / NTFY_PASSWORD (from server-setup/.env)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NTFY_ENV="${NTFY_ENV:-/home/heavygee/coding/server-setup/.env}"
NTFY_TOPIC="${CONTEXT_MODE_CULL_NTFY_TOPIC:-context-mode-spinners}"
NTFY_URL="${NTFY_URL:-https://ntfy.introvrtlounge.com}"

MIN_CPU="${CONTEXT_MODE_SPIN_MIN_CPU:-50}"
MIN_AGE_SECS="${CONTEXT_MODE_SPIN_MIN_AGE_SECS:-600}"
DO_KILL=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --kill) DO_KILL=1; shift ;;
        --min-cpu) MIN_CPU="$2"; shift 2 ;;
        --min-age-secs) MIN_AGE_SECS="$2"; shift 2 ;;
        --help|-h)
            sed -n '2,18p' "$0"
            exit 0
            ;;
        *) echo "unknown arg: $1" >&2; exit 2 ;;
    esac
done

etime_to_secs() {
    local et="$1" days=0 h=0 m=0 s=0
    if [[ "$et" =~ ^([0-9]+)-([0-9]{2}):([0-9]{2}):([0-9]{2})$ ]]; then
        days="${BASH_REMATCH[1]}"; h="${BASH_REMATCH[2]}"; m="${BASH_REMATCH[3]}"; s="${BASH_REMATCH[4]}"
    elif [[ "$et" =~ ^([0-9]{2}):([0-9]{2}):([0-9]{2})$ ]]; then
        h="${BASH_REMATCH[1]}"; m="${BASH_REMATCH[2]}"; s="${BASH_REMATCH[3]}"
    elif [[ "$et" =~ ^([0-9]{2}):([0-9]{2})$ ]]; then
        m="${BASH_REMATCH[1]}"; s="${BASH_REMATCH[2]}"
    else
        return 1
    fi
    echo $((10#$days * 86400 + 10#$h * 3600 + 10#$m * 60 + 10#$s))
}

read_proc_env() {
    local pid="$1" key="$2"
    [[ -r "/proc/$pid/environ" ]] || return 0
    tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | awk -F= -v k="$key" '$1==k {print substr($0, index($0,"=")+1); exit}'
}

read_proc_cmd() {
    local pid="$1"
    tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | sed 's/  */ /g; s/ $//' || true
}

trace_origin() {
    local pid="$1"
    local cur="$pid" agent_sid="" workspace="" parent_cmd="" orphan=0
    local -a chain=()

    for _ in $(seq 1 10); do
        [[ -r "/proc/$cur/stat" ]] || break
        local ppid cmd
        ppid="$(awk '{print $4}' "/proc/$cur/stat" 2>/dev/null || echo 0)"
        cmd="$(read_proc_cmd "$cur")"
        chain+=("$cur:$cmd")

        if [[ -z "$agent_sid" ]]; then
            agent_sid="$(read_proc_env "$cur" CURSOR_AGENT_SESSION_ID)"
            [[ -z "$agent_sid" ]] && agent_sid="$(read_proc_env "$cur" CURSOR_SESSION_ID)"
        fi
        if [[ -z "$workspace" ]]; then
            workspace="$(read_proc_env "$cur" CURSOR_WORKSPACE)"
            [[ -z "$workspace" ]] && workspace="$(read_proc_env "$cur" VSCODE_CWD)"
        fi

        if [[ "$cur" == "$pid" && "$ppid" == "1" ]]; then
            orphan=1
        fi
        [[ "$ppid" == "0" || "$ppid" == "1" ]] && { parent_cmd="$cmd"; break; }
        cur="$ppid"
    done

    local hapi_name=""
    if [[ -n "$agent_sid" ]] && command -v jq >/dev/null && command -v curl >/dev/null; then
        local settings="${HAPI_SETTINGS:-$HOME/.hapi/settings.json}"
        if [[ -f "$settings" ]]; then
            local hub="${HAPI_HUB_URL:-http://127.0.0.1:3006}"
            local token jwt
            token="$(jq -r .cliApiToken "$settings" 2>/dev/null || true)"
            if [[ -n "$token" && "$token" != "null" ]]; then
                jwt="$(curl -fsS -m 2 -X POST "$hub/api/auth" -H 'Content-Type: application/json' \
                    -d "$(jq -cn --arg t "$token" '{accessToken:$t}')" 2>/dev/null | jq -r '.token // empty' || true)"
                if [[ -n "$jwt" ]]; then
                    hapi_name="$(curl -fsS -m 3 "$hub/api/sessions?limit=300" -H "Authorization: Bearer $jwt" 2>/dev/null \
                        | jq -r --arg a "$agent_sid" '(.sessions // .)[] | select(.metadata.agentSessionId // "" | startswith($a) or ($a | startswith(.))) | .metadata.name // empty' \
                        | head -1 || true)"
                fi
            fi
        fi
    fi

    local summary="orphan=$orphan"
    [[ -n "$agent_sid" ]] && summary="$summary agent=$agent_sid"
    [[ -n "$hapi_name" ]] && summary="$summary hapi=\"$hapi_name\""
    [[ -n "$workspace" ]] && summary="$summary ws=$(basename "$workspace")"
    if [[ ${#chain[@]} -gt 0 ]]; then
        summary="$summary chain=${chain[0]}"
        [[ ${#chain[@]} -gt 1 ]] && summary="$summary <- ${chain[1]%%:*}"
    fi
    printf '%s' "$summary"
}

load_ntfy_env() {
    [[ -f "$NTFY_ENV" ]] || return 1
    local line key val
    while IFS= read -r line; do
        [[ "$line" =~ ^NTFY_[A-Z0-9_]+= ]] || continue
        key="${line%%=*}"
        val="${line#*=}"
        val="${val%\"}"; val="${val#\"}"
        export "${key}=${val}"
    done < <(grep '^NTFY_' "$NTFY_ENV" || true)
}

send_ntfy_kills() {
    local count="$1" body="$2"
    [[ "$count" -gt 0 ]] || return 0
    load_ntfy_env || { echo "ntfy: skip (no $NTFY_ENV)" >&2; return 0; }
    [[ -n "${NTFY_PASSWORD:-}" ]] || { echo "ntfy: skip (NTFY_PASSWORD unset)" >&2; return 0; }
    local user="${NTFY_USER:-heavygee}"
    local url="${NTFY_PUBLIC_URL:-https://ntfy.introvrtlounge.com}"
    local title="context-mode spinner cull ($count killed)"
    curl -fsS -m 10 -u "${user}:${NTFY_PASSWORD}" \
        -H "Title: ${title}" \
        -H "Priority: high" \
        -H "Tags: skull,cpu" \
        -d "$body" \
        "${url%/}/${NTFY_TOPIC}" >/dev/null 2>&1 \
        && echo "ntfy: sent to ${NTFY_TOPIC}" \
        || echo "ntfy: publish failed (non-fatal)" >&2
}

matches=0
killed=0
kill_report=""

while read -r pid ppid cpu etime cmd; do
    [[ -n "$pid" ]] || continue
    cpu_int="${cpu%%.*}"
    [[ "$cpu_int" -ge "$MIN_CPU" ]] || continue

    age_secs=0
    if ! age_secs="$(etime_to_secs "$etime" 2>/dev/null)"; then
        age_secs=0
    fi
    [[ "$age_secs" -ge "$MIN_AGE_SECS" ]] || continue

    state="$(awk '/^State:/{print $2}' "/proc/$pid/status" 2>/dev/null || echo "?")"
    origin="$(trace_origin "$pid")"

    echo "MATCH pid=$pid ppid=$ppid cpu=${cpu}% age=${age_secs}s state=$state"
    echo "       origin: $origin"
    echo "       $cmd"
    matches=$((matches + 1))

    if [[ "$DO_KILL" == "1" ]]; then
        if kill -9 "$pid" 2>/dev/null; then
            echo "       -> SIGKILL ok"
            killed=$((killed + 1))
            kill_report="${kill_report}pid=${pid} cpu=${cpu}% age=${age_secs}s ${origin}"$'\n'
        else
            echo "       -> SIGKILL failed (already gone?)" >&2
        fi
    fi
done < <(ps -eo pid=,ppid=,%cpu=,etime=,cmd= | awk '/context-mode\/start\.mjs/ {print}')

if [[ "$DO_KILL" == "1" ]]; then
    echo "context-mode-cull-spinners: matched=$matches killed=$killed (min_cpu=${MIN_CPU} min_age=${MIN_AGE_SECS}s)"
    if [[ "$killed" -gt 0 ]]; then
        host="$(hostname -s 2>/dev/null || hostname)"
        msg="host=${host} killed=${killed}/${matches} thresholds: cpu>=${MIN_CPU}% age>=${MIN_AGE_SECS}s
known context-mode MCP lifecycle bug (orphan busy-loop)

${kill_report}
log: /tmp/context-mode-cull.log"
        send_ntfy_kills "$killed" "$msg"
    fi
else
    echo "context-mode-cull-spinners: matched=$matches (dry-run; pass --kill to SIGKILL)"
fi

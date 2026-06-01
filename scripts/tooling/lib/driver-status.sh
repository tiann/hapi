#!/usr/bin/env bash
# driver-status.sh -- sourceable helpers for HAPI driver-stack coordination.
#
# Purpose
#   Two scripts mutate the daily-driver stack:
#     - hapi-driver-rebuild  (rewrites ~/coding/hapi-driver from the manifest)
#     - hapi-use-worktree    (swings hapi-active + restarts hub + runner)
#   With ~30 agents on this repo at once, parallel invocations corrupt the
#   driver tree mid-merge or restart the hub mid-build. This lib gives both
#   scripts:
#     1. flock-based mutual exclusion (per-operation lock)
#     2. a single JSON status file consumers can poll
#     3. start / end hooks that record state automatically
#
# Status file: ~/.hapi/driver-status.json (atomic rewrite, schema v1)
#   {
#     "schema": 1,
#     "updated_at": "2026-06-01T20:45:00Z",
#     "rebuild": {
#       "state":        "idle" | "running",
#       "pid":          null | <int>,
#       "started_at":   "...Z"  | null,
#       "started_by":   "operator" | "<agent-label>",
#       "args":         ["--build-web", ...],
#       "completed_at": "...Z" | null,
#       "exit_code":    <int>  | null,
#       "head_sha":     "<short-sha>" | null,
#       "head_subject": "<commit subject>" | null,
#       "manifest_layer_count": <int> | null
#     },
#     "switch": {
#       "state":        "idle" | "running",
#       "pid":          null | <int>,
#       "started_at":   "...Z"  | null,
#       "started_by":   "operator" | "<agent-label>",
#       "from":         "/path" | null,
#       "to":           "/path" | null,
#       "completed_at": "...Z" | null,
#       "exit_code":    <int>  | null
#     },
#     "active": {
#       "target":     "/home/heavygee/coding/hapi-driver",
#       "is_driver":  true,
#       "symlink_mtime": "...Z"
#     }
#   }
#
# Usage (from a wrapper script)
#   source "$(dirname "$0")/lib/driver-status.sh"
#   driver_status_init                                  # ensure dirs + jq present
#   driver_status_acquire rebuild                       # flock or fail loud
#   driver_status_begin rebuild "$@"                    # write state=running
#   trap 'driver_status_end rebuild "$?"' EXIT          # record exit code
#   ... rebuild work ...
#
# Override env (test-only)
#   HAPI_STATE_DIR     default ~/.hapi
#   HAPI_LOCK_DIR      default $HAPI_STATE_DIR/locks
#   HAPI_STATUS_FILE   default $HAPI_STATE_DIR/driver-status.json
#   HAPI_AGENT_LABEL   identifier written into started_by (default "operator")

HAPI_STATE_DIR="${HAPI_STATE_DIR:-$HOME/.hapi}"
HAPI_LOCK_DIR="${HAPI_LOCK_DIR:-$HAPI_STATE_DIR/locks}"
HAPI_STATUS_FILE="${HAPI_STATUS_FILE:-$HAPI_STATE_DIR/driver-status.json}"
HAPI_AGENT_LABEL="${HAPI_AGENT_LABEL:-operator}"

# FD numbers for the two operation locks. High enough to avoid stomping on
# anything the caller is using.
_HAPI_LOCK_FD_REBUILD=201
_HAPI_LOCK_FD_SWITCH=202

driver_status_init() {
    mkdir -p "$HAPI_STATE_DIR" "$HAPI_LOCK_DIR"
    if ! command -v jq >/dev/null 2>&1; then
        echo "ERROR: jq required for driver-status (apt install jq)" >&2
        return 1
    fi
    if [[ ! -f "$HAPI_STATUS_FILE" ]]; then
        _driver_status_write_initial
    fi
}

_driver_status_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

_driver_status_active_block() {
    local active_link="$HOME/coding/hapi-active"
    local target="null" is_driver=false mtime="null" mtime_epoch
    if [[ -L "$active_link" ]]; then
        target="\"$(readlink -f "$active_link")\""
        if [[ "$(readlink -f "$active_link")" == "$(readlink -f "$HOME/coding/hapi-driver" 2>/dev/null || echo /nope)" ]]; then
            is_driver=true
        fi
        # stat the symlink itself (not the target) -- this is the swing time.
        mtime_epoch="$(stat -c '%Y' "$active_link" 2>/dev/null || echo 0)"
        if [[ "$mtime_epoch" =~ ^[0-9]+$ ]] && (( mtime_epoch > 0 )); then
            mtime="\"$(date -u -d "@$mtime_epoch" +%Y-%m-%dT%H:%M:%SZ)\""
        fi
    fi
    printf '{"target":%s,"is_driver":%s,"symlink_mtime":%s}' \
        "$target" "$is_driver" "$mtime"
}

_driver_status_write_initial() {
    local tmp
    tmp="$(mktemp -p "$HAPI_STATE_DIR" .driver-status.XXXXXX.json)"
    cat > "$tmp" <<EOF
{
  "schema": 1,
  "updated_at": "$(_driver_status_now)",
  "rebuild": {
    "state": "idle", "pid": null,
    "started_at": null, "started_by": null, "args": [],
    "completed_at": null, "exit_code": null,
    "head_sha": null, "head_subject": null,
    "manifest_layer_count": null
  },
  "switch": {
    "state": "idle", "pid": null,
    "started_at": null, "started_by": null,
    "from": null, "to": null,
    "completed_at": null, "exit_code": null
  },
  "active": $(_driver_status_active_block)
}
EOF
    mv "$tmp" "$HAPI_STATUS_FILE"
}

# driver_status_acquire <rebuild|switch>
# Hard-fails (exits caller with code 75 EX_TEMPFAIL) if the lock is held.
# We use exit 75 rather than 1 so callers/CI can distinguish "busy" from
# "real failure".
driver_status_acquire() {
    local op="$1" fd lockfile other_pid other_started other_who
    case "$op" in
        rebuild) fd=$_HAPI_LOCK_FD_REBUILD; lockfile="$HAPI_LOCK_DIR/rebuild.lock" ;;
        switch)  fd=$_HAPI_LOCK_FD_SWITCH;  lockfile="$HAPI_LOCK_DIR/switch.lock" ;;
        *) echo "driver_status_acquire: unknown op '$op'" >&2; exit 2 ;;
    esac
    eval "exec $fd>\"$lockfile\""
    if ! flock -n "$fd"; then
        echo "ERROR: hapi-$op already in progress. Inspect: hapi-driver-status" >&2
        if [[ -f "$HAPI_STATUS_FILE" ]] && command -v jq >/dev/null 2>&1; then
            other_pid="$(jq -r ".${op}.pid // \"?\"" "$HAPI_STATUS_FILE")"
            other_started="$(jq -r ".${op}.started_at // \"?\"" "$HAPI_STATUS_FILE")"
            other_who="$(jq -r ".${op}.started_by // \"?\"" "$HAPI_STATUS_FILE")"
            echo "       pid=$other_pid  started_at=$other_started  by=$other_who" >&2
            if [[ "$other_pid" =~ ^[0-9]+$ ]] && ! kill -0 "$other_pid" 2>/dev/null; then
                echo "       NOTE: pid $other_pid is dead -- prior run crashed without releasing status." >&2
                echo "       Remove stale lock: rm $lockfile  (status will self-heal on next run)" >&2
            fi
        fi
        exit 75
    fi
}

# driver_status_begin <op> [args...]
driver_status_begin() {
    local op="$1"; shift
    local args_json now
    now="$(_driver_status_now)"
    if (( $# == 0 )); then
        args_json='[]'
    else
        args_json="$(printf '%s\n' "$@" | jq -R . | jq -s .)"
    fi
    _driver_status_jq_update "
      .updated_at = \"$now\" |
      .${op}.state = \"running\" |
      .${op}.pid = $$ |
      .${op}.started_at = \"$now\" |
      .${op}.started_by = \"$HAPI_AGENT_LABEL\" |
      .${op}.completed_at = null |
      .${op}.exit_code = null |
      .${op}.args = $args_json |
      .active = $(_driver_status_active_block)
    "
}

# driver_status_end <op> <exit-code> [key=value ...]
# Extra k=v pairs are merged as strings into the op block (e.g. head_sha=abc123).
driver_status_end() {
    local op="$1" exit_code="$2"; shift 2 || true
    local now extra="" k v
    now="$(_driver_status_now)"
    for kv in "$@"; do
        k="${kv%%=*}"
        v="${kv#*=}"
        if [[ "$v" =~ ^[0-9]+$ ]]; then
            extra+=" | .${op}.${k} = ${v}"
        else
            extra+=" | .${op}.${k} = \"$(printf '%s' "$v" | sed 's/\\/\\\\/g;s/"/\\"/g')\""
        fi
    done
    _driver_status_jq_update "
      .updated_at = \"$now\" |
      .${op}.state = \"idle\" |
      .${op}.pid = null |
      .${op}.completed_at = \"$now\" |
      .${op}.exit_code = ${exit_code}
      ${extra} |
      .active = $(_driver_status_active_block)
    " || true
}

# driver_status_set <op> key=value [key=value ...]  (mid-run mutation)
driver_status_set() {
    local op="$1"; shift
    local extra="" k v
    for kv in "$@"; do
        k="${kv%%=*}"
        v="${kv#*=}"
        if [[ "$v" =~ ^[0-9]+$ ]]; then
            extra+=" | .${op}.${k} = ${v}"
        else
            extra+=" | .${op}.${k} = \"$(printf '%s' "$v" | sed 's/\\/\\\\/g;s/"/\\"/g')\""
        fi
    done
    _driver_status_jq_update "
      .updated_at = \"$(_driver_status_now)\"
      ${extra} |
      .active = $(_driver_status_active_block)
    " || true
}

_driver_status_jq_update() {
    local expr="$1" tmp
    [[ -f "$HAPI_STATUS_FILE" ]] || _driver_status_write_initial
    tmp="$(mktemp -p "$HAPI_STATE_DIR" .driver-status.XXXXXX.json)"
    if jq "$expr" "$HAPI_STATUS_FILE" > "$tmp" 2>/dev/null; then
        mv "$tmp" "$HAPI_STATUS_FILE"
    else
        rm -f "$tmp"
        echo "WARN: driver-status JSON update failed (jq)" >&2
        return 1
    fi
}

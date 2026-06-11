#!/usr/bin/env bash
# hapi-runner-watchdog.sh
#
# Belt-and-braces watchdog: if THIS host's machine entry is missing from the
# hub's /api/machines list OR its runner.status is not "running", restart the
# hapi-runner.service systemd unit.
#
# Run by hapi-runner-watchdog.service (oneshot) on the schedule defined by
# hapi-runner-watchdog.timer. Logs to journald.
#
# Configuration via env vars (optionally loaded from
# /home/heavygee/.hapi/runner-watchdog.env by the service unit):
#
#   HAPI_API_URL          (default: http://127.0.0.1:3006)
#   CLI_API_TOKEN         (required - Bearer token for /api/machines)
#                         If missing, falls back to settings.json's cliApiToken.
#   HAPI_HOME             (default: ~/.hapi) - location of settings.json + runner.state.json
#   HAPI_WATCHDOG_DRY_RUN (default: empty) - if "1", log decision but don't actually restart
#   HAPI_WATCHDOG_GRACE_SEC (default: 30) - how recently runner.state.json must
#                         have been touched to be considered alive even if absent
#                         from the hub list (handles brief reconnect windows).
#
# Exit codes:
#   0 - runner healthy OR successfully restarted OR probe inconclusive
#   1 - probe + restart attempt both failed
#   2 - misconfigured (missing token, etc.) - RestartPreventExitStatus=2
#       in the unit catches this so we don't restart-loop on a config bug.
#
# History:
#   2026-05-31  Original (commit 720bb847) - probed /cli/machines/ which returns
#               SPA HTML, never worked. Read .lastHeartbeat from state.json which
#               does not exist in the schema.
#   2026-06-11  Restored + fixed: probes /api/machines, uses state.json mtime
#               directly for grace window. Confirmed working against live hub.

set -euo pipefail

log() {
    printf '%s [watchdog] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

HAPI_API_URL="${HAPI_API_URL:-http://127.0.0.1:3006}"
HAPI_HOME="${HAPI_HOME:-$HOME/.hapi}"
GRACE_SEC="${HAPI_WATCHDOG_GRACE_SEC:-30}"
SETTINGS_FILE="$HAPI_HOME/settings.json"
STATE_FILE="$HAPI_HOME/runner.state.json"

if [[ ! -f "$SETTINGS_FILE" ]]; then
    log "settings.json missing at $SETTINGS_FILE; nothing to do"
    exit 0
fi

CLI_TOKEN="${CLI_API_TOKEN:-}"
if [[ -z "$CLI_TOKEN" ]] && command -v jq >/dev/null; then
    CLI_TOKEN="$(jq -r '.cliApiToken // empty' "$SETTINGS_FILE" 2>/dev/null || true)"
fi
if [[ -z "$CLI_TOKEN" ]]; then
    log "ERROR: no CLI_API_TOKEN in env or settings.json (cliApiToken)"
    exit 2
fi

# Exchange cliApiToken for a Bearer JWT via /api/auth.
AUTH_RESP="$(curl -sS \
    --max-time 5 \
    -H 'Content-Type: application/json' \
    -d "{\"accessToken\":\"$CLI_TOKEN\"}" \
    "$HAPI_API_URL/api/auth" 2>/dev/null || true)"
TOKEN="$(echo "$AUTH_RESP" | jq -r '.token // empty' 2>/dev/null || true)"
if [[ -z "$TOKEN" ]]; then
    log "hub auth exchange failed at $HAPI_API_URL/api/auth; not restarting on probe failure"
    exit 0
fi

MACHINE_ID=""
if command -v jq >/dev/null; then
    MACHINE_ID="$(jq -r '.machineId // empty' "$SETTINGS_FILE" 2>/dev/null || true)"
fi
if [[ -z "$MACHINE_ID" ]]; then
    log "ERROR: no machineId in settings.json"
    exit 2
fi

# Probe the hub. /api/machines returns { "machines": [ ... ] }.
TMP_RESP="$(mktemp)"
trap 'rm -f "$TMP_RESP"' EXIT

HTTP_CODE="$(curl -sS \
    -o "$TMP_RESP" \
    -w '%{http_code}' \
    -H "Authorization: Bearer $TOKEN" \
    --max-time 5 \
    "$HAPI_API_URL/api/machines" 2>/dev/null || echo 'curl_fail')"

if [[ "$HTTP_CODE" == "curl_fail" || "$HTTP_CODE" != "200" ]]; then
    log "hub probe failed (HTTP $HTTP_CODE at $HAPI_API_URL/api/machines); not restarting on a failed probe"
    exit 0
fi

# Look up THIS machine. Hub returns either a top-level array (older) or
# { "machines": [ ... ] } (current). runnerState.status is the live field.
HEALTHY="false"
if command -v jq >/dev/null; then
    HEALTHY="$(jq -r --arg mid "$MACHINE_ID" '
        (if type == "array" then . else (.machines // []) end)
        | map(select(.id == $mid))
        | if length == 0 then false
          else (.[0].runnerState.status // .[0].runner.status // "unknown") == "running"
          end
        | tostring
    ' "$TMP_RESP" 2>/dev/null || echo 'parse_fail')"
fi

if [[ "$HEALTHY" == "true" ]]; then
    log "machine $MACHINE_ID present + runner running on $HAPI_API_URL; no action"
    exit 0
fi

# Grace window: if runner.state.json was touched recently the runner is
# probably mid-startup or mid-reconnect. Skip restart in that window.
if [[ -f "$STATE_FILE" ]]; then
    LAST_MTIME="$(stat -c '%Y' "$STATE_FILE" 2>/dev/null || echo 0)"
    NOW="$(date +%s)"
    AGE=$((NOW - LAST_MTIME))
    if (( AGE < GRACE_SEC )); then
        log "machine $MACHINE_ID not healthy on hub but state.json ${AGE}s old (< grace ${GRACE_SEC}s); skipping restart"
        exit 0
    fi
    log "machine $MACHINE_ID absent or runner not running; state.json ${AGE}s stale"
else
    log "machine $MACHINE_ID absent or runner not running; no state file (runner not started)"
fi

# Bonus check before restart: if there IS a process at the recorded pid AND
# it's a hapi runner, the watchdog can't tell what's wrong from the outside.
# Restarting will at minimum re-register the machine with the hub.
if [[ -f "$STATE_FILE" ]] && command -v jq >/dev/null; then
    PID="$(jq -r '.pid // empty' "$STATE_FILE" 2>/dev/null || true)"
    if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
        log "(note: pid $PID is alive but unhealthy on hub - restart will re-register)"
    fi
fi

if [[ "${HAPI_WATCHDOG_DRY_RUN:-}" == "1" ]]; then
    log "DRY_RUN: would 'sudo systemctl restart hapi-runner.service'"
    exit 0
fi

log "restarting hapi-runner.service via systemctl"
if systemctl restart hapi-runner.service 2>/dev/null; then
    log "restart OK"
    exit 0
fi

if sudo -n systemctl restart hapi-runner.service 2>/dev/null; then
    log "restart OK (via sudo)"
    exit 0
fi

log "ERROR: could not restart hapi-runner.service (permission? check /etc/sudoers.d/hapi-watchdog)"
exit 1

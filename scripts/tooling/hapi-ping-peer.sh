#!/usr/bin/env bash
# hapi-ping-peer - resume a HAPI session and send it a message
#
# Usage:
#   hapi-ping-peer <session-id-prefix> <message-text>
#   hapi-ping-peer <session-id-prefix> --message-file <path>
#   hapi-ping-peer --list                # list known sessions (id, name, last-updated)
#
# Resolves a session by ID prefix (8 chars OK). If session is inactive,
# requests resume via the runner (POST /sessions/:id/resume), polls until
# active, then POSTs the message (POST /sessions/:id/messages).
#
# Env:
#   HAPI_HOST       (default http://localhost:3006)
#   HAPI_SETTINGS   (default ~/.hapi/settings.json - reads cliApiToken)
#   HAPI_WAIT_ACTIVE_SECS (default 60)
#
# Exit codes:
#   0 = message delivered
#   2 = bad args / missing token
#   3 = resume failed (no_machine_online, access_denied, etc)
#   4 = wait-for-active timed out OR send failed
set -euo pipefail

HAPI_HOST="${HAPI_HOST:-http://localhost:3006}"
SETTINGS="${HAPI_SETTINGS:-$HOME/.hapi/settings.json}"
WAIT_FOR_ACTIVE="${HAPI_WAIT_ACTIVE_SECS:-60}"

err() { echo "hapi-ping-peer: $*" >&2; }
die() { err "$*"; exit 2; }

SESSION_ARG=""
MESSAGE=""
MESSAGE_FILE=""
LIST_ONLY=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --message-file) MESSAGE_FILE="$2"; shift 2 ;;
        --wait) WAIT_FOR_ACTIVE="$2"; shift 2 ;;
        --host) HAPI_HOST="$2"; shift 2 ;;
        --list) LIST_ONLY=1; shift ;;
        --help|-h) sed -n '2,21p' "$0"; exit 0 ;;
        *)
            if [[ -z "$SESSION_ARG" ]]; then
                SESSION_ARG="$1"
            elif [[ -z "$MESSAGE" ]]; then
                MESSAGE="$1"
            else
                die "unexpected arg: $1"
            fi
            shift ;;
    esac
done

# step 1: token
[[ -f "$SETTINGS" ]] || die "settings file not found: $SETTINGS"
RAW_TOKEN=$(jq -r '.cliApiToken // empty' "$SETTINGS")
[[ -n "$RAW_TOKEN" ]] || die "no cliApiToken in $SETTINGS (run 'hapi auth login')"

# step 2: JWT
JWT=$(curl -sS --max-time 5 -X POST -H 'Content-Type: application/json' \
    -d "$(jq -cn --arg t "$RAW_TOKEN:default" '{accessToken:$t}')" \
    "$HAPI_HOST/api/auth" | jq -r '.token // empty')
[[ -n "$JWT" ]] || die "failed to exchange access token for JWT (is $HAPI_HOST reachable?)"

# helper: GET via JWT
hapi_get() {
    curl -sS --max-time 5 -H "Authorization: Bearer $JWT" "$HAPI_HOST$1"
}
hapi_post() {
    curl -sS --max-time 10 -X POST -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' -d "$2" "$HAPI_HOST$1"
}

if [[ "$LIST_ONLY" == "1" ]]; then
    hapi_get "/api/sessions?limit=200" \
        | jq -r '(.sessions // .) | sort_by(.updatedAt // .updated_at // 0) | reverse
                 | .[] | "  \(.id[:8])  active=\(.active // false)  flavor=\(.metadata.flavor // "?")  \(.metadata.name // "(unnamed)")"' 2>/dev/null \
        | head -30
    exit 0
fi

[[ -n "$SESSION_ARG" ]] || die "missing session id; usage: hapi-ping-peer <session-id> <message>"
if [[ -n "$MESSAGE_FILE" ]]; then
    [[ -f "$MESSAGE_FILE" ]] || die "message file not found: $MESSAGE_FILE"
    MESSAGE=$(cat "$MESSAGE_FILE")
fi
[[ -n "$MESSAGE" ]] || die "missing message; provide as arg or --message-file"

# step 3: resolve session ID prefix
SESSIONS=$(hapi_get "/api/sessions?limit=500")
SID=$(echo "$SESSIONS" | jq -r --arg p "$SESSION_ARG" '(.sessions // .) | .[] | select(.id | startswith($p)) | .id' | head -1)
if [[ -z "$SID" ]]; then
    err "no session matching prefix '$SESSION_ARG' (use --list to see available)"
    exit 2
fi
NAME=$(echo "$SESSIONS" | jq -r --arg p "$SESSION_ARG" '(.sessions // .) | .[] | select(.id | startswith($p)) | .metadata.name // "(unnamed)"' | head -1)
ACTIVE=$(echo "$SESSIONS" | jq -r --arg p "$SESSION_ARG" '(.sessions // .) | .[] | select(.id | startswith($p)) | .active // false' | head -1)
echo "hapi-ping-peer: resolved $SID  active=$ACTIVE  name=\"$NAME\""

# step 4: resume if inactive
if [[ "$ACTIVE" != "true" ]]; then
    echo "hapi-ping-peer: requesting resume..."
    RESUME=$(hapi_post "/api/sessions/$SID/resume" '{}')
    if ! echo "$RESUME" | jq -e '.type == "success"' >/dev/null 2>&1; then
        err "resume failed: $RESUME"
        err "  (if code=no_machine_online: runner is not up. Try: systemctl --user start hapi-runner)"
        exit 3
    fi
    echo "hapi-ping-peer: resume requested - waiting up to ${WAIT_FOR_ACTIVE}s for active state..."
    end=$(( $(date +%s) + WAIT_FOR_ACTIVE ))
    ACTIVE=false
    while [[ $(date +%s) -lt $end ]]; do
        ACTIVE=$(hapi_get "/api/sessions/$SID" 2>/dev/null | jq -r '.session.active // false')
        if [[ "$ACTIVE" == "true" ]]; then break; fi
        sleep 2
    done
    if [[ "$ACTIVE" != "true" ]]; then
        die "session did not become active within ${WAIT_FOR_ACTIVE}s; runner may have failed to spawn"
    fi
    echo "hapi-ping-peer: session active"
fi

# step 5: send message
echo "hapi-ping-peer: sending message (${#MESSAGE} chars)..."
SEND=$(hapi_post "/api/sessions/$SID/messages" "$(jq -cn --arg t "$MESSAGE" '{text:$t}')")
if echo "$SEND" | jq -e '.ok == true' >/dev/null 2>&1; then
    echo "hapi-ping-peer: OK - delivered to $SID"
    exit 0
else
    err "send failed: $SEND"
    exit 4
fi

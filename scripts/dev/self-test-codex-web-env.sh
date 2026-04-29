#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export PATH="$HOME/.bun/bin:$PATH"
export HAPI_DEV_HOME="${HAPI_DEV_HOME:-/tmp/hapi-dev-codex-web}"
export HAPI_DEV_TOKEN="${HAPI_DEV_TOKEN:-hapi-dev-token}"
export HAPI_DEV_HUB_PORT="${HAPI_DEV_HUB_PORT:-3106}"
export HAPI_DEV_WEB_PORT="${HAPI_DEV_WEB_PORT:-5174}"
ARTIFACT_DIR="${ARTIFACT_DIR:-/tmp/hapi-dev-codex-web-artifacts}"
mkdir -p "$ARTIFACT_DIR"

if ss -ltn | grep -q ":${HAPI_DEV_HUB_PORT} "; then
  echo "port ${HAPI_DEV_HUB_PORT} already in use" >&2
  exit 2
fi
if ss -ltn | grep -q ":${HAPI_DEV_WEB_PORT} "; then
  echo "port ${HAPI_DEV_WEB_PORT} already in use" >&2
  exit 2
fi

rm -rf "$HAPI_DEV_HOME"
mkdir -p "$HAPI_DEV_HOME"
SEED_JSON="$ARTIFACT_DIR/seed.json"
WEB_JSON="$ARTIFACT_DIR/web-read.json"
WEB_TEXT="$ARTIFACT_DIR/web-visible.txt"
SCREENSHOT="$ARTIFACT_DIR/web.png"
HUB_LOG="$ARTIFACT_DIR/hub.log"
WEB_LOG="$ARTIFACT_DIR/web.log"

cd "$ROOT"
bun scripts/dev/seed-codex-web-fixture.ts --db "$HAPI_DEV_HOME/hapi.db" --reset > "$SEED_JSON"
SESSION_ID="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).sessionId)" "$SEED_JSON")"

cleanup() {
  if [[ -n "${HUB_PID:-}" ]]; then kill "$HUB_PID" 2>/dev/null || true; fi
  if [[ -n "${WEB_PID:-}" ]]; then kill "$WEB_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT

CLI_API_TOKEN="$HAPI_DEV_TOKEN" \
HAPI_HOME="$HAPI_DEV_HOME" \
DB_PATH="$HAPI_DEV_HOME/hapi.db" \
HAPI_LISTEN_HOST=127.0.0.1 \
HAPI_LISTEN_PORT="$HAPI_DEV_HUB_PORT" \
bun run dev:hub > "$HUB_LOG" 2>&1 &
HUB_PID=$!

for _ in {1..80}; do
  if curl -fsS "http://127.0.0.1:${HAPI_DEV_HUB_PORT}/api/auth" \
    -H 'content-type: application/json' \
    -d "{\"accessToken\":\"$HAPI_DEV_TOKEN\"}" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

VITE_HUB_PROXY="http://127.0.0.1:${HAPI_DEV_HUB_PORT}" \
bun --cwd web vite --host 127.0.0.1 --port "$HAPI_DEV_WEB_PORT" --strictPort --force > "$WEB_LOG" 2>&1 &
WEB_PID=$!

for _ in {1..80}; do
  if curl -fsS "http://127.0.0.1:${HAPI_DEV_WEB_PORT}/" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

node scripts/dev/read-hapi-web.mjs \
  "http://127.0.0.1:${HAPI_DEV_WEB_PORT}/sessions/${SESSION_ID}?token=${HAPI_DEV_TOKEN}" \
  --expect "Codex fixture response visible" \
  --expect "Fixture reasoning detail" \
  --expect "MCP: Fixture Lookup Context" \
  --expect "Inspect event stream" \
  --expect "Render plan card" \
  --expect "Verify web DOM" \
  --out "$WEB_TEXT" \
  --screenshot "$SCREENSHOT" \
  --timeout 20000 > "$WEB_JSON"

node -e "const j=JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); console.log(JSON.stringify({ok:j.ok, textLength:j.textLength, failedRequests:j.failedRequests.length, url:j.url}, null, 2))" "$WEB_JSON"
echo "artifacts: $ARTIFACT_DIR"

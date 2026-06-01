#!/usr/bin/env bash
# Lookup agent chat by index number or UUID prefix in ~/.hapi/operator/reconnectable-agent-chats.json
set -euo pipefail

INDEX="${HAPI_CHAT_INDEX:-$HOME/.hapi/operator/reconnectable-agent-chats.json}"
TOKEN="${1:-}"

if [[ -z "$TOKEN" ]]; then
  echo "Usage: lookup-agent-chat.sh <index#|uuid-prefix>" >&2
  exit 2
fi

if [[ ! -f "$INDEX" ]]; then
  echo "Index not found: $INDEX (run localdocs/operator/regenerate-chat-index.sh)" >&2
  exit 1
fi

python3 - "$TOKEN" "$INDEX" <<'PY'
import json, sys
token, path = sys.argv[1], sys.argv[2]
rows = json.load(open(path))
if isinstance(rows, dict):
    rows = rows.get('chats', [])
needle = token.lower().lstrip('#')

if needle.isdigit():
    n = int(needle)
    hit = next((r for r in rows if r.get('n') == n), None)
else:
    exact = [r for r in rows if (r.get('id') or '').lower() == needle]
    pref = [r for r in rows if (r.get('id') or '').lower().startswith(needle)]
    hit = exact[0] if len(exact) == 1 else (pref[0] if len(pref) == 1 else None)

if not hit:
    print(f'no match for {token}', file=sys.stderr)
    sys.exit(1)

print(json.dumps(hit, indent=2))
print(f"\nattach: scripts/attach-agent-chat.sh {hit['id']}")
PY

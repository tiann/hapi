#!/usr/bin/env bash
# Installer for operator-local Cursor hooks in this repo.
#
# This repo's .gitignore intentionally keeps .cursor/hooks.json and .cursor/hooks/
# untracked (per-user state). The canonical hook scripts live in scripts/tooling/
# (tracked); this installer writes a per-user .cursor/hooks.json that points at
# them. Run on every fresh clone (or any machine that needs the hooks).
#
# Idempotent: rewrites .cursor/hooks.json each time. Preserves nothing in that
# file - if you have machine-specific Cursor hooks, keep them in
# ~/.cursor/hooks.json (user-level) instead.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOKS_JSON="${REPO_ROOT}/.cursor/hooks.json"
GUARD_SCRIPT="${REPO_ROOT}/scripts/tooling/hapi-product-code-guard.sh"

if [ ! -x "$GUARD_SCRIPT" ]; then
    echo "ERROR: ${GUARD_SCRIPT} missing or not executable" >&2
    exit 1
fi

mkdir -p "${REPO_ROOT}/.cursor"

cat > "$HOOKS_JSON" <<'JSON'
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      {
        "command": "./scripts/tooling/hapi-product-code-guard.sh",
        "matcher": "Write|Edit|StrReplace|MultiEdit|EditNotebook"
      }
    ]
  }
}
JSON

echo "Wrote ${HOOKS_JSON}"
echo "Hook: hapi-product-code-guard.sh -> blocks edits to cli/, hub/, web/, shared/ outside ~/coding/hapi/worktrees/"
echo
echo "Bypass when needed (operator-approved):"
echo "  export HAPI_OPERATOR_PRODUCT_EDIT_OVERRIDE=1"
echo
echo "Restart Cursor (or reload) to pick up the hook."

#!/usr/bin/env bash
# Point this clone's git hooks at scripts/tooling/git-hooks/
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOKS="$ROOT/scripts/tooling/git-hooks"

chmod +x "$HOOKS"/pre-commit "$HOOKS"/commit-msg 2>/dev/null || true
git -C "$ROOT" config core.hooksPath "$HOOKS"
echo "Installed git hooksPath → $HOOKS"
echo "Hooks: pre-commit (secrets + operator paths), commit-msg (persona leaks)"
echo "Bypass: HAPI_SKIP_COMMIT_HOOKS=1 git commit ..."

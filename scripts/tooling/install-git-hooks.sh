#!/usr/bin/env bash
# Point this clone's git hooks at scripts/tooling/git-hooks/
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOKS="$ROOT/scripts/tooling/git-hooks"

chmod +x "$HOOKS"/pre-commit "$HOOKS"/commit-msg "$HOOKS"/pre-push 2>/dev/null || true
chmod +x "$ROOT/scripts/tooling/check-operator-leaks.sh" "$ROOT/scripts/tooling/gh-public-body-check.sh" 2>/dev/null || true
chmod +x "$ROOT/scripts/tooling/check-stash-advisory.sh" 2>/dev/null || true
git -C "$ROOT" config core.hooksPath "$HOOKS"
echo "Installed git hooksPath → $HOOKS"
echo "Hooks: pre-commit, commit-msg, pre-push (fork-private paths, secrets, operator tailnet URLs)"
echo "Bypass: HAPI_SKIP_COMMIT_HOOKS=1 git commit ..."
echo "Public gh bodies: scripts/tooling/gh-public-body-check.sh /tmp/issue.md before gh issue create"
echo ""
echo "Stash policy (multi-agent repo): docs/tooling/git-stash-policy.md"
"$ROOT/scripts/tooling/check-stash-advisory.sh" --quiet || true

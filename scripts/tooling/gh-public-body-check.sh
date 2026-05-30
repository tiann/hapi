#!/usr/bin/env bash
# Run before: gh issue create/edit, gh pr create/edit (public repos).
#   gh-public-body-check.sh /tmp/issue-body.md
#   gh issue create ... --body-file <(gh-public-body-check.sh --filter body.md)
#
# Modes:
#   gh-public-body-check.sh PATH [..]     check file(s), exit 1 on leak
#   gh-public-body-check.sh --filter PATH  print PATH to stdout if clean (for --body-file)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="$SCRIPT_DIR/check-operator-leaks.sh"
chmod +x "$CHECK" 2>/dev/null || true

if [[ "${1:-}" == "--filter" ]]; then
    [[ $# -eq 2 ]] || { echo "Usage: $0 --filter PATH" >&2; exit 2; }
    "$CHECK" --file "$2"
    cat "$2"
    exit 0
fi

[[ $# -ge 1 ]] || { echo "Usage: $0 PATH [..]  |  $0 --filter PATH" >&2; exit 2; }
exec "$CHECK" --file "$@"

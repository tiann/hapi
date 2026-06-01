#!/usr/bin/env bash
# Surface git worktrees that live outside the canonical layout.
# Non-blocking - prints to stderr, always exits 0.
#
# Canonical layout (2026-06-01 onward):
#   ~/coding/hapi/                 main mirror, branch=main
#   ~/coding/hapi/driver           daily-driver soup
#   ~/coding/hapi/upstream         clean upstream baseline
#   ~/coding/hapi/active           symlink at runtime, not a worktree per se
#   ~/coding/hapi/worktrees/<X>    everything else
#
# Anything outside these is legacy (pre-2026-06-01) or a wrong-place creation.
# Legacy is OK during Phase 2 drain; wrong-place creations should be flagged.
#
# See: docs/plans/2026-06-01-hapi-folders-reorganization.md
#
# Usage:
#   scripts/tooling/check-worktree-layout.sh           # foreground audit
#   scripts/tooling/check-worktree-layout.sh --quiet   # only print if findings
#   scripts/tooling/check-worktree-layout.sh --count   # just print drift count
#
# Bypass: HAPI_SKIP_WORKTREE_AUDIT=1
set -euo pipefail

if [[ "${HAPI_SKIP_WORKTREE_AUDIT:-}" == "1" ]]; then
    exit 0
fi

QUIET=0
COUNT_ONLY=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --quiet) QUIET=1; shift ;;
        --count) COUNT_ONLY=1; shift ;;
        -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
done

# Use the shared .git dir; works from any worktree.
COMMON_DIR="$(git rev-parse --git-common-dir 2>/dev/null || true)"
[[ -z "$COMMON_DIR" ]] && exit 0

# Anchor on the main mirror dir (parent of .git, or whatever common-dir resolves into).
COMMON_ABS="$(cd "$COMMON_DIR" && pwd)"
PRIMARY_ABS="${HAPI_PRIMARY:-$(dirname "$COMMON_ABS")}"
PRIMARY_ABS="$(cd "$PRIMARY_ABS" && pwd)"

CANONICAL_PREFIXES=(
    "${PRIMARY_ABS}"
    "${PRIMARY_ABS}/driver"
    "${PRIMARY_ABS}/upstream"
    "${PRIMARY_ABS}/worktrees/"
)

is_canonical() {
    local path="$1"
    if [[ "$path" == "$PRIMARY_ABS" ]]; then return 0; fi
    for pfx in "$PRIMARY_ABS/driver" "$PRIMARY_ABS/upstream"; do
        if [[ "$path" == "$pfx" ]]; then return 0; fi
    done
    if [[ "$path" == "$PRIMARY_ABS/worktrees/"* ]]; then return 0; fi
    return 1
}

mapfile -t WORKTREES < <(git -C "$PRIMARY_ABS" worktree list --porcelain 2>/dev/null \
    | awk '/^worktree / { print $2 }')

total="${#WORKTREES[@]}"
drift=()
for wt in "${WORKTREES[@]}"; do
    if ! is_canonical "$wt"; then
        drift+=("$wt")
    fi
done

if [[ "$COUNT_ONLY" -eq 1 ]]; then
    echo "${#drift[@]}"
    exit 0
fi

if [[ "${#drift[@]}" -eq 0 ]]; then
    [[ "$QUIET" -eq 1 ]] || echo "worktree-layout: ${total} worktree(s), all in canonical layout"
    exit 0
fi

{
    echo "worktree-layout: ${#drift[@]} of ${total} worktree(s) live outside canonical layout:"
    for path in "${drift[@]}"; do
        echo "  $path"
    done
    echo ""
    echo "  Canonical layout (since 2026-06-01):"
    echo "    ${PRIMARY_ABS}/{driver,upstream,worktrees/<name>}"
    echo ""
    echo "  These may be legacy (pre-reorg) or accidental wrong-place creation."
    echo "  New 'git worktree add' is now blocked at the PATH-shim layer (~/.local/bin/git)"
    echo "  via scripts/tooling/git-shim-worktree-guard.sh - if any of the above were created"
    echo "  AFTER 2026-06-01, someone bypassed the shim (HAPI_SKIP_WORKTREE_GUARD=1) or used"
    echo "  /usr/bin/git directly. Investigate."
    echo ""
    echo "  Plan: docs/plans/2026-06-01-hapi-folders-reorganization.md"
    echo "  Use 'hapi-worktree-create' (defaults to canonical path) for new worktrees."
    echo "  To move a legacy one: git worktree move <old> ${PRIMARY_ABS}/worktrees/<name>"
    echo "  Bypass once: HAPI_SKIP_WORKTREE_AUDIT=1"
} >&2

exit 0

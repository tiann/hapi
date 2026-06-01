#!/usr/bin/env bash
# Create a PR formulation worktree, in the canonical location.
#
# CANONICAL LAYOUT (2026-06-01 onward):
#   ~/coding/hapi/                 main mirror, branch=main
#   ~/coding/hapi/worktrees/<name> NEW worktrees go here (default)
#   ~/coding/hapi/driver           the daily-driver soup worktree (already exists)
#   ~/coding/hapi/upstream         clean upstream-main worktree (already exists)
#   ~/coding/hapi/active           symlink, points at one of the above
#
# Pre-2026-06-01 worktrees still live at ~/coding/hapi-<name>/ during Phase 2 drain.
# See docs/plans/2026-06-01-hapi-folders-reorganization.md.
#
# Usage:
#   hapi-worktree-create <name> --branch <branch-name> [--after branch:foo] [--after pr:692] ...
#   hapi-worktree-create pluggable-voice --branch feat/pluggable-voice-backend
#   hapi-worktree-create stacked-foo --branch feat/foo --after feat/pluggable-voice-backend
#
# Flags:
#   --at top              (DEPRECATED) Create at ~/coding/hapi-<name>/ legacy location.
#                         Will warn loudly. Do not use for new work.
#
set -euo pipefail

PRIMARY="${HAPI_PRIMARY:-$HOME/coding/hapi}"
BUN="${BUN:-$HOME/.bun/bin/bun}"
BASE="${HAPI_WORKTREE_BASE:-upstream/main}"
WORKTREE_ROOT="${HAPI_WORKTREE_ROOT:-$PRIMARY/worktrees}"
NAME=""
BRANCH=""
AT_TOP=0
AFTER=()

usage() {
    sed -n '2,22p' "$0"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --branch) BRANCH="${2:?}"; shift 2 ;;
        --base) BASE="${2:?}"; shift 2 ;;
        --after) AFTER+=("${2:?}"); shift 2 ;;
        --at)
            case "${2:?}" in
                top) AT_TOP=1; shift 2 ;;
                canonical|worktrees) AT_TOP=0; shift 2 ;;
                *) echo "ERROR: --at takes 'top' (deprecated) or 'canonical'" >&2; exit 2 ;;
            esac
            ;;
        -h|--help) usage; exit 0 ;;
        -*) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
        *)
            if [[ -z "$NAME" ]]; then NAME="$1"; shift
            else echo "Unexpected arg: $1" >&2; exit 2; fi
            ;;
    esac
done

[[ -n "$NAME" ]] || { echo "Usage: hapi-worktree-create <name> --branch <branch> [--after ref...]" >&2; exit 2; }
[[ -n "$BRANCH" ]] || { echo "ERROR: --branch required" >&2; exit 2; }

if [[ "$AT_TOP" == "1" ]]; then
    PATH_DIR="$HOME/coding/hapi-${NAME}"
    echo "WARN: --at top is deprecated; new worktrees should live in $WORKTREE_ROOT/" >&2
    echo "WARN: see docs/plans/2026-06-01-hapi-folders-reorganization.md" >&2
else
    mkdir -p "$WORKTREE_ROOT"
    PATH_DIR="$WORKTREE_ROOT/${NAME}"
fi
HUB_ENV="$HOME/.hapi/hub.env"

if [[ -e "$PATH_DIR" ]]; then
    echo "ERROR: path already exists: $PATH_DIR" >&2
    exit 1
fi

if git -C "$PRIMARY" show-ref --verify --quiet "refs/heads/$BRANCH"; then
    echo "ERROR: branch $BRANCH already exists locally — pick a new branch name or use existing worktree" >&2
    exit 1
fi

echo "Fetching upstream..."
git -C "$PRIMARY" fetch upstream

echo "Creating worktree $PATH_DIR (branch $BRANCH from $BASE)..."
git -C "$PRIMARY" worktree add -b "$BRANCH" "$PATH_DIR" "$BASE"

ln -sfn "$HUB_ENV" "$PATH_DIR/hub/.env"

resolve_after_ref() {
    local spec="$1"
    if [[ "$spec" =~ ^pr:([0-9]+)$ ]]; then
        local pr="${BASH_REMATCH[1]}"
        local pr_repo="${HAPI_PR_REPO:-tiann/hapi}"
        local head
        head="$(gh pr view "$pr" --repo "$pr_repo" --json headRefName --jq '.headRefName')"
        git -C "$PRIMARY" fetch origin "$head" 2>/dev/null || true
        echo "origin/$head"
    else
        if git -C "$PRIMARY" rev-parse --verify "${spec}^{commit}" >/dev/null 2>&1; then
            echo "$spec"
        else
            echo "ERROR: --after ref not found: $spec" >&2
            exit 1
        fi
    fi
}

for spec in "${AFTER[@]}"; do
    ref="$(resolve_after_ref "$spec")"
    echo "Merge train: merging $ref into $BRANCH ..."
    if ! git -C "$PATH_DIR" merge --no-edit "$ref"; then
        echo "ERROR: merge conflict for --after $spec" >&2
        echo "Resolve in $PATH_DIR and commit." >&2
        exit 1
    fi
done

echo ""
echo "Worktree ready: $PATH_DIR"
echo "Branch: $BRANCH"
echo "  cd $PATH_DIR"
echo "  git branch --show-current   # confirm before commit/PR"
echo ""
echo "Test on live hub (restarts service): hapi-use-worktree $PATH_DIR"

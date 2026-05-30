#!/usr/bin/env bash
# Sync fork main with upstream/main, keeping fork-only commits on top.
#
# Fork main should always be: upstream/main + operator docs/plans (never product-only drift).
#
# Usage:
#   hapi-sync-fork-main              # fetch + merge if behind
#   hapi-sync-fork-main --check-only # exit 1 if primary main is behind upstream
#   hapi-sync-fork-main --rebase     # rebase fork-only commits onto upstream (linear history)
#
set -euo pipefail

PRIMARY="${HAPI_PRIMARY:-$HOME/coding/hapi}"
UPSTREAM_REF="${HAPI_UPSTREAM_REF:-upstream/main}"
MAIN_BRANCH="${HAPI_MAIN_BRANCH:-main}"

CHECK_ONLY=0
USE_REBASE=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --check-only) CHECK_ONLY=1; shift ;;
        --rebase) USE_REBASE=1; shift ;;
        -h|--help)
            sed -n '2,12p' "$0"
            exit 0
            ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
done

if [[ ! -d "$PRIMARY/.git" ]]; then
    echo "ERROR: not a git repo: $PRIMARY" >&2
    exit 1
fi

echo "Fetching upstream..."
git -C "$PRIMARY" fetch upstream

if ! git -C "$PRIMARY" show-ref --verify --quiet "refs/remotes/$UPSTREAM_REF"; then
    echo "ERROR: missing $UPSTREAM_REF" >&2
    exit 1
fi

behind="$(git -C "$PRIMARY" rev-list --count "$MAIN_BRANCH..$UPSTREAM_REF" 2>/dev/null || echo 0)"
ahead="$(git -C "$PRIMARY" rev-list --count "$UPSTREAM_REF..$MAIN_BRANCH" 2>/dev/null || echo 0)"

echo "fork $MAIN_BRANCH: ${ahead} ahead, ${behind} behind $UPSTREAM_REF"

if [[ "$behind" -eq 0 ]]; then
    echo "OK: $PRIMARY $MAIN_BRANCH is up to date with $UPSTREAM_REF"
    exit 0
fi

if [[ "$CHECK_ONLY" -eq 1 ]]; then
    echo "FAIL: $PRIMARY $MAIN_BRANCH is $behind commit(s) behind $UPSTREAM_REF" >&2
    echo "Run: hapi-sync-fork-main" >&2
    exit 1
fi

if [[ -n "$(git -C "$PRIMARY" status --porcelain)" ]]; then
    echo "ERROR: $PRIMARY has uncommitted changes — stash or commit before sync" >&2
    git -C "$PRIMARY" status --short | head -20
    exit 1
fi

git -C "$PRIMARY" checkout "$MAIN_BRANCH"

if [[ "$USE_REBASE" -eq 1 ]]; then
    echo "Rebasing $MAIN_BRANCH onto $UPSTREAM_REF..."
    git -C "$PRIMARY" rebase "$UPSTREAM_REF"
else
    echo "Merging $UPSTREAM_REF into $MAIN_BRANCH..."
    git -C "$PRIMARY" merge "$UPSTREAM_REF" -m "merge(upstream): sync tiann/hapi main into fork main ($(git -C "$PRIMARY" rev-parse --short "$UPSTREAM_REF"))"
fi

echo ""
echo "Synced: $(git -C "$PRIMARY" log -1 --oneline)"
echo "Next: review ~/.config/hapi/driver-manifest.yaml — drop layers now on upstream/main"
echo "      hapi-driver-rebuild --build-web --verify  (if soup layers changed)"

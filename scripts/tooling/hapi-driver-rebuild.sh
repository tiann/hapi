#!/usr/bin/env bash
# Rebuild ~/coding/hapi-driver from ~/.config/hapi/driver-manifest.yaml
#
# ~/coding/hapi-driver is READ-ONLY between rebuilds — this script is the only
# supported way to change it. Hand-edits and cp-from-other-worktrees are forbidden.
#
# Usage:
#   hapi-driver-rebuild              # rebuild only (no hub restart)
#   hapi-driver-rebuild --build-web  # also rebuild web/dist
#   hapi-driver-rebuild --verify     # run typecheck + test after merge
#   hapi-driver-rebuild --activate   # swing hapi-active + restart hub (DESTRUCTIVE to live sessions)
#
set -euo pipefail

PRIMARY="${HAPI_PRIMARY:-$HOME/coding/hapi}"
DRIVER="${HAPI_DRIVER:-$HOME/coding/hapi-driver}"
MANIFEST="${HAPI_DRIVER_MANIFEST:-$HOME/.config/hapi/driver-manifest.yaml}"
PARSE="$PRIMARY/scripts/tooling/parse-driver-manifest.mjs"
DRIVER_BRANCH="${HAPI_DRIVER_BRANCH:-driver/integration}"
BUN="${BUN:-$HOME/.bun/bin/bun}"

ORIG_ARGS=("$@")
BUILD_WEB=0
VERIFY=0
ACTIVATE=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --build-web) BUILD_WEB=1; shift ;;
        --verify) VERIFY=1; shift ;;
        --activate) ACTIVATE=1; shift ;;
        -h|--help)
            sed -n '2,12p' "$0"
            exit 0
            ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
done

# Concurrency guard + status reporting (see lib/driver-status.sh).
# Bypassable: HAPI_SKIP_DRIVER_LOCK=1 (testing only -- corrupts driver tree
# if two rebuilds collide).
LIB_DIR="$(dirname "$(readlink -f "$0")")/lib"
# shellcheck source=lib/driver-status.sh
source "$LIB_DIR/driver-status.sh"
if [[ "${HAPI_SKIP_DRIVER_LOCK:-}" != "1" ]]; then
    driver_status_init
    driver_status_acquire rebuild
    driver_status_begin rebuild "${ORIG_ARGS[@]}"
    trap 'driver_status_end rebuild "$?" head_sha="$(git -C "$DRIVER" rev-parse --short HEAD 2>/dev/null || echo unknown)" head_subject="$(git -C "$DRIVER" log -1 --format=%s 2>/dev/null || echo unknown)"' EXIT
fi

if [[ ! -f "$MANIFEST" ]]; then
    echo "ERROR: manifest not found: $MANIFEST" >&2
    echo "Copy example: mkdir -p ~/.config/hapi && cp $PRIMARY/docs/tooling/driver-manifest.example.yaml $MANIFEST" >&2
    exit 1
fi

if [[ ! -x "$PARSE" ]] && [[ ! -f "$PARSE" ]]; then
    echo "ERROR: parser missing: $PARSE" >&2
    exit 1
fi

mkdir -p "$(dirname "$MANIFEST")"

echo "Fetching upstream..."
git -C "$PRIMARY" fetch upstream
upstream_tip="$(git -C "$PRIMARY" rev-parse upstream/main 2>/dev/null || true)"

SYNC_SCRIPT="$PRIMARY/scripts/tooling/hapi-sync-fork-main.sh"
if [[ -x "$SYNC_SCRIPT" ]]; then
    if ! "$SYNC_SCRIPT" --check-only 2>/dev/null; then
        echo "ERROR: fork main is behind upstream/main. Run: hapi-sync-fork-main && git push origin main" >&2
        exit 1
    fi
elif git -C "$PRIMARY" show-ref --verify --quiet refs/heads/main; then
    behind_main="$(git -C "$PRIMARY" rev-list --count main..upstream/main 2>/dev/null || echo 0)"
    if [[ "${behind_main:-0}" -gt 0 ]]; then
        echo "ERROR: $PRIMARY main is ${behind_main} commit(s) behind upstream/main" >&2
        echo "       Run: hapi-sync-fork-main" >&2
        exit 1
    fi
fi

if [[ -d "$DRIVER" ]] && [[ -n "$(git -C "$DRIVER" status --porcelain)" ]]; then
    echo "WARNING: $DRIVER has local changes — rebuild will reset the tree (stash or commit them elsewhere first)." >&2
    echo "         Only manifest-driven rebuilds belong on the driver tree. See docs/tooling/driver-soup.md" >&2
fi

if [[ ! -d "$DRIVER" ]]; then
    echo "Creating driver worktree at $DRIVER (branch $DRIVER_BRANCH)..."
    git -C "$PRIMARY" worktree add -b "$DRIVER_BRANCH" "$DRIVER" upstream/main
fi

if [[ ! -e "$DRIVER/hub/.env" ]]; then
    echo "Linking hub/.env → ~/.hapi/hub.env"
    ln -s "$HOME/.hapi/hub.env" "$DRIVER/hub/.env"
fi

manifest_json="$("$BUN" run "$PARSE" "$MANIFEST")"
base_ref="$(echo "$manifest_json" | jq -r '.base')"
layer_count="$(echo "$manifest_json" | jq '.layers | length')"

if [[ "${HAPI_SKIP_DRIVER_LOCK:-}" != "1" ]]; then
    driver_status_set rebuild "manifest_layer_count=$layer_count"
fi

if echo "$manifest_json" | jq -e '.layers[] | select(.ref == "fix/web-scroll-guard-unwrap-race")' >/dev/null; then
    pr722_state="$(gh pr view 722 --repo "${HAPI_PR_REPO:-tiann/hapi}" --json state --jq '.state' 2>/dev/null || true)"
    if [[ "$pr722_state" == "MERGED" ]]; then
        echo "WARNING: upstream PR #722 is merged — drop fix/web-scroll-guard-unwrap-race from $MANIFEST" >&2
    fi
fi

if [[ -n "$upstream_tip" && "$base_ref" == "upstream/main" ]]; then
    echo "Base: upstream/main @ $(git -C "$PRIMARY" log -1 --oneline "$upstream_tip")"
fi

echo "Resetting $DRIVER to $base_ref ($layer_count layer(s))..."
git -C "$DRIVER" checkout -B "$DRIVER_BRANCH" "$base_ref"

resolve_merge_ref() {
    local type="$1" ref="$2"
    case "$type" in
        branch|integrate)
            if git -C "$PRIMARY" rev-parse --verify "${ref}^{commit}" >/dev/null 2>&1; then
                echo "$ref"
            else
                echo "ERROR: layer ref not found: $ref" >&2
                exit 1
            fi
            ;;
        pr)
            local head_branch pr_repo="${HAPI_PR_REPO:-tiann/hapi}"
            head_branch="$(gh pr view "$ref" --repo "$pr_repo" --json headRefName --jq '.headRefName' 2>/dev/null || true)"
            if [[ -z "$head_branch" || "$head_branch" == "null" ]]; then
                echo "ERROR: could not resolve PR #$ref via gh (repo: $pr_repo)" >&2
                exit 1
            fi
            git -C "$PRIMARY" fetch origin "$head_branch" 2>/dev/null || true
            echo "origin/$head_branch"
            ;;
        *)
            echo "ERROR: unknown layer type: $type" >&2
            exit 1
            ;;
    esac
}

for i in $(seq 0 $((layer_count - 1))); do
    type="$(echo "$manifest_json" | jq -r ".layers[$i].type")"
    ref="$(echo "$manifest_json" | jq -r ".layers[$i].ref")"
    merge_ref="$(resolve_merge_ref "$type" "$ref")"

    echo "Layer $((i + 1))/$layer_count: merging $merge_ref ..."
    if ! git -C "$DRIVER" merge --no-edit "$merge_ref"; then
        echo "ERROR: merge conflict merging $merge_ref into $DRIVER_BRANCH" >&2
        echo "Resolve in $DRIVER, commit, or fix manifest order." >&2
        exit 1
    fi
done

echo "Driver HEAD: $(git -C "$DRIVER" log -1 --oneline)"

if [[ "$BUILD_WEB" -eq 1 ]] || [[ ! -f "$DRIVER/web/dist/index.html" ]]; then
    echo "Building web..."
    if [[ ! -d "$DRIVER/node_modules" ]]; then
        echo "Installing dependencies (first driver build)..."
        (cd "$DRIVER" && "$BUN" install)
    fi
    (cd "$DRIVER/web" && "$BUN" run build)
fi

if [[ "$VERIFY" -eq 1 ]]; then
    echo "Running typecheck..."
    (cd "$DRIVER" && "$BUN" typecheck)
    echo "Running tests..."
    (cd "$DRIVER" && "$BUN" run test)
fi

echo ""
echo "Driver rebuild complete: $DRIVER @ $(git -C "$DRIVER" rev-parse --short HEAD)"
echo "Manifest: $MANIFEST"
echo "Active hub: $(readlink -f "$HOME/coding/hapi-active" 2>/dev/null || echo '(no symlink)')"

if [[ "$ACTIVATE" -eq 1 ]]; then
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  ACTIVATE: restarts hapi-hub + hapi-runner (kills sessions)"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    if [[ -t 0 ]]; then
        read -rp "Proceed with hapi-use-worktree $DRIVER? [y/N] " yn
        [[ "${yn,,}" == "y" ]] || { echo "Skipped activate."; exit 0; }
    else
        echo "Non-interactive: skipping activate (re-run with TTY or use hapi-use-worktree manually)." >&2
        exit 0
    fi
    # Hand off to the switch script. The EXIT trap won't fire under exec, so
    # close the rebuild as successful here (head_sha is known good) and let
    # use-worktree own the switch lock + status from here on.
    if [[ "${HAPI_SKIP_DRIVER_LOCK:-}" != "1" ]]; then
        driver_status_end rebuild 0 \
            head_sha="$(git -C "$DRIVER" rev-parse --short HEAD 2>/dev/null || echo unknown)" \
            head_subject="$(git -C "$DRIVER" log -1 --format=%s 2>/dev/null || echo unknown)"
        trap - EXIT
        eval "exec ${_HAPI_LOCK_FD_REBUILD}>&-"
    fi
    exec hapi-use-worktree "$DRIVER"
fi

echo ""
echo "To swing live hub (restarts service — kills sessions):"
echo "  hapi-use-worktree $DRIVER"

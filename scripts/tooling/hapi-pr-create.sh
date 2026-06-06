#!/usr/bin/env bash
# hapi-pr-create  -  Thin gate in front of `gh pr create` for upstream PRs.
#
# Enforces (before calling gh):
#   1. Current branch is not main / driver/integration / upstream-main-test / garden/r3f-poc
#   2. Current branch has ancestry with upstream/main (branched correctly, not from driver)
#   3. Outgoing diff against upstream/main is leak-clean (check-operator-leaks.sh)
#   4. Body has a closes-keyword (Closes/Fixes/Resolves #N or OWNER/REPO#N)
#      OR --no-closes-required is set explicitly (e.g. spike PRs, discussion-only links)
#   5. Body itself is leak-clean
#
# Defaults injected when not provided:
#   --repo tiann/hapi
#   --base main
#   --head heavygee:<current-branch>
#
# All other args pass through to `gh pr create`.
#
# Usage:
#   hapi-pr-create --title "fix(x): y" --body-file body.md
#   hapi-pr-create --title "feat(x): y" --body-file body.md --draft
#   hapi-pr-create --title "spike: x" --body-file body.md --no-closes-required
#
# Env overrides (use sparingly, log a reason):
#   HAPI_PR_CREATE_NO_CLOSES=1   bypass closes-keyword check
#   HAPI_PR_CREATE_NO_LEAK_SCAN=1   bypass leak scan (also sets HAPI_ALLOW_OPERATOR_LEAK)

set -euo pipefail

INFRA_BRANCHES=("main" "driver/integration" "upstream-main-test" "garden/r3f-poc")
UPSTREAM_REPO_DEFAULT="tiann/hapi"
BASE_DEFAULT="main"
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$ROOT" ]]; then
  echo "hapi-pr-create: not in a git repo" >&2
  exit 2
fi
cd "$ROOT"

# Resolve the leak script via this wrapper's own location (the wrapper lives in
# the operator's main repo tree; PR-branch worktrees branched from upstream/main
# don't carry the tooling/ directory).
WRAPPER_REAL="$(readlink -f "$0")"
WRAPPER_DIR="$(dirname "$WRAPPER_REAL")"
LEAK_SCRIPT="$WRAPPER_DIR/check-operator-leaks.sh"
if [[ ! -x "$LEAK_SCRIPT" ]]; then
  echo "hapi-pr-create: missing $LEAK_SCRIPT" >&2
  exit 2
fi

# ----- args (we peek at a few; rest pass through) -----
ARGS=("$@")
TITLE=""
BODY_FILE=""
BODY_TEXT=""
REPO=""
BASE=""
HEAD=""
NO_CLOSES=${HAPI_PR_CREATE_NO_CLOSES:-0}

i=0
while [[ $i -lt ${#ARGS[@]} ]]; do
  case "${ARGS[$i]}" in
    --title)      TITLE="${ARGS[$((i+1))]}"; i=$((i+2));;
    --body-file)  BODY_FILE="${ARGS[$((i+1))]}"; i=$((i+2));;
    --body)       BODY_TEXT="${ARGS[$((i+1))]}"; i=$((i+2));;
    --repo)       REPO="${ARGS[$((i+1))]}"; i=$((i+2));;
    --base)       BASE="${ARGS[$((i+1))]}"; i=$((i+2));;
    --head)       HEAD="${ARGS[$((i+1))]}"; i=$((i+2));;
    --no-closes-required)
                  NO_CLOSES=1
                  # strip this flag so it doesn't reach gh
                  ARGS=("${ARGS[@]:0:$i}" "${ARGS[@]:$((i+1))}")
                  ;;
    *) i=$((i+1));;
  esac
done

if [[ -z "$TITLE" ]]; then
  echo "hapi-pr-create: --title is required" >&2
  exit 2
fi
if [[ -z "$BODY_FILE" && -z "$BODY_TEXT" ]]; then
  echo "hapi-pr-create: --body-file or --body is required (no interactive composition; create a body file)" >&2
  exit 2
fi

# ----- check 1: branch sanity -----
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ -z "$BRANCH" || "$BRANCH" == "HEAD" ]]; then
  echo "hapi-pr-create: detached HEAD - check out a branch first" >&2
  exit 2
fi
for ib in "${INFRA_BRANCHES[@]}"; do
  if [[ "$BRANCH" == "$ib" ]]; then
    echo "hapi-pr-create: refuse to open PR from infra branch '$BRANCH'" >&2
    echo "  create a new branch off upstream/main and try again" >&2
    exit 2
  fi
done

# ----- check 2: branch must have ancestry with upstream/main, not driver/integration -----
git fetch upstream main --quiet 2>/dev/null || true
if ! git merge-base --is-ancestor "$(git merge-base upstream/main "$BRANCH")" upstream/main 2>/dev/null; then
  echo "hapi-pr-create: cannot find merge-base with upstream/main for '$BRANCH'" >&2
  echo "  was this branched from driver/integration? upstream PRs must be off upstream/main" >&2
  exit 2
fi
# Soft warning: branch should not have many driver/integration-only commits
if git merge-base --is-ancestor driver/integration "$BRANCH" 2>/dev/null; then
  echo "hapi-pr-create: '$BRANCH' includes all of driver/integration in its history" >&2
  echo "  this is almost certainly wrong for an upstream PR. abort." >&2
  exit 2
fi

# ----- check 3: outgoing diff leak scan -----
if [[ "${HAPI_PR_CREATE_NO_LEAK_SCAN:-0}" != "1" ]]; then
  if ! "$LEAK_SCRIPT" --git-range upstream/main HEAD 2>&1; then
    echo "hapi-pr-create: outgoing diff has operator-leak hits (see above)" >&2
    echo "  fix the diff or set HAPI_PR_CREATE_NO_LEAK_SCAN=1 if you understand the risk" >&2
    exit 2
  fi
fi

# ----- check 4 + 5: body content -----
if [[ -n "$BODY_FILE" ]]; then
  if [[ ! -f "$BODY_FILE" ]]; then
    echo "hapi-pr-create: --body-file '$BODY_FILE' does not exist" >&2
    exit 2
  fi
  BODY=$(cat "$BODY_FILE")
else
  BODY="$BODY_TEXT"
fi

# body leak scan
if [[ "${HAPI_PR_CREATE_NO_LEAK_SCAN:-0}" != "1" ]]; then
  if ! printf '%s' "$BODY" | "$LEAK_SCRIPT" --stdin 2>&1; then
    echo "hapi-pr-create: body has operator-leak hits (see above)" >&2
    exit 2
  fi
fi

# closes-keyword check
if [[ "$NO_CLOSES" != "1" ]]; then
  if ! echo "$BODY" | grep -qiE '(closes?|fixes?|resolves?)[[:space:]]+([a-zA-Z0-9/_.-]+)?#[0-9]+'; then
    echo "hapi-pr-create: body has no closes-keyword (Closes/Fixes/Resolves #N)" >&2
    echo "  add 'Closes #N' so the linked issue auto-closes on merge" >&2
    echo "  if this PR genuinely links a discussion or has no issue, pass --no-closes-required" >&2
    exit 2
  fi
fi

# ----- inject defaults -----
HAS_REPO=0; HAS_BASE=0; HAS_HEAD=0
for a in "${ARGS[@]}"; do
  case "$a" in
    --repo) HAS_REPO=1;;
    --base) HAS_BASE=1;;
    --head) HAS_HEAD=1;;
  esac
done

if [[ $HAS_REPO -eq 0 ]]; then
  ARGS=("--repo" "$UPSTREAM_REPO_DEFAULT" "${ARGS[@]}")
fi
if [[ $HAS_BASE -eq 0 ]]; then
  ARGS=("--base" "$BASE_DEFAULT" "${ARGS[@]}")
fi
if [[ $HAS_HEAD -eq 0 ]]; then
  ARGS=("--head" "heavygee:$BRANCH" "${ARGS[@]}")
fi

# ----- exec -----
echo "hapi-pr-create: all checks passed; calling gh pr create" >&2
echo "  branch: $BRANCH" >&2
echo "  target: ${REPO:-$UPSTREAM_REPO_DEFAULT}:${BASE:-$BASE_DEFAULT}" >&2
exec gh pr create "${ARGS[@]}"

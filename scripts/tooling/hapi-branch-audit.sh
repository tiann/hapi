#!/usr/bin/env bash
# hapi-branch-audit  -  Verify every local branch maps to one tracked item.
#
# READ-ONLY. Never deletes branches, never edits PRs. Just reports.
#
# Classifications:
#   OK              has open upstream PR + closingIssuesReferences (auto-close on merge)
#   OK-LINKED       has open upstream PR + #N refs in body (e.g. discussion link, no auto-close)
#   NO-LINKS        has open upstream PR but body has no #N refs anywhere -> action required
#   FORK-PR         has open PR on heavygee/hapi only (fork-internal staging)
#   INFRA           main / driver/integration / upstream-main-test / garden/r3f-poc
#   MERGED          PR is merged upstream -> delete candidate
#   NO-TRACKING     no PR anywhere -> spike-or-kill (likely abandoned WIP)
#   STALE-BEHIND    >N days or >M commits behind upstream/main (bitrot risk)
#   DETACHED-WT     worktree path doesn't match canonical layout
#
# Exit codes:
#   0  - no branches need attention (or --quiet and only OK/INFRA rows)
#   1  - one or more branches flagged (MERGED, NO-TRACKING, STALE-BEHIND, DETACHED-WT)
#   2  - usage / setup error
#
# Usage:
#   hapi-branch-audit                 # human-readable table, all branches
#   hapi-branch-audit --quiet         # only show branches needing action; exit non-zero if any
#   hapi-branch-audit --json          # machine-readable; pipe through jq
#   hapi-branch-audit --on-merge      # post-merge hook mode (only emits if action needed)
#   hapi-branch-audit --skip-fetch    # don't fetch upstream first (faster, may be stale)

set -euo pipefail

# ----- config -----
INFRA_BRANCHES=("main" "driver/integration" "upstream-main-test" "garden/r3f-poc")
STALE_THRESHOLD_DAYS=10
STALE_THRESHOLD_COMMITS=30
UPSTREAM_REPO="tiann/hapi"
FORK_REPO="heavygee/hapi"
WORKTREE_ROOT_RE='^/home/heavygee/coding/hapi/(driver|upstream|worktrees/[^/]+)$'

# ----- args -----
FORMAT=table
QUIET=0
ON_MERGE=0
FETCH=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json)        FORMAT=json; shift;;
    --quiet)       QUIET=1; shift;;
    --on-merge)    ON_MERGE=1; QUIET=1; shift;;
    --skip-fetch)  FETCH=0; shift;;
    -h|--help)
      sed -n '2,/^set -euo/p' "$0" | sed 's/^# \?//' | head -40
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$ROOT" ]]; then
  echo "hapi-branch-audit: not in a git repo" >&2
  exit 2
fi
cd "$ROOT"

# ----- fetch upstream so ahead/behind is accurate -----
if [[ $FETCH -eq 1 ]]; then
  git fetch upstream main --quiet 2>/dev/null || true
fi

# ----- fetch all PRs once each -----
if ! command -v gh >/dev/null 2>&1; then
  echo "hapi-branch-audit: gh CLI required" >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "hapi-branch-audit: jq required" >&2
  exit 2
fi

UPSTREAM_PRS=$(gh pr list --repo "$UPSTREAM_REPO" --state all --limit 200 \
  --author heavygee \
  --json number,title,state,headRefName,closingIssuesReferences,mergedAt 2>/dev/null || echo '[]')
FORK_PRS=$(gh pr list --repo "$FORK_REPO" --state all --limit 100 \
  --json number,title,state,headRefName,closingIssuesReferences,mergedAt 2>/dev/null || echo '[]')

# ----- per-branch evaluation -----
emit_json_open=0
[[ $FORMAT == json ]] && { echo "["; }

ACTION_COUNT=0
ROW_COUNT=0
first_row=1

print_row() {
  local branch=${1:-} status=${2:-} pr=${3:-} closes=${4:-} ab=${5:-} action=${6:-}
  if [[ $FORMAT == json ]]; then
    [[ $first_row -eq 0 ]] && echo ","
    first_row=0
    jq -nc --arg b "$branch" --arg s "$status" --arg p "$pr" --arg c "$closes" \
          --arg a "$ab" --arg ac "$action" \
       '{branch:$b, status:$s, pr:$p, closes:$c, ahead_behind:$a, action:$ac}'
  else
    printf "  %-45s  %-13s  %-10s  %-14s  %-10s  %s\n" \
      "$branch" "$status" "$pr" "$closes" "$ab" "$action"
  fi
}

if [[ $FORMAT == table && $QUIET -eq 0 ]]; then
  printf "  %-45s  %-13s  %-10s  %-14s  %-10s  %s\n" \
    "BRANCH" "STATUS" "PR" "TRACKED" "AHEAD/BEH" "ACTION"
  printf "  %-45s  %-13s  %-10s  %-14s  %-10s  %s\n" \
    "------" "------" "--" "-------" "---------" "------"
fi

worktree_for_branch() {
  local b=$1
  git worktree list --porcelain | awk -v b="$b" '
    /^worktree /{wt=$2}
    /^branch /{ref=$2; if(ref=="refs/heads/"b) print wt
  }'
}

while read -r branch; do
  ROW_COUNT=$((ROW_COUNT+1))

  # infra short-circuit
  is_infra=0
  for ib in "${INFRA_BRANCHES[@]}"; do
    [[ "$branch" == "$ib" ]] && is_infra=1 && break
  done

  ahead=$(git rev-list --count upstream/main..refs/heads/"$branch" 2>/dev/null || echo "?")
  behind=$(git rev-list --count refs/heads/"$branch"..upstream/main 2>/dev/null || echo "?")
  ab="$ahead/$behind"

  wt_path=$(worktree_for_branch "$branch" | head -1)
  wt_status="-"
  if [[ -n "$wt_path" ]]; then
    if [[ "$wt_path" =~ $WORKTREE_ROOT_RE ]]; then
      wt_status="OK"
    else
      wt_status="DETACHED"
    fi
  fi

  if [[ $is_infra -eq 1 ]]; then
    [[ $QUIET -eq 0 ]] && print_row "$branch" "INFRA" "-" "-" "$ab" "(infra)"
    continue
  fi

  upstream_pr=$(echo "$UPSTREAM_PRS" | jq -r --arg b "$branch" '
    [.[] | select(.headRefName == $b)] | sort_by(.number) | last // empty')
  fork_pr=$(echo "$FORK_PRS" | jq -r --arg b "$branch" '
    [.[] | select(.headRefName == $b)] | sort_by(.number) | last // empty')

  pr_num="-"; pr_state="-"; closes="-"; status="?"; action=""

  if [[ -n "$upstream_pr" ]]; then
    pr_num="#$(echo "$upstream_pr" | jq -r '.number')"
    pr_state=$(echo "$upstream_pr" | jq -r '.state')
    closing_refs=$(echo "$upstream_pr" | jq -r '[.closingIssuesReferences[].number] | map("#"+tostring) | join(",")')
    if [[ "$pr_state" == "MERGED" ]]; then
      status="MERGED"
      closes="${closing_refs:-(none)}"
      action="DELETE: PR merged $(echo "$upstream_pr" | jq -r '.mergedAt' | cut -c1-10)"
    elif [[ -z "$closing_refs" ]]; then
      body_refs=$(gh pr view "$(echo "$upstream_pr" | jq -r '.number')" --repo "$UPSTREAM_REPO" \
        --json body --jq '.body' 2>/dev/null | grep -oE '#[0-9]+' | sort -u | head -3 | tr '\n' ',' | sed 's/,$//')
      if [[ -n "$body_refs" ]]; then
        status="OK-LINKED"
        closes="$body_refs"
        action=""
      else
        status="NO-LINKS"
        closes="(none)"
        action="link an issue/discussion or file one"
      fi
    else
      status="OK"
      closes="$closing_refs"
      action=""
    fi
  elif [[ -n "$fork_pr" ]]; then
    pr_num="fork#$(echo "$fork_pr" | jq -r '.number')"
    pr_state=$(echo "$fork_pr" | jq -r '.state')
    if [[ "$pr_state" == "MERGED" || "$pr_state" == "CLOSED" ]]; then
      status="MERGED"
      action="DELETE: fork PR $pr_state"
    else
      status="FORK-PR"
      closes=$(echo "$fork_pr" | jq -r '[.closingIssuesReferences[].number] | map("fork#"+tostring) | join(",")')
      [[ -z "$closes" ]] && closes="-"
      action="promote to upstream PR or close"
    fi
  else
    status="NO-TRACKING"
    action="file upstream issue, push branch, open PR  -  or kill"
  fi

  # staleness override
  if [[ "$behind" =~ ^[0-9]+$ ]] && (( behind > STALE_THRESHOLD_COMMITS )); then
    if [[ "$status" == "OK" || "$status" == "OK-LINKED" || "$status" == "FORK-PR" ]]; then
      status="STALE-BEHIND"
      [[ -z "$action" ]] && action="rebase on upstream/main ($behind commits behind)"
    fi
  fi

  if [[ "$wt_status" == "DETACHED" ]]; then
    [[ -z "$action" ]] && action="worktree at non-canonical path: $wt_path"
  fi

  # decide whether to emit in quiet mode
  needs_action=0
  case "$status" in
    MERGED|NO-TRACKING|NO-LINKS|STALE-BEHIND|FORK-PR) needs_action=1;;
  esac
  [[ "$wt_status" == "DETACHED" ]] && needs_action=1

  if [[ $needs_action -eq 1 ]]; then
    ACTION_COUNT=$((ACTION_COUNT+1))
  fi

  if [[ $QUIET -eq 0 || $needs_action -eq 1 ]]; then
    print_row "$branch" "$status" "$pr_num" "$closes" "$ab" "$action"
  fi
done < <(git for-each-ref --format='%(refname:short)' refs/heads/ | sort)

[[ $FORMAT == json ]] && echo -e "\n]"

# ----- exit -----
if [[ $ON_MERGE -eq 1 && $ACTION_COUNT -gt 0 ]]; then
  echo "" >&2
  echo "  hapi-branch-audit: $ACTION_COUNT branch(es) need attention (run 'hapi-branch-audit' for full table)" >&2
fi

if [[ $ACTION_COUNT -gt 0 ]]; then
  exit 1
fi
exit 0

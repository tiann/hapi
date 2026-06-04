#!/usr/bin/env bash
# hapi-pr-status — comprehensive PR hygiene check
#
# Usage: hapi-pr-status <PR_NUMBER> [--repo owner/repo]
#
# Checks three dimensions that must ALL pass before a PR is "clean":
#   1. CI checks    — gh pr checks (did the bot workflow pass on the latest commit?)
#   2. Threads      — zero unresolved review threads (gh pr checks does NOT cover these)
#   3. Bot verdict  — latest bot review summary explicitly says "No findings"
#
# Background: the bot posts NEW inline threads on every push rather than updating
# old ones. gh pr checks only reflects whether the CI check workflow passed on the
# latest commit. A PR with checks=green can still have 20 unresolved bot threads
# from earlier pushes. This script is the single source of truth.

set -euo pipefail

PR="${1:-}"
if [[ -z "$PR" ]]; then
    echo "Usage: hapi-pr-status <PR_NUMBER> [--repo owner/repo]" >&2
    exit 1
fi
shift

REPO="${HAPI_PR_REPO:-tiann/hapi}"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --repo) REPO="$2"; shift 2 ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

OWNER="$(echo "$REPO" | cut -d/ -f1)"
NAME="$(echo "$REPO"  | cut -d/ -f2)"

PASS=0  # 0 = all good so far
CHECKS_OK=true
THREADS_OK=true
BOT_OK=true

echo ""
echo "  PR #${PR} — ${REPO}"
echo "  ══════════════════════════════════════"

# ── 1. CI checks ────────────────────────────────────────────────────────────
echo ""
echo "  1. CI checks"
CHECKS_JSON=$(gh pr checks "$PR" --repo "$REPO" --json name,bucket 2>/dev/null || echo "[]")
while IFS= read -r row; do
    cname=$(echo "$row" | jq -r '.name')
    bucket=$(echo "$row" | jq -r '.bucket')
    case "$bucket" in
        pass)                   echo "     ✓ $cname" ;;
        pending|queued|in_progress)
                                echo "     … $cname (running)"
                                CHECKS_OK=false ;;
        *)                      echo "     ✗ $cname ($bucket)"
                                CHECKS_OK=false ;;
    esac
done < <(echo "$CHECKS_JSON" | jq -c '.[]')

if $CHECKS_OK; then echo "     → PASS"; else echo "     → FAIL / PENDING"; PASS=1; fi

# ── 2. Unresolved review threads ────────────────────────────────────────────
echo ""
echo "  2. Unresolved review threads"
UNRESOLVED=$(gh api graphql -f query="
{
  repository(owner: \"${OWNER}\", name: \"${NAME}\") {
    pullRequest(number: ${PR}) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          comments(first: 1) {
            nodes { body }
          }
        }
      }
    }
  }
}" --jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false)]')

COUNT=$(echo "$UNRESOLVED" | jq 'length')
if [[ "$COUNT" -eq 0 ]]; then
    echo "     ✓ 0 unresolved threads"
    echo "     → PASS"
else
    echo "     ✗ ${COUNT} unresolved thread(s):"
    echo "$UNRESOLVED" | jq -r '.[] | "       · [" + .id + "]  " + .comments.nodes[0].body[0:90]'
    echo "     → FAIL"
    THREADS_OK=false
    PASS=1
fi

# ── 3. Latest bot review verdict ─────────────────────────────────────────────
echo ""
echo "  3. Latest bot review"
LATEST_BOT=$(gh api "repos/${REPO}/pulls/${PR}/reviews" --paginate \
    --jq '[.[] | select(.user.login == "github-actions[bot]")] | sort_by(.submitted_at) | reverse | .[0]' 2>/dev/null || echo "null")

if [[ "$LATEST_BOT" == "null" || -z "$LATEST_BOT" ]]; then
    echo "     ? No bot review found"
    echo "     → UNKNOWN"
    BOT_OK=false
    PASS=1
else
    SUBMITTED=$(echo "$LATEST_BOT" | jq -r '.submitted_at')
    SNIPPET=$(echo "$LATEST_BOT" | jq -r '.body[0:300]')
    echo "     Last run: ${SUBMITTED}"
    echo "$SNIPPET" | sed 's/^/     /'
    if echo "$SNIPPET" | grep -qE "No findings|No high-confidence|No issues found|No actionable"; then
        echo "     → PASS"
    else
        echo "     → FINDINGS PRESENT"
        BOT_OK=false
        PASS=1
    fi
fi

# ── Verdict ──────────────────────────────────────────────────────────────────
echo ""
echo "  ══════════════════════════════════════"
if [[ "$PASS" -eq 0 ]]; then
    echo "  ✅  PR #${PR} is CLEAN — all three dimensions pass"
else
    echo "  ❌  PR #${PR} is NOT clean:"
    $CHECKS_OK  || echo "     • CI checks failing or pending"
    $THREADS_OK || echo "     • ${COUNT} unresolved review thread(s) — resolve with GraphQL resolveReviewThread mutation"
    $BOT_OK     || echo "     • Bot review has findings or is absent"
fi
echo "  ══════════════════════════════════════"
echo ""

exit "$PASS"

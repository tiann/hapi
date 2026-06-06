#!/usr/bin/env bash
# hapi-pr-reply: atomically reply to a PR review comment AND resolve its thread.
#
# Background: this project's protocol (`~/coding/AGENTS.local.md` §"Responding
# to PR review comments") requires that addressed bot/reviewer findings be
# answered via REPLIES TO THE THREAD plus `resolveReviewThread` graphql
# mutation - NOT via top-level PR comments. Top-level comments silently
# bypass the bot's review loop and bury real findings.
#
# This wrapper makes the correct flow as easy as the wrong flow used to be.
# It looks up the GraphQL thread node id for the given review-comment
# database id, POSTs the reply, and (on success) resolves the thread.
#
# Usage:
#   hapi-pr-reply [-R owner/repo] <pr_number> <comment_id> <fix_sha> <one_line_body>
#   hapi-pr-reply [-R owner/repo] <pr_number> <comment_id> --skip-sha <one_line_body>
#
# The fix_sha is rendered as "Addressed in <sha>: <one_line_body>".
# Pass `--skip-sha` if the reply is e.g. a clarification question, not a fix.
#
# Postmortem context: PR #814 #issuecomment-4639449666 (2026-06-06) - this
# helper exists because the orchestrator created a top-level comment instead
# of replying to the bot's review threads.

set -euo pipefail

usage() {
    cat <<'EOF' >&2
Usage:
  hapi-pr-reply [-R owner/repo] <pr_number> <comment_id> <fix_sha|--skip-sha> <one_line_body>

Examples:
  hapi-pr-reply 814 3367724860 4a03f42 "Replaced process.argv.slice(2) with getCliArgs()"
  hapi-pr-reply -R tiann/hapi 814 3367724864 4a03f42 "New handoff protocol; parent releases lock pre-wait"
  hapi-pr-reply 814 3367199612 --skip-sha "Disagree - this is a deliberate behavior, see <link>"

Notes:
  - <comment_id> is the REST review-comment id (numeric, not the URL fragment).
    Find it with: gh api repos/<owner>/<repo>/pulls/<pr>/comments --jq '.[] | "\(.id) \(.path):\(.line) \(.body[:80])"'
  - Without -R, uses the repo gh defaults to (per `gh repo set-default`).
  - On success: prints the reply URL and confirms thread.isResolved=true.
EOF
    exit 2
}

repo_flag=()
if [ "${1:-}" = "-R" ] || [ "${1:-}" = "--repo" ]; then
    [ -n "${2:-}" ] || usage
    repo_flag=(-R "$2")
    shift 2
fi

[ "$#" -ge 4 ] || usage

pr="$1"
comment_id="$2"
sha_or_skip="$3"
shift 3
body_oneline="$*"

if [[ ! "$pr" =~ ^[0-9]+$ ]]; then
    echo "[hapi-pr-reply] ERROR: pr_number must be numeric, got: $pr" >&2
    exit 2
fi
if [[ ! "$comment_id" =~ ^[0-9]+$ ]]; then
    echo "[hapi-pr-reply] ERROR: comment_id must be numeric, got: $comment_id" >&2
    exit 2
fi
if [ -z "$body_oneline" ]; then
    echo "[hapi-pr-reply] ERROR: missing one-line body" >&2
    usage
fi

# Resolve owner/repo (either from -R or current repo)
if [ ${#repo_flag[@]} -gt 0 ]; then
    repo_arg="${repo_flag[1]}"
else
    repo_arg=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || true)
fi
if [ -z "$repo_arg" ] || [[ "$repo_arg" != */* ]]; then
    echo "[hapi-pr-reply] ERROR: could not resolve owner/repo. Pass -R owner/repo or run inside a git repo with gh defaults set." >&2
    exit 2
fi
owner="${repo_arg%/*}"
repo="${repo_arg#*/}"

# Construct reply body
if [ "$sha_or_skip" = "--skip-sha" ]; then
    reply_body="$body_oneline"
else
    if [[ ! "$sha_or_skip" =~ ^[0-9a-f]{7,40}$ ]]; then
        echo "[hapi-pr-reply] ERROR: fix_sha looks malformed (expected 7-40 hex chars): $sha_or_skip" >&2
        echo "[hapi-pr-reply]        If you do not have a SHA yet (or this is a discussion reply), pass --skip-sha." >&2
        exit 2
    fi
    reply_body="Addressed in ${sha_or_skip}: ${body_oneline}"
fi

# Look up the GraphQL thread id for this comment so we can resolve it after reply.
echo "[hapi-pr-reply] looking up GraphQL thread for ${owner}/${repo}#${pr} comment_id=${comment_id}..." >&2
thread_id=$(gh api graphql \
    -f query="{ repository(owner:\"$owner\", name:\"$repo\") { pullRequest(number: $pr) { reviewThreads(first: 100) { nodes { id isResolved comments(first:1) { nodes { databaseId } } } } } } }" \
    --jq ".data.repository.pullRequest.reviewThreads.nodes[] | select(.comments.nodes[0].databaseId == ${comment_id}) | .id" \
    2>/dev/null || true)

if [ -z "$thread_id" ]; then
    echo "[hapi-pr-reply] ERROR: could not find a review thread containing comment_id=${comment_id} on ${owner}/${repo}#${pr}." >&2
    echo "[hapi-pr-reply]        Common causes: wrong PR number, comment is a top-level PR comment (not a review thread), or the comment was deleted." >&2
    echo "[hapi-pr-reply]        To list all review comments on this PR:" >&2
    echo "[hapi-pr-reply]          gh api repos/${owner}/${repo}/pulls/${pr}/comments --jq '.[] | \"\\(.id) \\(.path):\\(.line) \\(.body[:80])\"'" >&2
    exit 3
fi
echo "[hapi-pr-reply] thread id: ${thread_id}" >&2

# Post the reply (REST: POST /pulls/{pr}/comments/{cid}/replies).
reply_url=$(gh api -X POST "repos/${owner}/${repo}/pulls/${pr}/comments/${comment_id}/replies" \
    -f body="$reply_body" \
    --jq '.html_url' 2>&1) || {
    echo "[hapi-pr-reply] ERROR: reply POST failed:" >&2
    echo "$reply_url" >&2
    exit 4
}
echo "[hapi-pr-reply] reply posted: ${reply_url}"

# Resolve the thread (graphql mutation).
resolve_state=$(gh api graphql \
    -f query="mutation { resolveReviewThread(input: {threadId: \"${thread_id}\"}) { thread { id isResolved } } }" \
    --jq '.data.resolveReviewThread.thread.isResolved' 2>&1) || {
    echo "[hapi-pr-reply] WARNING: reply succeeded but resolveReviewThread failed - resolve manually:" >&2
    echo "  gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: \"${thread_id}\"}) { thread { id isResolved } } }'" >&2
    echo "$resolve_state" >&2
    exit 5
}

if [ "$resolve_state" = "true" ]; then
    echo "[hapi-pr-reply] thread resolved (isResolved=true)"
else
    echo "[hapi-pr-reply] WARNING: mutation returned isResolved=${resolve_state}; expected true" >&2
    exit 5
fi

# Report remaining unresolved count
remaining=$(gh api graphql \
    -f query="{ repository(owner:\"$owner\", name:\"$repo\") { pullRequest(number: $pr) { reviewThreads(first: 100) { nodes { isResolved } } } } }" \
    --jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false)] | length' \
    2>/dev/null || echo "?")
echo "[hapi-pr-reply] ${owner}/${repo}#${pr}: ${remaining} unresolved thread(s) remaining"

#!/usr/bin/env bash
# hapi-pr-emoji-batch — classify PRs for session emoji (bash, parallel, small gh calls).
#
# No bun. No mega-graphql. Same bot/CI logic as hapi-pr-status, parallelized.
#
# Usage:
#   hapi-pr-emoji-batch.sh [--table] [--repo owner/name] PR [PR...]
#   hapi-pr-emoji-batch.sh --table 941 923 902
#
# Env: HAPI_PR_REPO, HAPI_GH_TIMEOUT_SECS (default 15), HAPI_PR_EMOJI_PARALLEL (default 4)
# Non-TTY / agent shells: serial gh + wall-clock cap (Cursor agent hung 40m+ without this).
#
# Lives on fork main under scripts/tooling/ — commit changes here; do NOT hand-edit hapi-driver.
set -euo pipefail

REPO="${HAPI_PR_REPO:-tiann/hapi}"
TIMEOUT="${HAPI_GH_TIMEOUT_SECS:-15}"
PARALLEL="${HAPI_PR_EMOJI_PARALLEL:-4}"
TABLE=0
PRS=()

export GH_FORCE_TTY=0 GIT_TERMINAL_PROMPT=0 GH_PAGER=cat PAGER=cat

while [[ $# -gt 0 ]]; do
    case "$1" in
        --repo) REPO="$2"; shift 2 ;;
        --timeout) TIMEOUT="$2"; shift 2 ;;
        --table) TABLE=1; shift ;;
        --help|-h) sed -n '2,14p' "$0"; exit 0 ;;
        [0-9]*) PRS+=("$1"); shift ;;
        *) echo "hapi-pr-emoji-batch: unknown arg: $1" >&2; exit 2 ;;
    esac
done

[[ ${#PRS[@]} -gt 0 ]] || { echo "usage: hapi-pr-emoji-batch.sh [--table] PR..." >&2; exit 2; }

if [[ "${HAPI_AGENT_CONTEXT:-}" == 1 || ! -t 1 ]]; then
    PARALLEL=1
    TIMEOUT="${HAPI_GH_TIMEOUT_SECS:-10}"
fi
WALL_LIMIT=$(( $(date +%s) + ${#PRS[@]} * TIMEOUT * 6 + 20 ))

OWNER="${REPO%%/*}"
NAME="${REPO#*/}"
TMPDIR="${TMPDIR:-/tmp}/hapi-pr-emoji-$$"
mkdir -p "$TMPDIR"
trap 'rm -rf "$TMPDIR"' EXIT

gh_t() {
    (( $(date +%s) < WALL_LIMIT )) || { echo "hapi-pr-emoji-batch: wall-clock limit exceeded" >&2; return 124; }
    timeout --foreground -k 3 "${TIMEOUT}s" gh "$@"
}

fetch_latest_bot_body() {
    local n="$1" label
    label="$(gh_t pr view "$n" --repo "$REPO" --json labels \
        --jq '[.labels[].name]|contains(["cold-review-clean"])' 2>/dev/null || echo false)"
    [[ "$label" == "true" ]] && { echo "__CLEAN_LABEL__"; return 0; }
    if [[ "$OWNER" == "heavygee" ]]; then
        gh_t api "repos/${REPO}/issues/${n}/comments" --paginate \
            --jq '[.[]|select(.user.login|test("^chatgpt-codex-connector"))]|sort_by(.created_at)|last|.body//""' \
            2>/dev/null || echo ""
    else
        gh_t api "repos/${REPO}/pulls/${n}/reviews" --paginate \
            --jq '[.[]|select(.user.login=="github-actions[bot]")]|sort_by(.submitted_at)|last|.body//""' \
            2>/dev/null || echo ""
    fi
}

classify_one() {
    local n="$1"
    local out="$TMPDIR/$n.json"
    local checks merge_state pr_state threads bot_body
    local checks_ok=1 checks_pending=0 pr_review_ok=0 threads_n bot_clean=0 bot_major=0 merge_bad=0
    local emoji action exists=false in_queue=false

    # REST is authoritative — `gh pr view -q .number` can exit 0 on missing PRs.
    if ! gh_t api "repos/${REPO}/pulls/${n}" --jq .number >/dev/null 2>&1; then
        emoji="📝"
        action="pre-PR — no open PR #${n} on ${REPO} yet; file when ready"
        jq -n \
            --arg emoji "$emoji" --argjson exists false --argjson inQueue false --argjson open false \
            --argjson prePr true --argjson merged false \
            --argjson threads -1 \
            --argjson checksOk false --argjson checksPending false \
            --argjson botClean false --argjson botMajor false \
            --arg merge "UNKNOWN" --arg action "$action" \
            '{emoji:$emoji,exists:$exists,inQueue:$inQueue,open:$inQueue,prePr:$prePr,merged:$merged,threads:$threads,checksOk:$checksOk,checksPending:$checksPending,botClean:$botClean,botMajor:$botMajor,mergeState:$merge,action:$action}' \
            >"$out"
        return
    fi
    exists=true

    pr_state="$(gh_t api "repos/${REPO}/pulls/${n}" --jq .state 2>/dev/null || echo OPEN)"
    merge_state="$(gh_t api "repos/${REPO}/pulls/${n}" --jq .mergeable_state 2>/dev/null || echo UNKNOWN)"
    if [[ "$merge_state" == "dirty" || "$merge_state" == "behind" ]]; then merge_bad=1; fi

    if [[ "$(gh_t api "repos/${REPO}/pulls/${n}" --jq .merged 2>/dev/null || echo false)" == "true" ]]; then
        in_queue=false
        emoji="🔧"
        action="merged to ${REPO} main — archive session or spare for follow-on work"
        jq -n \
            --arg emoji "$emoji" --argjson exists true --argjson inQueue false --argjson open false \
            --argjson prePr false --argjson merged true \
            --argjson threads 0 \
            --argjson checksOk true --argjson checksPending false \
            --argjson botClean true --argjson botMajor false \
            --arg merge "MERGED" --arg action "$action" \
            '{emoji:$emoji,exists:$exists,inQueue:$inQueue,open:$inQueue,prePr:$prePr,merged:$merged,threads:$threads,checksOk:$checksOk,checksPending:$checksPending,botClean:$botClean,botMajor:$botMajor,mergeState:$merge,action:$action}' \
            >"$out"
        return
    fi
    in_queue=true

    checks="$(gh_t pr checks "$n" --repo "$REPO" --json name,bucket 2>/dev/null || echo '[]')"

    while IFS= read -r row; do
        local cname bucket
        cname="$(echo "$row" | jq -r '.name')"
        bucket="$(echo "$row" | jq -r '.bucket')"
        [[ "$cname" == "test" || "$cname" == "pr-review" ]] || continue
        case "$bucket" in
            pass|skipping)
                [[ "$cname" == "pr-review" ]] && pr_review_ok=1
                ;;
            pending|queued|in_progress) checks_ok=0; checks_pending=1 ;;
            *) checks_ok=0 ;;
        esac
    done < <(echo "$checks" | jq -c '.[]' 2>/dev/null || true)

    threads_n="$(gh_t api graphql -f query="
query { repository(owner:\"${OWNER}\", name:\"${NAME}\") {
  pullRequest(number: ${n}) { reviewThreads(first: 50) { nodes { isResolved } } }
}}" --jq 'if .data.repository.pullRequest == null then empty else [.data.repository.pullRequest.reviewThreads.nodes[]|select(.isResolved==false)]|length end' 2>/dev/null || true)"

    if [[ -z "$threads_n" || ! "$threads_n" =~ ^[0-9]+$ ]]; then
        threads_n=-1
    fi

    bot_body="$(fetch_latest_bot_body "$n")"

    if [[ "$bot_body" == "__CLEAN_LABEL__" ]]; then
        bot_clean=1
        bot_body=""
    elif echo "$bot_body" | grep -qiE 'No findings|No high-confidence|No issues found|No actionable|Didn.t find any|No new issues found|Findings.*None'; then
        bot_clean=1
    elif [[ "$pr_review_ok" -eq 1 ]]; then
        bot_clean=1
    fi
    if echo "$bot_body" | grep -qiE '\[Major\]|\[MAJOR\]'; then
        bot_major=1
        [[ "$pr_review_ok" -eq 1 ]] && bot_clean=1 && bot_major=0
    fi

    local parts=()
    [[ "$merge_bad" -eq 1 ]] && parts+=("rebase (merge state dirty)")
    if [[ "$checks_ok" -eq 0 && "$checks_pending" -eq 1 ]]; then parts+=("CI running")
    elif [[ "$checks_ok" -eq 0 ]]; then parts+=("fix failing CI"); fi
    [[ "$threads_n" -gt 0 ]] && parts+=("resolve ${threads_n} open thread(s)")
    [[ "$threads_n" -lt 0 ]] && parts+=("thread count unavailable (retry)")
    if [[ "$bot_clean" -eq 0 && "$bot_major" -eq 1 ]]; then parts+=("address bot [Major] findings")
    elif [[ "$bot_clean" -eq 0 && -n "$bot_body" ]]; then parts+=("address latest bot review")
    elif [[ "$bot_clean" -eq 0 ]]; then parts+=("push to trigger bot review"); fi

    if [[ "$checks_ok" -eq 1 && "$threads_n" -eq 0 && "$bot_clean" -eq 1 && "$merge_bad" -eq 0 ]]; then
        emoji="✅"
        parts=("full green — wait on tiann")
    elif [[ "$checks_pending" -eq 1 && "$threads_n" -eq 0 && "$bot_major" -eq 0 && "$merge_bad" -eq 0 ]]; then
        emoji="🔁"
    elif [[ "$checks_ok" -eq 1 && "$threads_n" -lt 0 && "$bot_clean" -eq 1 && "$merge_bad" -eq 0 ]]; then
        emoji="🔁"
        parts=("CI/bot green — thread count unavailable; retry sweep")
    else
        emoji="⚠️"
    fi
    action="$(IFS='; '; echo "${parts[*]}")"

    jq -n \
        --arg emoji "$emoji" --argjson exists "$exists" --argjson inQueue "$in_queue" --argjson open "$in_queue" \
        --argjson prePr false --argjson merged false \
        --argjson threads "$threads_n" \
        --argjson checksOk "$([[ "$checks_ok" -eq 1 ]] && echo true || echo false)" \
        --argjson checksPending "$([[ "$checks_pending" -eq 1 ]] && echo true || echo false)" \
        --argjson botClean "$([[ "$bot_clean" -eq 1 ]] && echo true || echo false)" \
        --argjson botMajor "$([[ "$bot_major" -eq 1 ]] && echo true || echo false)" \
        --arg merge "$merge_state" --arg action "$action" \
        '{emoji:$emoji,exists:$exists,inQueue:$inQueue,open:$inQueue,prePr:$prePr,merged:$merged,threads:$threads,checksOk:$checksOk,checksPending:$checksPending,botClean:$botClean,botMajor:$botMajor,mergeState:$merge,action:$action}' \
        >"$out"
}

export REPO OWNER NAME TIMEOUT TMPDIR WALL_LIMIT
export -f classify_one gh_t fetch_latest_bot_body

echo "hapi-pr-emoji-batch: ${#PRS[@]} PR(s), parallel=${PARALLEL}, timeout=${TIMEOUT}s, wall=$(( WALL_LIMIT - $(date +%s) ))s" >&2
t0=$(date +%s)

running=0
for n in "${PRS[@]}"; do
    while (( running >= PARALLEL )); do
        (( $(date +%s) < WALL_LIMIT )) || { echo "hapi-pr-emoji-batch: wall-clock limit during wait" >&2; running=0; break 2; }
        if wait -n 2>/dev/null; then
            running=$((running - 1))
        else
            wait || true
            running=0
        fi
    done
    classify_one "$n" &
    running=$((running + 1))
done
while (( running > 0 )); do
    (( $(date +%s) < WALL_LIMIT )) || { echo "hapi-pr-emoji-batch: wall-clock limit during final wait" >&2; break; }
    if wait -n 2>/dev/null; then
        running=$((running - 1))
    else
        wait || true
        running=0
    fi
done

echo "hapi-pr-emoji-batch: fetched in $(( $(date +%s) - t0 ))s" >&2

json="{"
first=1
for n in "${PRS[@]}"; do
    [[ -f "$TMPDIR/$n.json" ]] || continue
    [[ "$first" -eq 1 ]] || json+=","
    first=0
    json+="\"$n\":$(cat "$TMPDIR/$n.json")"
done
json+="}"

if [[ "$TABLE" -eq 1 ]]; then
    for n in "${PRS[@]}"; do
        [[ -f "$TMPDIR/$n.json" ]] || continue
        jq -r --arg n "$n" '"\(.emoji)  #\($n)  threads=\(.threads)  botClean=\(.botClean)  \(.action)"' "$TMPDIR/$n.json"
    done
else
    echo "$json" | jq -c .
fi

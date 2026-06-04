#!/usr/bin/env bash
# hapi-pr-watch — wait-loop wrapper around hapi-pr-status until clean OR timeout.
#
# Background: gh pr create is not the end of the workflow. The Codex PR Review
# action (github-actions[bot]) typically completes within ~5 minutes of a push,
# and the agent must respond to its [Major]/[Critical] findings BEFORE handing
# back to the operator. Without an enforced loop, agents bail right after push,
# the operator gets a "done!" message, and only later notices the bot found a
# regression nobody addressed.
#
# Usage:
#   hapi-pr-watch <PR_NUMBER> [--repo owner/repo] [--max-minutes N] [--interval-seconds N]
#
# Exit codes:
#   0  PR is clean (CI green + 0 unresolved threads + latest bot review has no
#      [Major]/[Critical] findings).
#   1  Timeout reached with PR still not clean. Agent MUST address findings or
#      escalate before declaring done.
#   2  Bad usage.
#
# Default loop: poll every 60s for up to 20 minutes. Override via flags.

set -euo pipefail

PR="${1:-}"
if [[ -z "$PR" ]]; then
    echo "Usage: hapi-pr-watch <PR_NUMBER> [--repo owner/repo] [--max-minutes N] [--interval-seconds N]" >&2
    exit 2
fi
shift

REPO="${HAPI_PR_REPO:-tiann/hapi}"
MAX_MIN=20
INTERVAL=60
while [[ $# -gt 0 ]]; do
    case "$1" in
        --repo) REPO="$2"; shift 2 ;;
        --max-minutes) MAX_MIN="$2"; shift 2 ;;
        --interval-seconds) INTERVAL="$2"; shift 2 ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
done

DEADLINE=$(( $(date +%s) + MAX_MIN * 60 ))
SCRIPT_DIR="$(dirname "$(readlink -f "$0")")"
STATUS_SCRIPT="$SCRIPT_DIR/hapi-pr-status.sh"

if [[ ! -x "$STATUS_SCRIPT" ]]; then
    echo "ERROR: hapi-pr-status.sh not found / not executable at $STATUS_SCRIPT" >&2
    exit 2
fi

iteration=0
while :; do
    iteration=$((iteration + 1))
    now=$(date +%s)
    remaining=$(( (DEADLINE - now) / 60 ))

    echo ""
    echo "  ──────── hapi-pr-watch iter #${iteration}  (≤${remaining}m left) ────────"

    if "$STATUS_SCRIPT" "$PR" --repo "$REPO"; then
        echo ""
        echo "  ✓ PR #${PR} is clean. hapi-pr-watch complete."
        exit 0
    fi

    if (( now >= DEADLINE )); then
        echo ""
        echo "  ✗ hapi-pr-watch timed out after ${MAX_MIN}m with PR #${PR} still not clean." >&2
        echo "    Agent MUST triage findings and either fix or escalate before declaring done." >&2
        exit 1
    fi

    echo ""
    echo "  … sleeping ${INTERVAL}s before next status check"
    sleep "$INTERVAL"
done

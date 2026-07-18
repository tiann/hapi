#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || ! -f "$1" ]]; then
    echo "usage: $0 <runner-integration-log>" >&2
    exit 2
fi

LOG="$1"
SUMMARY="$(grep -E 'Tests[[:space:]]+[0-9]+ passed \([0-9]+\)' "$LOG" | tail -n 1 || true)"
if [[ ! "$SUMMARY" =~ Tests[[:space:]]+([0-9]+)[[:space:]]+passed[[:space:]]+\(([0-9]+)\) ]]; then
    echo "Runner integration suite did not emit an all-passing summary" >&2
    exit 1
fi
if (( BASH_REMATCH[1] == 0 || BASH_REMATCH[1] != BASH_REMATCH[2] )); then
    echo "Runner integration suite summary is incomplete: $SUMMARY" >&2
    exit 1
fi
if grep -Eiq '(^|[[:space:]|])[0-9]+[[:space:]]+skipped([[:space:]|]|$)' "$LOG"; then
    echo "Runner integration suite contained a skipped test" >&2
    exit 1
fi

#!/usr/bin/env bash
# Scan text for operator-private infrastructure that must not appear in
# upstream PRs, public issues, or commits pushed to tiann/hapi.
#
# Usage:
#   check-operator-leaks.sh --stdin              # read stdin
#   check-operator-leaks.sh --file PATH [..]       # read files
#   check-operator-leaks.sh --git-staged           # staged diff (product paths)
#   check-operator-leaks.sh --git-range A B        # outgoing commit range
#
# Exit 0 if clean, 1 if leaks found.
# Override: HAPI_ALLOW_OPERATOR_LEAK=1
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

if [[ "${HAPI_ALLOW_OPERATOR_LEAK:-}" == "1" ]]; then
    exit 0
fi

# Operator tailnet MagicDNS (and similar). Extend via HAPI_OPERATOR_LEAK_PATTERNS_FILE.
LEAK_PATTERNS=(
    'tail9944ee\.ts\.net'
    'hapi\.tail9944ee'
)

if [[ -n "${HAPI_OPERATOR_LEAK_PATTERNS_FILE:-}" && -f "${HAPI_OPERATOR_LEAK_PATTERNS_FILE}" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
        [[ -z "$line" || "$line" =~ ^# ]] && continue
        LEAK_PATTERNS+=("$line")
    done < "${HAPI_OPERATOR_LEAK_PATTERNS_FILE}"
fi

PRODUCT_SCAN_PATHS=(hub web cli shared package.json)

FAIL=0

report_leak() {
    local context="$1"
    local pattern="$2"
    local sample="$3"
    echo "operator-leak: $context matches /$pattern/: $sample" >&2
    FAIL=1
}

scan_text_blob() {
    local context="$1"
    local blob="$2"
    local pat sample
    for pat in "${LEAK_PATTERNS[@]}"; do
        if printf '%s' "$blob" | grep -qiE "$pat"; then
            sample="$(printf '%s' "$blob" | grep -oiE ".{0,40}${pat}.{0,40}" | head -1 | tr '\n' ' ')"
            report_leak "$context" "$pat" "$sample"
        fi
    done
}

scan_file() {
    local path="$1"
    [[ -f "$path" ]] || return 0
    scan_text_blob "file:$path" "$(cat "$path")"
}

scan_git_staged() {
    local diff
    diff="$(git diff --cached -- "${PRODUCT_SCAN_PATHS[@]}" 2>/dev/null || true)"
    [[ -z "$diff" ]] && return 0
    scan_text_blob 'git-staged' "$diff"
    local pat
    for pat in "${LEAK_PATTERNS[@]}"; do
        if ! git diff --cached -G"$pat" --quiet -- "${PRODUCT_SCAN_PATHS[@]}" 2>/dev/null; then
            git diff --cached -G"$pat" --name-only -- "${PRODUCT_SCAN_PATHS[@]}" 2>/dev/null | sed 's/^/    /' >&2 || true
        fi
    done
}

scan_git_range() {
    local from="$1"
    local to="$2"
    local diff
    diff="$(git diff "$from" "$to" -- "${PRODUCT_SCAN_PATHS[@]}" 2>/dev/null || true)"
    [[ -z "$diff" ]] && return 0
    scan_text_blob "git-range:$from..$to" "$diff"
}

usage() {
    sed -n '2,12p' "$0"
    exit 2
}

if [[ $# -eq 0 ]]; then
    usage
fi

case "$1" in
    --stdin)
        scan_text_blob 'stdin' "$(cat)"
        ;;
    --file)
        shift
        [[ $# -ge 1 ]] || usage
        for f in "$@"; do
            scan_file "$f"
        done
        ;;
    --git-staged)
        scan_git_staged
        ;;
    --git-range)
        [[ $# -eq 3 ]] || usage
        scan_git_range "$2" "$3"
        ;;
    -h|--help)
        usage
        ;;
    *)
        usage
        ;;
esac

if [[ "$FAIL" -ne 0 ]]; then
    echo "" >&2
    echo "Operator-private URLs/hostnames must not appear in public upstream artifacts." >&2
    echo "Use generic wording (e.g. \"operator tailnet hub\") in issues/PRs." >&2
    echo "Emergency override: HAPI_ALLOW_OPERATOR_LEAK=1" >&2
    exit 1
fi

exit 0

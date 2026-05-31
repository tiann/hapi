#!/usr/bin/env bash
# Surface stashes that look like other-agents' lost work.
# Non-blocking - prints to stderr, always exits 0.
#
# Triggers warning for stash entries that match ANY of:
#   - Older than HAPI_STASH_ADVISORY_AGE_MIN (default 30) minutes
#   - Message contains: wip, pre-, auto, untitled, dirty
#   - Message is empty / generic "WIP on <branch>"
#
# Usage:
#   scripts/tooling/check-stash-advisory.sh              # foreground audit
#   scripts/tooling/check-stash-advisory.sh --quiet      # only print if findings
#   scripts/tooling/check-stash-advisory.sh --count      # print count, exit 0
#
# Bypass: HAPI_SKIP_STASH_ADVISORY=1
set -euo pipefail

if [[ "${HAPI_SKIP_STASH_ADVISORY:-}" == "1" ]]; then
    exit 0
fi

QUIET=0
COUNT_ONLY=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --quiet) QUIET=1; shift ;;
        --count) COUNT_ONLY=1; shift ;;
        -h|--help)
            sed -n '2,16p' "$0"
            exit 0
            ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
done

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[[ -z "$ROOT" ]] && exit 0

AGE_MIN="${HAPI_STASH_ADVISORY_AGE_MIN:-30}"
NOW_EPOCH="$(date +%s)"

mapfile -t STASHES < <(git -C "$ROOT" stash list --format='%gd|%ct|%gs' 2>/dev/null || true)
total="${#STASHES[@]}"

if [[ "$COUNT_ONLY" -eq 1 ]]; then
    echo "$total"
    exit 0
fi

if [[ "$total" -eq 0 ]]; then
    [[ "$QUIET" -eq 1 ]] || echo "stash-advisory: 0 stashes (clean)"
    exit 0
fi

SUSPECT_RE='(wip|pre-|auto|untitled|dirty|pre_|preupstream|prerebuild|prerebase|cleanup|backup)'
findings=()

for line in "${STASHES[@]}"; do
    [[ -z "$line" ]] && continue
    ref="${line%%|*}"
    rest="${line#*|}"
    ts="${rest%%|*}"
    msg="${rest#*|}"
    age_min=$(( (NOW_EPOCH - ts) / 60 ))
    age_label=""
    if [[ "$age_min" -ge $((60 * 24)) ]]; then
        age_label="$((age_min / 60 / 24))d"
    elif [[ "$age_min" -ge 60 ]]; then
        age_label="$((age_min / 60))h"
    else
        age_label="${age_min}m"
    fi

    suspect=0
    if [[ "$age_min" -ge "$AGE_MIN" ]]; then
        suspect=1
    fi
    if echo "$msg" | grep -qiE "$SUSPECT_RE"; then
        suspect=1
    fi
    if [[ "$msg" =~ ^WIP\ on\  ]]; then
        suspect=1
    fi
    if [[ "$suspect" -eq 1 ]]; then
        findings+=("  ${ref}  age=${age_label}  ${msg}")
    fi
done

if [[ "${#findings[@]}" -eq 0 ]]; then
    [[ "$QUIET" -eq 1 ]] || echo "stash-advisory: ${total} stash(es), none suspicious"
    exit 0
fi

{
    echo "stash-advisory: ${#findings[@]} of ${total} stash(es) look like lost agent work:"
    printf '%s\n' "${findings[@]}"
    echo ""
    echo "  Older than ${AGE_MIN}m or WIP-style label. If you do not own one, do NOT drop it."
    echo "  Policy: docs/tooling/git-stash-policy.md"
    echo "  Cursor rule: .cursor/rules/no-stash-others-work.mdc"
    echo "  Bypass once: HAPI_SKIP_STASH_ADVISORY=1"
} >&2

exit 0

#!/usr/bin/env bash
# Smoke-test production mutation guard patterns (operator-local).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GUARD="$ROOT/scripts/tooling/hapi-production-mutation-guard.sh"

expect_deny() {
    local cmd="$1"
    local label="${2:-$1}"
    local out
    out=$(printf '%s' "{\"command\":$(jq -cn --arg c "$cmd" '$c')}" | "$GUARD")
    if printf '%s' "$out" | jq -e '.permission == "deny"' >/dev/null; then
        echo "OK deny: $label"
    else
        echo "FAIL expected deny: $label" >&2
        echo "$out" >&2
        exit 1
    fi
}

expect_allow() {
    local cmd="$1"
    local label="${2:-$1}"
    local out
    out=$(printf '%s' "{\"command\":$(jq -cn --arg c "$cmd" '$c')}" | "$GUARD")
    if printf '%s' "$out" | jq -e '.permission == "allow"' >/dev/null; then
        echo "OK allow: $label"
    else
        echo "FAIL expected allow: $label" >&2
        echo "$out" >&2
        exit 1
    fi
}

# #921 feat-dist swap
expect_deny 'cp -a /home/heavygee/coding/hapi/worktrees/scratchlist-attachments-v22/web/dist /home/heavygee/coding/hapi/driver/web/dist' 'feat dist cp'
expect_deny 'DRIVER_WEB=driver/web/dist FEAT_DIST=worktrees/foo/web/dist cp -a $FEAT_DIST $DRIVER_WEB' 'FEAT_DIST pattern'

# #962 hand merge + raw build
expect_deny 'git -C /home/heavygee/coding/hapi/driver cherry-pick c08f327d' 'driver cherry-pick'
expect_deny 'cd /home/heavygee/coding/hapi/driver/web && bun run build' 'raw driver/web build'

# Full rebuild without --build-web
expect_deny 'hapi-driver-rebuild --verify' 'full manifest rebuild'
expect_deny 'hapi-driver-rebuild' 'full rebuild bare'

# Allowed peer paths
expect_allow 'hapi-driver-build-web' 'build-web tool'
expect_allow 'hapi-driver-rebuild --build-web --verify' 'build-web rebuild'
expect_allow 'hapi-verify-web-dist' 'verify only'
expect_allow 'hapi-restart-hub' 'patient hub restart'

echo "hapi-production-mutation-guard.test.sh: all patterns OK"

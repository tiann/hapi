#!/usr/bin/env bash
# driver-promotion.sh — dogfood promotion contract helpers.
#
# Operator expectation: nothing swings onto the live hub until we have
# evidence the target tree was rebuilt with --verify (typecheck + tests).
# Compile pre-flight (preflight-hub-compile.sh) is necessary but not
# sufficient — it catches syntax garbage, not logic/type regressions.
#
# Status file: ~/.hapi/driver-promotion.json
#   {
#     "schema": 1,
#     "verified_sha": "<full sha>",
#     "verified_short": "<short>",
#     "verified_at": "2026-06-19T...Z",
#     "worktree": "/home/heavygee/coding/hapi/driver",
#     "verify_args": ["--build-web", "--verify"]
#   }
#
# Bypass (operator-only, TTY-gated at call site):
#   HAPI_PROMOTE_UNVERIFIED=1

HAPI_PROMOTION_FILE="${HAPI_PROMOTION_FILE:-$HOME/.hapi/driver-promotion.json}"

driver_promotion_stamp() {
    local worktree="${1:-}"
    local sha short now args_json
    [[ -n "$worktree" && -d "$worktree/.git" || -d "$worktree" ]] || {
        echo "driver_promotion_stamp: invalid worktree: ${worktree:-empty}" >&2
        return 1
    }
    sha="$(git -C "$worktree" rev-parse HEAD 2>/dev/null || true)"
    short="$(git -C "$worktree" rev-parse --short HEAD 2>/dev/null || true)"
    [[ -n "$sha" ]] || { echo "driver_promotion_stamp: could not read HEAD" >&2; return 1; }
    now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    if command -v jq >/dev/null 2>&1; then
        args_json='[]'
        if [[ -n "${HAPI_LAST_VERIFY_ARGS:-}" ]]; then
            # shellcheck disable=SC2206
            args_json="$(printf '%s\n' ${HAPI_LAST_VERIFY_ARGS} | jq -R . | jq -s .)"
        fi
        local tmp
        tmp="$(mktemp -p "${HAPI_STATE_DIR:-$HOME/.hapi}" .driver-promotion.XXXXXX.json)"
        jq -n \
            --arg schema "1" \
            --arg sha "$sha" \
            --arg short "$short" \
            --arg at "$now" \
            --arg wt "$(readlink -f "$worktree")" \
            --argjson args "$args_json" \
            '{schema: ($schema|tonumber), verified_sha: $sha, verified_short: $short, verified_at: $at, worktree: $wt, verify_args: $args}' \
            > "$tmp"
        mkdir -p "$(dirname "$HAPI_PROMOTION_FILE")"
        mv "$tmp" "$HAPI_PROMOTION_FILE"
    else
        mkdir -p "$(dirname "$HAPI_PROMOTION_FILE")"
        cat > "$HAPI_PROMOTION_FILE" <<EOF
{"schema":1,"verified_sha":"$sha","verified_short":"$short","verified_at":"$now","worktree":"$(readlink -f "$worktree")"}
EOF
    fi
    echo "dogfood: promotion stamp written for $short ($HAPI_PROMOTION_FILE)"
}

driver_promotion_check() {
    local worktree="${1:-}"
    [[ "${HAPI_PROMOTE_UNVERIFIED:-}" == "1" ]] && {
        echo "dogfood: WARN promotion verify stamp bypassed (HAPI_PROMOTE_UNVERIFIED=1)" >&2
        return 0
    }
    local head sha stamp_short stamp_at
    head="$(git -C "$worktree" rev-parse HEAD 2>/dev/null || true)"
    [[ -n "$head" ]] || { echo "dogfood: FAIL could not read HEAD for $worktree" >&2; return 1; }
    if [[ ! -f "$HAPI_PROMOTION_FILE" ]]; then
        cat >&2 <<EOF

REFUSE: no dogfood promotion stamp for this tree.

Live stack switch requires a prior successful:
  hapi-driver-rebuild --build-web --verify

That runs compile pre-flight + typecheck + tests and records the verified
SHA in:
  $HAPI_PROMOTION_FILE

Current target HEAD: $(git -C "$worktree" rev-parse --short HEAD 2>/dev/null || echo unknown)

Operator bypass (real terminal only — enforced by caller):
  HAPI_PROMOTE_UNVERIFIED=1 hapi-use-driver

EOF
        return 1
    fi
    if command -v jq >/dev/null 2>&1; then
        sha="$(jq -r '.verified_sha // empty' "$HAPI_PROMOTION_FILE" 2>/dev/null || true)"
        stamp_short="$(jq -r '.verified_short // empty' "$HAPI_PROMOTION_FILE" 2>/dev/null || true)"
        stamp_at="$(jq -r '.verified_at // empty' "$HAPI_PROMOTION_FILE" 2>/dev/null || true)"
    else
        sha="$(grep -oE '"verified_sha"\s*:\s*"[^"]+"' "$HAPI_PROMOTION_FILE" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
        stamp_short="${sha:0:7}"
        stamp_at="?"
    fi
    if [[ -z "$sha" || "$sha" != "$head" ]]; then
        cat >&2 <<EOF

REFUSE: target tree is not the last verified dogfood build.

  target HEAD:  $(git -C "$worktree" rev-parse --short HEAD 2>/dev/null || echo unknown) ($head)
  verified:     ${stamp_short:-none} ($sha) at ${stamp_at:-?}

Re-run:
  hapi-driver-rebuild --build-web --verify

Then swing live:
  hapi-use-driver

Operator bypass (real terminal only):
  HAPI_PROMOTE_UNVERIFIED=1 hapi-use-driver

EOF
        return 1
    fi
    echo "dogfood: verified promotion stamp OK (${stamp_short} @ ${stamp_at})"
    return 0
}

#!/usr/bin/env bash
# preflight_hub_compile <worktree-root>
#
# Cheap gate before swinging/restarting the live hub stack. Catches:
#   - unresolved git conflict markers in hub/src (and cli/src)
#   - TypeScript parse/load failures in hub store (syntax errors that
#     systemd will only surface as a crash loop on restart)
#
# Skip with HAPI_SKIP_COMPILE_PREFLIGHT=1 (dev only).
#
# This is intentionally lighter than `bun typecheck` (which includes test
# files and cross-package debt). Full typecheck remains `hapi-driver-rebuild
# --verify`.

preflight_hub_compile() {
    local root="${1:-}"
    [[ "${HAPI_SKIP_COMPILE_PREFLIGHT:-}" == "1" ]] && {
        echo "preflight: compile check skipped (HAPI_SKIP_COMPILE_PREFLIGHT=1)"
        return 0
    }
    [[ -n "$root" && -d "$root/hub" ]] || {
        echo "preflight: ERROR: need worktree with hub/ (got: ${root:-empty})" >&2
        return 1
    }

    local bun="${BUN:-$HOME/.bun/bin/bun}"
    local hub="$root/hub"
    local markers=""

    echo "Pre-flight compile: $root"

    markers="$(grep -rlE '^<<<<<<< |^>>>>>>> ' "$hub/src" 2>/dev/null || true)"
    if [[ -d "$root/cli/src" ]]; then
        markers="$(printf '%s\n%s' "$markers" "$(grep -rlE '^<<<<<<< |^>>>>>>> ' "$root/cli/src" 2>/dev/null || true)")"
    fi
    markers="$(printf '%s\n' "$markers" | sed '/^$/d' | sort -u)"
    if [[ -n "$markers" ]]; then
        echo "  FAIL: unresolved merge conflict markers in:" >&2
        printf '%s\n' "$markers" | sed 's/^/    /' >&2
        return 1
    fi
    echo "  conflict markers: none"

    if [[ ! -x "$bun" ]]; then
        echo "  WARN: bun not found at $bun; skipping hub parse check" >&2
        return 0
    fi

    if ! (cd "$hub" && "$bun" -e "import './src/store/index.ts'"); then
        echo "  FAIL: hub store module did not parse/load" >&2
        return 1
    fi
    echo "  hub store: parse OK"
    return 0
}

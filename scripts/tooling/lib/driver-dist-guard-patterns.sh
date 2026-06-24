#!/usr/bin/env bash
# Shared shell-command patterns for driver/web/dist and driver/integration guards.
# Sourced by hapi-production-mutation-guard.sh (and test harness).
#
# Return 0 = block command; 1 = do not block on these patterns alone.

_hapi_cmd_is_allowed_driver_dist_tool() {
    local lc="$1"
    if printf '%s' "$lc" | grep -qE 'hapi-driver-build-web|hapi-driver-rollback-web|hapi-verify-web-dist|verify-soup-web-dist|build_web_atomic|dist\.next|dist\.prev'; then
        return 0
    fi
    if printf '%s' "$lc" | grep -qE 'hapi-driver-rebuild' && printf '%s' "$lc" | grep -qF -- '--build-web'; then
        return 0
    fi
    return 1
}

_hapi_driver_dist_injection_match() {
    local c="$1"
    local lc
    lc=$(printf '%s' "$c" | tr '[:upper:]' '[:lower:]')

    # Canonical tools manage dist.next/dist.prev internally — never block those invocations.
    if _hapi_cmd_is_allowed_driver_dist_tool "$lc"; then
        return 1
    fi

    # 2026-06-23 #921: feat/worktree dist copied into driver (rollback of full soup UI).
    if printf '%s' "$lc" | grep -qE 'feat_dist|worktrees/[^[:space:]"'\''`]+/web/dist'; then
        if printf '%s' "$lc" | grep -qE 'driver/web/dist|/hapi/driver/web/dist|coding/hapi/driver/web/dist'; then
            return 0
        fi
    fi

    if printf '%s' "$lc" | grep -qE '(cp|rsync|mv)[[:space:]]' \
        && printf '%s' "$lc" | grep -qE 'driver/web/dist|/hapi/driver/web/dist'; then
        return 0
    fi

    # Raw vite/bun build in driver/web bypasses atomic swap + preflight + verify rollback.
    if printf '%s' "$lc" | grep -qE 'driver/web' \
        && printf '%s' "$lc" | grep -qE '(bun run build|vite build|npm run build)'; then
        return 0
    fi

    return 1
}

_hapi_driver_integration_hand_edit_match() {
    local c="$1"
    local lc
    lc=$(printf '%s' "$c" | tr '[:upper:]' '[:lower:]')

    # Full manifest rebuild (not build-web-only) — #921 partial merge disaster.
    if printf '%s' "$lc" | grep -qE '(^|[[:space:]|&;])hapi-driver-rebuild([[:space:]]|$)'; then
        if ! printf '%s' "$lc" | grep -qF -- '--build-web'; then
            return 0
        fi
    fi

    if _hapi_cmd_is_allowed_driver_dist_tool "$lc"; then
        return 1
    fi

    # 2026-06-24 #962: hand merge/cherry-pick/reset on driver/integration instead of manifest rebuild.
    if printf '%s' "$lc" | grep -qE 'git[[:space:]]+(-c[[:space:]]+[^[:space:]]+[[:space:]]+)?(-c[[:space:]]+[^[:space:]]+[[:space:]]+)?(merge|cherry-pick|rebase|reset|checkout[[:space:]]+[^-])' \
        && printf '%s' "$lc" | grep -qE '(^|[[:space:]/"'\''])driver(/integration)?([[:space:]"'\''`/]|$)|coding/hapi/driver'; then
        return 0
    fi

    return 1
}

_hapi_production_mutation_match() {
    local c="$1"
    local lc
    lc=$(printf '%s' "$c" | tr '[:upper:]' '[:lower:]')

    if _hapi_driver_dist_injection_match "$c"; then
        return 0
    fi
    if _hapi_driver_integration_hand_edit_match "$c"; then
        return 0
    fi

    # Stack switch / promotion tooling
    if printf '%s' "$lc" | grep -qE 'hapi-driver-db-prep|hapi-use-worktree|hapi-use-driver|hapi-driver-rebuild.*--activate|hapi-watch-activate-driver|hapi_stack_switch_yes=1'; then
        return 0
    fi

    # Manual hub / port hijack
    if printf '%s' "$lc" | grep -qE 'nohup.*(bun run|src/index\.ts)|manual-hub|>>.*manual-hub'; then
        return 0
    fi

    # Kill production listener / hub processes
    if printf '%s' "$lc" | grep -qE '(^|[[:space:];|&])(kill|pkill|fuser)[[:space:]].*(3006|hapi-hub|/hub/|src/index\.ts)'; then
        return 0
    fi
    if printf '%s' "$lc" | grep -qE 'kill[[:space:]]+[0-9]+' && printf '%s' "$lc" | grep -qE '3006|hapi-hub|manual-hub|cross-flavor'; then
        return 0
    fi

    # systemd destruction (catch non-sudo paths too — rare but cheap)
    if printf '%s' "$lc" | grep -qE 'systemctl[[:space:]]+(stop|restart|kill|disable|mask)[[:space:]]+hapi-(hub|runner|runner-watchdog)'; then
        return 0
    fi

    # Driver tree destruction / sneak promote
    if printf '%s' "$lc" | grep -qE 'git reset --hard.*(driver|hapi/driver)|embeddedassets.*driver|cp -r.*embeddedassets'; then
        return 0
    fi

    # Shared DB surgery
    if printf '%s' "$lc" | grep -qE '(\.hapi/hapi\.db|hapi\.db\.bak)|sqlite3.*hapi\.db.*(drop|delete|update|insert)'; then
        return 0
    fi

    return 1
}

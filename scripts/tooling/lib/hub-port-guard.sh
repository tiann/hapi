#!/usr/bin/env bash
# hub-port-guard.sh — refuse production promotion while a rogue hub owns :3006.
#
# Production contract: only hapi-hub.service (systemd) may bind HAPI_LISTEN_PORT
# (default 3006) against ~/.hapi/hapi.db. Feature peers sometimes `nohup bun run
# src/index.ts` from a worktree hub for dogfood; if that process survives the turn,
# systemd crash-loops on EADDRINUSE and the operator sees a soup regression that
# is actually a port hijack.
#
# Used by hapi-watch-activate-driver (pre/post activation) and
# hapi-use-worktree verify_active_stack.

HUB_PORT_GUARD_PORT="${HUB_PORT_GUARD_PORT:-3006}"
HUB_PORT_GUARD_UNIT="${HUB_PORT_GUARD_UNIT:-hapi-hub.service}"

hub_port_guard_listener_pid() {
    local port="$1"
    local line pid
    line="$(ss -tlnp "sport = :${port}" 2>/dev/null | awk '/LISTEN/ {print; exit}' || true)"
    [[ -n "$line" ]] || return 1
    if [[ "$line" =~ users:\(\(\"[^\"]+\",pid=([0-9]+) ]]; then
        pid="${BASH_REMATCH[1]}"
        echo "$pid"
        return 0
    fi
    return 1
}

hub_port_guard_systemd_mainpid() {
    local unit="$1"
    local pid
    pid="$(systemctl show "$unit" -p MainPID --value 2>/dev/null || true)"
    [[ "$pid" =~ ^[0-9]+$ && "$pid" -gt 1 ]] || return 1
    echo "$pid"
}

hub_port_guard_proc_cwd() {
    local pid="$1"
    readlink -f "/proc/${pid}/cwd" 2>/dev/null || true
}

hub_port_guard_proc_cmdline() {
    local pid="$1"
    tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null || true
}

# Returns 0 when port is free OR owned correctly by systemd hub on expected tree.
# Prints human-readable errors to stderr and returns 1 on rogue ownership.
hub_port_guard_assert_production() {
    local expected_hub_dir="${1:-}"
    local port="$HUB_PORT_GUARD_PORT"
    local unit="$HUB_PORT_GUARD_UNIT"
    local listener_pid systemd_pid listener_cwd systemd_active=0

    if [[ -z "$expected_hub_dir" ]]; then
        echo "hub_port_guard_assert_production: expected hub dir required" >&2
        return 1
    fi
    expected_hub_dir="$(readlink -f "$expected_hub_dir" 2>/dev/null || echo "$expected_hub_dir")"

    listener_pid="$(hub_port_guard_listener_pid "$port" || true)"
    if [[ -z "$listener_pid" ]]; then
        if systemctl is-active --quiet "$unit" 2>/dev/null; then
            echo "  FAIL: ${unit} active but nothing listening on :${port}" >&2
            return 1
        fi
        return 0
    fi

    listener_cwd="$(hub_port_guard_proc_cwd "$listener_pid")"
    systemd_pid="$(hub_port_guard_systemd_mainpid "$unit" || true)"
    if systemctl is-active --quiet "$unit" 2>/dev/null; then
        systemd_active=1
    fi

    if [[ "$systemd_active" -eq 1 && -n "$systemd_pid" && "$listener_pid" == "$systemd_pid" ]]; then
        if [[ "$listener_cwd" == "$expected_hub_dir" ]]; then
            return 0
        fi
        echo "  FAIL: ${unit} owns :${port} but hub cwd mismatch" >&2
        echo "    expected: $expected_hub_dir" >&2
        echo "    actual:   ${listener_cwd:-unknown}" >&2
        return 1
    fi

    echo "  FAIL: rogue hub owns :${port} (blocks ${unit} — EADDRINUSE crash loop)" >&2
    echo "    listener pid: ${listener_pid}" >&2
    echo "    listener cwd: ${listener_cwd:-unknown}" >&2
    echo "    cmdline:      $(hub_port_guard_proc_cmdline "$listener_pid")" >&2
    if [[ -n "$systemd_pid" ]]; then
        echo "    ${unit} MainPID: ${systemd_pid} (not the listener)" >&2
    else
        echo "    ${unit}: not active" >&2
    fi
    echo "  Recovery (operator or soup steward):" >&2
    echo "    kill ${listener_pid}   # stray manual/worktree hub only" >&2
    echo "    sudo systemctl start ${unit}" >&2
    echo "    curl -s http://127.0.0.1:${port}/ | rg 'index-'" >&2
    echo "  Agent rule: NEVER nohup 'bun run src/index.ts' from a worktree on :${port}." >&2
    echo "    Use manifest rebuild + hapi-watch-activate-driver, or an isolated peer stack on :3100+." >&2
    return 1
}

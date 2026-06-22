#!/usr/bin/env bash
# Port allocation for hapi-peer-stack (hub ports 3100-3199).
set -euo pipefail

PEER_STACK_PORT_BASE="${PEER_STACK_PORT_BASE:-3100}"
PEER_STACK_PORT_MAX="${PEER_STACK_PORT_MAX:-3199}"
PEER_STACK_PRODUCTION_PORT="${PEER_STACK_PRODUCTION_PORT:-3006}"

peer_stack_port_in_use() {
    local port="$1"
    if command -v ss >/dev/null 2>&1; then
        ss -ltn "sport = :$port" 2>/dev/null | grep -q ":$port"
        return $?
    fi
    if command -v lsof >/dev/null 2>&1; then
        lsof -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1
        return $?
    fi
    return 1
}

peer_stack_registry_used_ports() {
    local registry_file="$1"
    if [[ ! -f "$registry_file" ]]; then
        return 0
    fi
    jq -r '.stacks // {} | .[].hubPort // empty' "$registry_file" 2>/dev/null || true
}

peer_stack_allocate_port() {
    local registry_file="${1:-$HOME/.hapi-peer/registry.json}"
    local slot=0
    local port
    local used
    local max_slot=$((PEER_STACK_PORT_MAX - PEER_STACK_PORT_BASE))

    if (( max_slot < 0 )); then
        echo "ERROR: invalid peer stack port range ${PEER_STACK_PORT_BASE}-${PEER_STACK_PORT_MAX}" >&2
        return 1
    fi

    while (( slot <= max_slot )); do
        port=$((PEER_STACK_PORT_BASE + slot))
        if (( port == PEER_STACK_PRODUCTION_PORT )); then
            slot=$((slot + 1))
            continue
        fi
        if peer_stack_port_in_use "$port"; then
            slot=$((slot + 1))
            continue
        fi
        used=0
        while IFS= read -r reg_port; do
            [[ -z "$reg_port" ]] && continue
            if [[ "$reg_port" == "$port" ]]; then
                used=1
                break
            fi
        done < <(peer_stack_registry_used_ports "$registry_file")
        if (( used == 0 )); then
            echo "$port"
            return 0
        fi
        slot=$((slot + 1))
    done

    echo "ERROR: no free peer stack hub port in ${PEER_STACK_PORT_BASE}-${PEER_STACK_PORT_MAX}" >&2
    return 1
}

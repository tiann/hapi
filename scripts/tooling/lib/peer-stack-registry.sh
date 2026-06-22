#!/usr/bin/env bash
# JSON registry helpers for hapi-peer-stack (~/.hapi-peer/registry.json).
set -euo pipefail

PEER_STACK_REGISTRY_DIR="${PEER_STACK_REGISTRY_DIR:-$HOME/.hapi-peer}"
PEER_STACK_REGISTRY_FILE="${PEER_STACK_REGISTRY_FILE:-$PEER_STACK_REGISTRY_DIR/registry.json}"

peer_stack_registry_init() {
    mkdir -p "$PEER_STACK_REGISTRY_DIR"
    if [[ ! -f "$PEER_STACK_REGISTRY_FILE" ]]; then
        echo '{"stacks":{}}' > "$PEER_STACK_REGISTRY_FILE"
    fi
}

peer_stack_registry_read() {
    local name="$1"
    peer_stack_registry_init
    jq -e --arg name "$name" '.stacks[$name] // empty' "$PEER_STACK_REGISTRY_FILE"
}

peer_stack_registry_list_names() {
    peer_stack_registry_init
    jq -r '.stacks // {} | keys[]' "$PEER_STACK_REGISTRY_FILE" 2>/dev/null || true
}

peer_stack_registry_write_entry() {
    local name="$1"
    local json_blob="$2"
    peer_stack_registry_init
    local tmp
    tmp="$(mktemp "${PEER_STACK_REGISTRY_FILE}.XXXXXX")"
    jq --arg name "$name" --argjson entry "$json_blob" \
        '.stacks[$name] = $entry' "$PEER_STACK_REGISTRY_FILE" > "$tmp"
    mv "$tmp" "$PEER_STACK_REGISTRY_FILE"
}

peer_stack_registry_remove_entry() {
    local name="$1"
    peer_stack_registry_init
    local tmp
    tmp="$(mktemp "${PEER_STACK_REGISTRY_FILE}.XXXXXX")"
    jq --arg name "$name" 'del(.stacks[$name])' "$PEER_STACK_REGISTRY_FILE" > "$tmp"
    mv "$tmp" "$PEER_STACK_REGISTRY_FILE"
}

peer_stack_pid_alive() {
    local pid="$1"
    [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

peer_stack_stack_running() {
    local name="$1"
    local entry
    if ! entry="$(peer_stack_registry_read "$name" 2>/dev/null)"; then
        return 1
    fi
    local hub_pid runner_pid
    hub_pid="$(echo "$entry" | jq -r '.hubPid // empty')"
    runner_pid="$(echo "$entry" | jq -r '.runnerPid // empty')"
    if peer_stack_pid_alive "$hub_pid"; then
        return 0
    fi
    if [[ -n "$runner_pid" ]] && peer_stack_pid_alive "$runner_pid"; then
        return 0
    fi
    return 1
}

peer_stack_refuse_if_running() {
    local name="$1"
    if peer_stack_stack_running "$name"; then
        echo "ERROR: peer stack '$name' is already running (see hapi-peer-stack status --name $name)" >&2
        exit 1
    fi
}

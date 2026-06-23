#!/usr/bin/env bash
# Cursor preToolUse / beforeShellExecution hook: refuse production hub mutations.
#
# Blocks Shell tool commands that:
#   (A) SSH (or wsl ssh) to Linux with kill/nohup/stack-switch/DB-prep/manual-hub patterns
#   (B) Run the same patterns locally on Proxmox (manual nohup hub, kill :3006 listener)
#
# Complements hapi-systemctl-guard.sh (sudo systemctl only) and hub-port-guard.sh (activation).
# Operator-local tooling — NOT upstream mandate.
#
# Bypass: HAPI_OPERATOR_PRODUCTION_MUTATION_OVERRIDE=1 with controlling tty only.

set -uo pipefail

INPUT=$(cat)

CMD=$(printf '%s' "$INPUT" | jq -r '
    [
      .command,
      .input.command,
      .tool_input.command,
      .input.cmd,
      .tool_input.cmd
    ]
    | map(select(. != null and . != ""))
    | first // empty
' 2>/dev/null || true)

TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // .tool // empty' 2>/dev/null || true)

if [ -z "$CMD" ]; then
    echo '{ "permission": "allow" }'
    exit 0
fi

if [ "${HAPI_OPERATOR_PRODUCTION_MUTATION_OVERRIDE:-0}" = "1" ] && [ -t 0 ]; then
    echo '{ "permission": "allow" }'
    exit 0
fi

_lc_cmd=$(printf '%s' "$CMD" | tr '[:upper:]' '[:lower:]')

_hapi_production_mutation_match() {
    local c="$1"
    local lc
    lc=$(printf '%s' "$c" | tr '[:upper:]' '[:lower:]')

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

_is_remote_ssh=0
if printf '%s' "$_lc_cmd" | grep -qE '(^|[[:space:]|&;])(ssh|scp|rsync)[[:space:]]|wsl[[:space:]].*ssh'; then
    _is_remote_ssh=1
fi

_block=0
if _hapi_production_mutation_match "$CMD"; then
    if [ "$_is_remote_ssh" -eq 1 ]; then
        _block=1
    else
        # Local mutation — always block dangerous patterns on Linux agent shells
        _block=1
    fi
fi

if [ "$_block" -eq 1 ]; then
    DENY_MSG=$(cat <<EOF
Production HAPI mutation BLOCKED (2026-06-20 rogue-hub incident class).

Command: $CMD
Tool:    ${TOOL:-Shell}

Agents must NOT kill, nohup, stack-switch, DB-prep, or reset driver to change what serves :3006.
REFUSE from hapi-use-worktree / hapi-restart-hub means STOP — report to operator.

Windows estate agents: refresh Teemo runner only; use hapi-peer-stack for pre-soup browser proof (:3100+).
Linux soup promotion: manifest + hapi-driver-rebuild — operator or steward only.

Bypass (operator TTY only): HAPI_OPERATOR_PRODUCTION_MUTATION_OVERRIDE=1

See:
  ~/coding/hapi/.cursor/rules/operator-fork.mdc
  ~/coding/hapi/scripts/tooling/cursor-rules/hapi-windows-estate.mdc
  ~/coding/hapi/docs/operator/windows-estate-agents.md
EOF
)
    jq -n \
        --arg msg "$DENY_MSG" \
        '{
            permission: "deny",
            agent_message: $msg,
            user_message: "Blocked: production HAPI mutation (manual hub / stack switch / :3006 kill). Report blocked to operator."
        }'
    exit 0
fi

echo '{ "permission": "allow" }'
exit 0

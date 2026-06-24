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

# shellcheck source=lib/driver-dist-guard-patterns.sh
source "$(dirname "$(readlink -f "$0")")/lib/driver-dist-guard-patterns.sh"

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
Production HAPI mutation BLOCKED (rogue-hub / feat-dist-swap / hand-merge class).

Command: $CMD
Tool:    ${TOOL:-Shell}

Blocked classes include:
  - kill/nohup/stack-switch/DB-prep/manual hub on :3006
  - cp/rsync/mv feat or worktree web/dist into driver/web/dist (#921 rollback)
  - raw bun/vite build in driver/web (use hapi-driver-build-web)
  - git merge/cherry-pick/reset on driver/integration (#962 hand-merge)
  - hapi-driver-rebuild without --build-web (manifest merge — meta/operator only)

Allowed for feature peers on driver soup:
  - hapi-driver-build-web [--skip-verify]  (builds from driver/web source)
  - hapi-driver-rebuild --build-web [--verify]
  - hapi-verify-web-dist / hapi-restart-hub (patient)

REFUSE means STOP — report to operator. Do not workaround with cp or ad-hoc builds.

Bypass (operator TTY only): HAPI_OPERATOR_PRODUCTION_MUTATION_OVERRIDE=1

See: docs/tooling/driver-soup.md, docs/tooling/feature-work-lifecycle.md
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

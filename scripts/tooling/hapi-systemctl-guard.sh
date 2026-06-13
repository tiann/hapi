#!/usr/bin/env bash
# Cursor preToolUse hook: refuse direct sudo systemctl operations against
# hapi-hub.service / hapi-runner.service / hapi-runner-watchdog.service.
#
# Blocks Shell tool calls whose command line matches a destructive verb
# (stop|restart|kill|disable|mask|reload-or-restart|reset-failed)
# applied to a hapi-* unit, when invoked under sudo. Wrapper scripts
# (hapi-restart-hub, hapi-use-worktree) are not blocked because they do
# their own patient drain and do not appear literally as "sudo systemctl"
# in the agent's command line.
#
# Operator-local tooling. NOT an upstream/contributor mandate.
#
# Bypass: export HAPI_OPERATOR_SYSTEMCTL_OVERRIDE=1
#
# Why this exists: 2026-06-11 15:01:13 BST outage where an agent ran
# `sudo systemctl stop hapi-hub.service` from their tool-call shell and
# left the hub down 14 minutes. Sudoers cannot reliably prevent this
# (the !command deny syntax is bypassable per sudoers(5)) so the actual
# enforcement happens at the Cursor tool-call layer, where it does not
# matter what binary path is used or whether the call is shell-wrapped.

set -uo pipefail

INPUT=$(cat)

# Extract the command line from any of the likely shapes.
CMD=$(printf '%s' "$INPUT" | jq -r '
    [
      .input.command,
      .tool_input.command,
      .input.cmd,
      .tool_input.cmd,
      .command
    ]
    | map(select(. != null and . != ""))
    | first // empty
' 2>/dev/null || true)

TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // .tool // empty' 2>/dev/null || true)

# If we cannot read the command, fail open. The script-side guards in
# hapi-use-worktree.sh and hapi-restart-hub still apply.
if [ -z "$CMD" ]; then
    echo '{ "permission": "allow" }'
    exit 0
fi

# Operator override - TTY-gated since 2026-06-13. Cursor invokes this
# hook with JSON piped on stdin; operator-driven invocation through a
# Cursor agent has no controlling tty either. The only way [ -t 0 ] is
# true is if a human is running the script directly with stdin from a
# terminal - which is not how Cursor calls it. So this gate effectively
# disables the env-var-alone bypass at the hook layer; the operator
# bypass path is the wrapper at /usr/local/sbin/systemctl (which has
# its own TTY gate against the parent process's controlling terminal).
if [ "${HAPI_OPERATOR_SYSTEMCTL_OVERRIDE:-0}" = "1" ] && [ -t 0 ]; then
    echo '{ "permission": "allow" }'
    exit 0
fi

# Pattern: somewhere in the command line, "sudo" appears AND a destructive
# systemctl verb is applied to a hapi-* unit (with or without .service suffix,
# any binary path resolution).
#
# Verbs we refuse: stop, restart, kill, disable, mask, reload-or-restart,
# reset-failed, daemon-reload-and-restart-target. (start is allowed - it is
# the recovery action.)
#
# Units in scope: hapi-hub, hapi-runner, hapi-runner-watchdog.
#
# We match permissively to catch shell wrapping and binary-path variation:
#   sudo systemctl stop hapi-hub.service                        BLOCK
#   sudo /bin/systemctl restart hapi-hub                        BLOCK
#   sudo /usr/bin/systemctl kill hapi-runner.service            BLOCK
#   sudo bash -c 'systemctl stop hapi-hub.service'              BLOCK (sudo + systemctl + verb + unit literal)
#   hapi-restart-hub                                            ALLOW (no literal systemctl)
#   sudo systemctl status hapi-hub.service                      ALLOW (status is read-only)
#   sudo systemctl start hapi-hub.service                       ALLOW (start = recovery)

SUDO_SYSTEMCTL_RE='(^|[[:space:]])sudo([[:space:]]|$).*systemctl'
DESTRUCTIVE_VERB_RE='(^|[[:space:]])(stop|restart|kill|disable|mask|reload-or-restart|reset-failed)([[:space:]]|$)'
HAPI_UNIT_RE='hapi-(hub|runner|runner-watchdog)(\.service)?($|[[:space:]\";'"'"'])'

if printf '%s' "$CMD" | grep -qiE "$SUDO_SYSTEMCTL_RE" \
   && printf '%s' "$CMD" | grep -qiE "$DESTRUCTIVE_VERB_RE" \
   && printf '%s' "$CMD" | grep -qiE "$HAPI_UNIT_RE"; then
    DENY_MSG=$(cat <<EOF
sudo systemctl operation against a hapi-* service BLOCKED by operator-fork policy.

Command: $CMD
Tool:    ${TOOL:-Shell}

Direct \`sudo systemctl stop|restart|kill|disable|mask hapi-{hub,runner,runner-watchdog}.service\`
yanks WORKING agent sessions mid-turn. The 2026-06-11 15:01:13 BST outage was caused by
exactly this: an agent ran \`sudo systemctl stop hapi-hub.service\` from a tool-call shell
and the hub stayed down 14 minutes until the operator manually restarted.

The supported wrappers do patient drain + auto-restart on failure:

  hapi-restart-hub                  patient hub restart, 10min drain timeout
  hapi-restart-hub --impatient      hung-hub emergency only
  hapi-use-worktree <path>          stack switch with pre-flight schema + auto-revert

If the hub is down and you need to bring it up: \`sudo systemctl start hapi-hub.service\`
is allowed (start is recovery, not destruction). Same for hapi-runner.service.

Bypass for operator-approved emergencies:
  export HAPI_OPERATOR_SYSTEMCTL_OVERRIDE=1

See:
  ~/coding/hapi/.cursor/rules/operator-fork.mdc
  ~/coding/hapi/docs/tooling/driver-soup.md  (patient-restarts section)
EOF
)
    jq -n \
        --arg msg "$DENY_MSG" \
        '{
            permission: "deny",
            agent_message: $msg,
            user_message: "Blocked: sudo systemctl <destructive-verb> against a hapi-* service. Use hapi-restart-hub or hapi-use-worktree, or set HAPI_OPERATOR_SYSTEMCTL_OVERRIDE=1 to bypass."
        }'
    exit 0
fi

echo '{ "permission": "allow" }'
exit 0

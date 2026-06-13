# shellcheck shell=bash
#
# Operator-only TTY gate for bypass env vars.
#
# Source this file via:
#   . "$(dirname "$0")/lib/operator-tty-gate.sh"
# or with an absolute path. Defines:
#   caller_has_controlling_tty   - true if the caller's parent process has
#                                  a controlling terminal (operator at SSH,
#                                  tmux, or local console). False for
#                                  agent-spawned shells (Cursor, Claude,
#                                  Codex, Gemini), cron jobs, and any
#                                  non-interactive context.
#
# Background: bypass env vars (HAPI_OPERATOR_SYSTEMCTL_OVERRIDE,
# HAPI_USE_WORKTREE_FROM_INSIDE, HAPI_USE_WORKTREE_FROM_AGENT,
# HAPI_OPERATOR_PRODUCT_EDIT_OVERRIDE) were abused on 2026-06-13 by an
# agent that read the doc, set the env var, and ran the destructive
# command anyway. The env-var-alone bypass cannot distinguish "operator
# typing in their terminal" from "agent setting environment in a
# tool-call shell". This gate adds the missing check.
#
# How it works: /proc/PID/stat field 7 is tty_nr (the controlling
# terminal device number). Zero means "no controlling terminal".
# Operator interactive shells (bash on a pty from SSH/tmux/console)
# have non-zero tty_nr. Agent tool-call shells have zero (their stdin
# is piped from the agent process, no pty allocated).
#
# Note that the comm field (process name) can contain spaces and
# parentheses. The standard parse pattern is "skip everything up to
# and including the LAST close-paren-space sequence", then split the
# remainder on whitespace. tty_nr is field 5 of that remainder
# (state, ppid, pgrp, session, tty_nr).
#
# Edge cases:
#   - Cron jobs / systemd ExecStart: no tty, gate fails (correct - those
#     should not be running these destructive ops without explicit
#     temporary disable of the wrapper).
#   - Operator running via 'screen -dm' detached: no tty, gate fails
#     (rare; operator should attach the screen first or disable wrapper
#     at the file level for the duration).
#   - Operator running through 'sudo -i' as root from a real terminal:
#     PPID is sudo, sudo inherits the operator's bash tty, gate passes.
#
# This is best-effort and bypassable by a determined adversary
# (e.g. allocating a pty via 'script' from inside an agent shell).
# It IS effective against the realistic threat: agents that set the
# documented env var because the doc said so. That class of mistake
# now fails closed.

caller_has_controlling_tty() {
    local stat_line tty_nr
    [ -r "/proc/$PPID/stat" ] || return 1
    stat_line="$(cat "/proc/$PPID/stat" 2>/dev/null)" || return 1
    # Strip up to and including the final ")" + space (handles spaces
    # in comm). Field 5 of the remainder is tty_nr.
    tty_nr=$(printf '%s' "$stat_line" | sed 's/.*) //' | awk '{print $5}')
    [ -n "$tty_nr" ] && [ "$tty_nr" != "0" ]
}

# Friendly error printer for scripts that refuse a bypass.
operator_bypass_refused() {
    local var="$1"
    local recovery="${2:-See .cursor/rules/operator-fork.mdc for recovery options.}"
    cat >&2 <<EOF

REFUSE: $var=1 was set, but caller has no controlling terminal.

This bypass is operator-only — meant for an operator typing at a real
SSH, tmux, or local console session. Agent tool-call shells (Cursor,
Claude Code, Codex, Gemini) have piped stdin and no controlling tty,
so the bypass env var is ignored.

If you are an agent and you set this on purpose: stop. The destructive
operation behind this guard kills running sessions, including yours.
The supported wrappers (hapi-restart-hub, hapi-use-worktree) do
patient drain and are safe.

If you are an operator and you genuinely need the bypass:
  - Run the command from a real terminal (SSH, tmux, local console).
  - Or temporarily disable the wrapper at file level:
      sudo mv /usr/local/sbin/systemctl{,.disabled}
      <do the thing>
      sudo mv /usr/local/sbin/systemctl{.disabled,}

$recovery

EOF
}

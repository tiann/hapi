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
# HAPI_OPERATOR_PRODUCT_EDIT_OVERRIDE) were used on 2026-06-13 by an
# agent that read the doc, found the env var listed under "operator
# emergency bypass", and used it as a tool to do what it thought the
# operator wanted. That is not adversarial behaviour - it is the
# expected behaviour of a system whose documentation lists a bypass
# path with insufficient friction against using it.
#
# The env-var-alone bypass cannot distinguish "operator typing in their
# terminal" from "agent setting environment in a tool-call shell". This
# gate adds the missing signal: the parent process's controlling
# terminal. It does not catch every conceivable bypass (see "Bypass
# surface" below), and it should not be read as a fence to keep agents
# out. The right way to read it: the supported path through hapi-
# restart-hub / hapi-use-worktree is now the path of least resistance
# again, because the env-var-alone shortcut no longer works from agent
# tool-call shells.
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
# Bypass surface (these are not failure modes; they are the next
# tooling-gap items, not signals of agent intent):
#
#   - 'script -q -c "..." /dev/null' from inside an agent shell
#     allocates a pty for the wrapped command, making tty_nr non-zero.
#     If a future agent ends up here, the cause is almost certainly
#     that the supported wrapper hung or did not exist for what they
#     needed - not that the agent set out to defeat the gate. The
#     response is to fix the supported wrapper or document the
#     missing one, not to layer more detection.
#   - 'python -c "import pty; pty.spawn(...)"' and equivalents in
#     other languages. Same reasoning.
#   - cron jobs and systemd ExecStart, which legitimately have no
#     tty. If those paths need destructive ops, they need their own
#     supported entry-point with explicit operator approval at install
#     time (e.g. a separate sudoers rule with a unit-name whitelist),
#     not env-var bypass.
#
# Reading the gate in production: a 'BLOCKED (operator override
# IGNORED - no controlling tty)' line in the journal is a signal that
# (a) something needed a destructive op and (b) the supported path was
# not obvious enough. That is a tooling backlog item, not a security
# alert.

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

This bypass is operator-only - meant for an operator typing at a real
SSH, tmux, or local console session. Agent tool-call shells have piped
stdin and no controlling tty, so the env var is ignored from those
contexts.

If you are an agent and you arrived here because something hung:
  - 'hapi-restart-hub' is the supported patient hub restart.
  - 'HAPI_IMPATIENT=1 hapi-restart-hub' skips the patience budget.
  - 'sudo systemctl restart hapi-runner.service' is allowed and
    sometimes the right answer when only the runner is wedged.
  - The hub journal ('sudo journalctl -u hapi-hub.service -n 50')
    usually says what is actually wrong.

If you are an operator and you genuinely need the bypass:
  - Run the command from a real terminal (SSH, tmux, local console).
  - Or temporarily disable the wrapper at file level:
      sudo mv /usr/local/sbin/systemctl{,.disabled}
      <do the thing>
      sudo mv /usr/local/sbin/systemctl{.disabled,}

$recovery

EOF
}

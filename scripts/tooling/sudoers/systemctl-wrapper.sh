#!/usr/bin/env bash
# Operator-fork systemctl wrapper — agent-agnostic guard for hapi-* units.
#
# Installed at /usr/local/sbin/systemctl. sudo's secure_path
# (/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin) resolves
# this wrapper FIRST, so any `sudo systemctl ...` call from any agent
# (Cursor, Claude, Codex, Gemini, cron, random shell) goes through it
# before reaching /bin/systemctl.
#
# Coverage: this is the cross-agent enforcement layer. The Cursor
# preToolUse hook (scripts/tooling/hapi-systemctl-guard.sh) catches
# Cursor agents before sudo even fires. The sudoers !-rule
# (/etc/sudoers.d/hapi-protect) catches direct invocations against
# /bin/systemctl and /usr/bin/systemctl with stable binary paths. This
# wrapper catches everyone else, including:
#   - Claude Code: sudo systemctl stop hapi-hub.service
#   - Codex CLI: sudo systemctl restart hapi-hub.service
#   - Any agent doing sudo bash -c 'systemctl stop hapi-hub.service'
#     (because bash inherits sudo's PATH which starts with /usr/local/sbin)
#
# What this wrapper does NOT catch:
#   - sudo /bin/systemctl stop hapi-hub.service  (absolute path)
#     -> sudoers !-rule catches that directly.
#   - sudo cp /bin/systemctl /tmp/x; sudo /tmp/x stop hapi-hub.service
#     -> deliberate evasion. Documented as the kill-criterion case in
#        the policy: at this point the agent is consciously bypassing
#        multiple guards and the failure mode shifts to "audit + remove
#        agent" not "tooling fix".
#
# Bypass for legitimate operator emergencies:
#   HAPI_OPERATOR_SYSTEMCTL_OVERRIDE=1 sudo systemctl stop hapi-hub.service
#
# Test before installing — a bug here breaks ALL systemctl calls on
# the system. Installer (install-systemctl-wrapper.sh) runs a smoke test
# against allowed verbs and refuses to install if any fail.

set -uo pipefail

# Real systemctl. /bin/systemctl is the canonical Debian/Ubuntu path; on
# other distros /usr/bin/systemctl may be the only one. Resolve at runtime.
REAL_SYSTEMCTL=""
for candidate in /bin/systemctl /usr/bin/systemctl; do
    if [ -x "$candidate" ]; then
        REAL_SYSTEMCTL="$candidate"
        break
    fi
done
if [ -z "$REAL_SYSTEMCTL" ]; then
    echo "hapi-systemctl-wrapper: cannot find real systemctl binary" >&2
    exit 127
fi

# Operator override — same env-var name as the Cursor hook for consistency.
if [ "${HAPI_OPERATOR_SYSTEMCTL_OVERRIDE:-0}" = "1" ]; then
    exec "$REAL_SYSTEMCTL" "$@"
fi

# Walk argv: find the verb (first non-flag, non-option-value) and the
# unit name(s) (everything after the verb). Conservative: if we cannot
# parse confidently, fall through to the real binary. Better to
# accidentally allow than break a legitimate operator command.

VERB=""
UNITS=()
i=0
SKIP_NEXT=0
for arg in "$@"; do
    i=$((i + 1))
    if [ "$SKIP_NEXT" = "1" ]; then
        SKIP_NEXT=0
        continue
    fi
    case "$arg" in
        # Options that take a value in the next argv (skip both)
        -t|-p|-P|-M|--type|--property|--state|--unit|--host|--machine|--root|--signal|--kill-who|--user-unit|--mark|--what)
            SKIP_NEXT=1
            continue
            ;;
        # Options that bundle the value with =
        --type=*|--property=*|--state=*|--unit=*|--host=*|--machine=*|--root=*|--signal=*|--kill-who=*|--user-unit=*|--mark=*|--what=*)
            continue
            ;;
        # Pure flags
        -*)
            continue
            ;;
        *)
            if [ -z "$VERB" ]; then
                VERB="$arg"
            else
                UNITS+=("$arg")
            fi
            ;;
    esac
done

# Destructive verbs we refuse for hapi-* units.
case "$VERB" in
    stop|restart|kill|disable|mask|reload-or-restart|reset-failed|try-restart|reload-or-try-restart)
        DESTRUCTIVE=1
        ;;
    *)
        DESTRUCTIVE=0
        ;;
esac

if [ "$DESTRUCTIVE" = "0" ]; then
    exec "$REAL_SYSTEMCTL" "$@"
fi

# Destructive verb. Check whether ANY of the units in argv are protected.
PROTECTED_HIT=""
for unit in "${UNITS[@]+"${UNITS[@]}"}"; do
    bare="${unit%.service}"
    case "$bare" in
        hapi-hub|hapi-runner|hapi-runner-watchdog)
            PROTECTED_HIT="$unit"
            break
            ;;
    esac
done

if [ -z "$PROTECTED_HIT" ]; then
    exec "$REAL_SYSTEMCTL" "$@"
fi

# Hit. Refuse with operator-friendly message.
cat >&2 <<EOF

hapi-systemctl-wrapper: BLOCKED

Command:  systemctl $VERB $PROTECTED_HIT (and any other args)
Caller:   uid=$(id -u) user=$(id -un) (sudo invoker: ${SUDO_USER:-unknown}, sudo uid=${SUDO_UID:-0})
Wrapper:  /usr/local/sbin/systemctl  -> protects hapi-* units across all agents

A '$VERB' against a hapi-* service yanks WORKING agents mid-turn. The
2026-06-11 15:01:13 BST outage was caused by exactly this: an agent ran
'sudo systemctl stop hapi-hub.service' from a tool-call shell and the
hub stayed down 14 minutes until the operator manually restarted.

Use the supported wrappers:
  hapi-restart-hub                  patient drain, 10min timeout
  hapi-restart-hub --impatient      hung-hub emergency only
  hapi-use-worktree <path>          stack switch with pre-flight + auto-revert

Allowed without bypass: start, status, is-active, show, list-units, etc.
(Read-only and recovery operations are not blocked.)

Bypass for operator-approved emergencies:
  HAPI_OPERATOR_SYSTEMCTL_OVERRIDE=1 sudo systemctl $VERB $PROTECTED_HIT

See ~/coding/hapi/.cursor/rules/operator-fork.mdc for the full policy.

EOF
exit 1

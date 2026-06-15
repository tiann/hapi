#!/usr/bin/env bash
# Operator-fork tailscale wrapper - agent-agnostic guard for the
# implicitly-destructive tailscale verbs.
#
# Installed at /usr/local/sbin/tailscale. sudo's secure_path
# (/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin) resolves
# this wrapper FIRST, so any `sudo tailscale ...` call from any agent
# (Cursor, Claude, Codex, Gemini, cron, random shell) goes through it
# before reaching /usr/bin/tailscale. Non-sudo `tailscale` calls go
# through PATH normally - and the guarded verbs all require sudo because
# the state file is root-owned, so the destructive surface is fully
# covered.
#
# Three classes of guarded verbs - everything else passes through:
#
#   Class A: `tailscale up` with flags lacking --advertise-services and
#            --advertise-tags. Every `tailscale up` call resets daemon
#            prefs to whatever flags are on the command line; anything
#            unnamed gets wiped silently. The 2026-06-15 evening
#            incident: three `up` calls in 35 seconds with no preservation
#            flags, AdvertiseServices=[] silently, all 8 svc:* on proxmox
#            went dark for an hour. Bare `tailscale up` (no flags) is
#            pass-through - it restores saved prefs without altering them.
#
#   Class B: `tailscale serve reset`. Wipes EVERY serve config on the
#            node in one stroke. The systemd `tailscale-serve-*.service`
#            units (Type=oneshot RemainAfterExit=yes) keep reporting
#            active=active after the wipe because they remember the
#            old success. The 2026-06-15 morning incident: agent ran
#            `serve reset` as cleanup after a successful Taildrop, took
#            8 services down silently.
#
#   Class C: `tailscale logout`. Destroys node identity and triggers
#            implicit `tailscale down`. Bringing back requires `up
#            --authkey=$TS_AUTHKEY` which itself has the Class A trap.
#            Almost never a legitimate cleanup verb on a service host.
#
# `tailscale down` is NOT guarded (stops daemon, doesn't destroy state).
# Every other subcommand (status, set, serve {advertise,clear,off,status},
# ip, debug, ping, ...) passes through unchanged.
#
# Bypass for legitimate operator one-offs (re-enrolment, key rotation,
# explicit per-host cleanup):
#   HAPI_OPERATOR_TAILSCALE_OK=1 sudo tailscale <verb> <args>
# That env var only takes effect from a TTY - agent tool-call shells
# have tty_nr=0 on the parent and cannot set+honour it.

set -uo pipefail

# Dry-run mode for the installer's smoke test: print what would be exec'd
# rather than execing the real binary. Lets us smoke pass-through paths
# (which are an exec into a stateful daemon) without mutating live state.
# Only honoured when the env var is set; ignored otherwise.
_dryrun_or_exec() {
    if [ "${HAPI_TAILSCALE_WRAPPER_DRYRUN:-0}" = "1" ]; then
        printf 'DRYRUN-PASS:'
        printf ' %q' "$@"
        printf '\n'
        exit 0
    fi
    exec "$@"
}

REAL_TAILSCALE=""
for candidate in /usr/bin/tailscale /usr/local/bin/tailscale.real; do
    if [ -x "$candidate" ]; then
        REAL_TAILSCALE="$candidate"
        break
    fi
done
if [ -z "$REAL_TAILSCALE" ]; then
    echo "hapi-tailscale-wrapper: cannot find real tailscale binary" >&2
    exit 127
fi

# If invoked as the real binary directly (loop guard), bypass.
if [ "${0##*/}" = "tailscale.real" ]; then
    _dryrun_or_exec "$REAL_TAILSCALE" "$@"
fi

# Subcommand routing. Three classes of guarded verbs, everything else
# passes through.
#
# Class A: `tailscale up` with flags lacking preservation - implicit-wipe
#          of AdvertiseServices / AdvertiseTags. The 2026-06-15 evening
#          incident shape.
# Class B: `tailscale serve reset` - wipes EVERY serve config on the node
#          in one stroke. The 2026-06-15 morning incident shape (took 8
#          services down at once on this multi-service host).
# Class C: `tailscale logout` - destroys node identity and triggers an
#          implicit `tailscale down`. Almost never a legitimate cleanup
#          verb on a service host.
#
# `tailscale down` is NOT guarded: it just stops the daemon without
# destroying state, and `tailscale up` (no flags) restores. Treated as
# pass-through; if it becomes a problem, add Class D.

SUBCMD="${1:-}"

# Helper: detect "tailscale serve reset" anywhere in the argv. The reset
# subcommand can appear as `tailscale serve reset` or with flags between.
_is_serve_reset() {
    local seen_serve=0
    for arg in "$@"; do
        case "$arg" in
            serve) seen_serve=1 ;;
            reset)
                if [ "$seen_serve" = "1" ]; then return 0; fi
                ;;
        esac
    done
    return 1
}

# Class B: serve reset - guard regardless of any flags present.
if _is_serve_reset "$@"; then
    GUARDED_VERB="serve-reset"
elif [ "$SUBCMD" = "logout" ]; then
    # Class C: logout
    GUARDED_VERB="logout"
elif [ "$SUBCMD" = "up" ]; then
    # Class A: up (with extra checks below)
    # Bare `tailscale up` (no flags): pass through (restores saved prefs,
    # does not alter them).
    if [ "$#" -eq 1 ]; then
        _dryrun_or_exec "$REAL_TAILSCALE" "$@"
    fi
    GUARDED_VERB="up"
else
    # Every other tailscale subcommand passes through.
    _dryrun_or_exec "$REAL_TAILSCALE" "$@"
fi

# Class A only: walk argv looking for the two required preservation
# flags. Match both `--flag value` and `--flag=value` shapes. We don't
# care what the values are - if the operator/agent has named the flag,
# they have explicitly decided what to set it to (even empty). The trap
# is the SILENT wipe.
if [ "$GUARDED_VERB" = "up" ]; then
    HAS_ADV_SERVICES=0
    HAS_ADV_TAGS=0
    for arg in "$@"; do
        case "$arg" in
            --advertise-services|--advertise-services=*) HAS_ADV_SERVICES=1 ;;
            --advertise-tags|--advertise-tags=*) HAS_ADV_TAGS=1 ;;
        esac
    done

    if [ "$HAS_ADV_SERVICES" = "1" ] && [ "$HAS_ADV_TAGS" = "1" ]; then
        _dryrun_or_exec "$REAL_TAILSCALE" "$@"
    fi
fi

# TTY check: parent process has controlling terminal? /proc-based, no
# external dependency. Operator interactive shell has tty_nr != 0 on
# parent; agent tool-call shell has tty_nr = 0.
_stat="$(cat "/proc/$PPID/stat" 2>/dev/null)" || _stat=""
_tty_nr=$(printf '%s' "$_stat" | sed 's/.*) //' | awk '{print $5}')
if [ -n "$_tty_nr" ] && [ "$_tty_nr" != "0" ]; then
    CALLER_HAS_TTY=1
else
    CALLER_HAS_TTY=0
fi

# Operator override env: only honoured from TTY. Agent shells inheriting
# the env var still get refused because they have no TTY.
if [ "${HAPI_OPERATOR_TAILSCALE_OK:-0}" = "1" ] && [ "$CALLER_HAS_TTY" = "1" ]; then
    cat >&2 <<EOF
hapi-tailscale-wrapper: HAPI_OPERATOR_TAILSCALE_OK=1 set on a controlling
TTY - allowing \`tailscale $GUARDED_VERB\` call.
EOF
    _dryrun_or_exec "$REAL_TAILSCALE" "$@"
fi

# Verb-specific banners. Same TTY-vs-non-TTY discipline: TTY operator
# gets a warning + override hint, non-TTY agent shell gets a hard refusal
# with did-you-mean menu.

_banner_up() {
    cat >&2 <<EOF
\`tailscale up\` was called with flags, but neither --advertise-services
nor --advertise-tags is in the argv. This call WILL silently wipe one
or both of:
  AdvertiseServices  ->  every svc:* on this node stops being announced
                         to the tailnet, peers see TCP timeout / TLS EOF
  AdvertiseTags      ->  all 28 tags stripped, ACL bindings stop matching

The local serve config and Funnel certs would stay intact but be
unreachable from any peer. The 2026-06-15 20:56 incident on this host
took 8 services dark for an hour exactly this way.

DID YOU MEAN one of:

  # change one pref without touching anything else (the surgical path)
  sudo tailscale set --accept-dns=true
  sudo tailscale set --hostname=newname
  sudo tailscale set --advertise-routes=192.168.86.0/24

  # add or remove a service announcement (no \`up\` needed)
  sudo tailscale serve advertise svc:<name>
  sudo tailscale serve --service=svc:<name> --https=443 off
  sudo tailscale serve clear svc:<name>

  # if you genuinely need to re-up (rare), name every preservation flag:
  sudo tailscale up \\
    --authkey=\$TS_AUTHKEY \\
    --hostname=proxmox \\
    --advertise-tags=tag:activitywatch,tag:chat,...,tag:webdav  (all 28) \\
    --advertise-services=svc:hapi,svc:activitywatch,svc:cursor-d,svc:cursorvox,svc:garden,svc:local-jessica,svc:noobscribe,svc:ntfy \\
    --advertise-routes=192.168.86.0/24 \\
    --accept-routes \\
    --accept-dns=true
EOF
}

_banner_serve_reset() {
    cat >&2 <<EOF
\`tailscale serve reset\` wipes EVERY serve config on this node, not just
the one you most recently added. This host publishes 8 Tailscale Services
(hapi, activitywatch, cursor-d, cursorvox, garden, local-jessica,
noobscribe, ntfy). One \`serve reset\` takes all 8 dark.

The systemd \`tailscale-serve-*.service\` units are \`Type=oneshot
RemainAfterExit=yes\` - they keep reporting active=active after the
reset because they remember the old success. The actual state is gone
silently. The 2026-06-15 12:15 incident on this host took 8 services
down via this exact verb.

DID YOU MEAN per-service teardown (the safe alternative):

  # disable serve for ONE service only - leaves other services intact
  sudo tailscale serve --service=svc:<name> --https=443 off
  sudo tailscale serve clear svc:<name>

  # enumerate before any reset (to see what you would actually wipe):
  sudo tailscale serve status
EOF
}

_banner_logout() {
    cat >&2 <<EOF
\`tailscale logout\` destroys this node's identity (machine key, node ID,
authentication state) AND triggers an implicit \`tailscale down\`. Bringing
back up requires re-enrolment via \`tailscale up --authkey=\$TS_AUTHKEY\`,
which on this host has the implicit-wipe trap (see Class A above).

Almost never a legitimate cleanup verb on a multi-service host. If you're
trying to switch identities (e.g. for Taildrop egress to user-owned
devices), use a sibling userspace tailscaled (\`tailscale-personal.service\`
on this host), do not logout the main daemon.

DID YOU MEAN one of:

  # use the personal tailscaled for cross-identity ops:
  ~/coding/server-setup/scripts/tailscale/taildrop-heavygee.sh <file> <target>

  # check current identity and tailnet without changing state:
  sudo tailscale status
  sudo tailscale debug prefs
EOF
}

if [ "$CALLER_HAS_TTY" = "1" ]; then
    case "$GUARDED_VERB" in
        up) _banner_up ;;
        serve-reset) _banner_serve_reset ;;
        logout) _banner_logout ;;
    esac
    cat >&2 <<EOF

If this is genuinely what you want, re-run as:
  HAPI_OPERATOR_TAILSCALE_OK=1 $0 $*

Refusing this call.
EOF
    exit 1
fi

# Non-TTY agent shell with destructive call: hard refuse with a "did
# you mean" menu. This is the primary trap-plugging path.
echo "hapi-tailscale-wrapper: REFUSED ($GUARDED_VERB)" >&2
echo >&2
case "$GUARDED_VERB" in
    up) _banner_up ;;
    serve-reset) _banner_serve_reset ;;
    logout) _banner_logout ;;
esac
cat >&2 <<EOF

Operator one-off bypass (only honoured at a TTY):
  HAPI_OPERATOR_TAILSCALE_OK=1 sudo tailscale $GUARDED_VERB <args>

Docs: ~/coding/skills/tailscale/SKILL.md
      ~/coding/server-setup/AGENTS.md
EOF
exit 1

#!/usr/bin/env bash
# Install the operator-fork tailscale wrapper at /usr/local/sbin/tailscale.
#
# This is the cross-agent enforcement layer for the `tailscale up` implicit-
# wipe trap. sudo's secure_path resolves /usr/local/sbin/<bin> first, so this
# wrapper catches every `sudo tailscale up ...` call regardless of which
# agent (Cursor, Claude, Codex, Gemini) issued it. Non-sudo `tailscale up`
# is impossible because the state file is root-owned, so this is full
# coverage of the destructive surface.
#
# The wrapper REFUSES `tailscale up <flags>` from non-TTY callers (agent
# tool-call shells) when neither --advertise-services nor --advertise-tags
# is in argv - those are the two flags that cause the silent-wipe outage
# we keep hitting. Pass-through for every other tailscale subcommand,
# bare `tailscale up` (no flags), and TTY-bypassed via env var.
#
# Idempotent: rewrites /usr/local/sbin/tailscale each run, smoke-tests the
# wrapper against destructive + benign call shapes before installing the
# live link, preserves the previous wrapper at /usr/local/sbin/tailscale.prev.
#
# Smoke tests run the wrapper directly with HAPI_TAILSCALE_WRAPPER_DRYRUN=1
# (so pass-through cases print "DRYRUN-PASS" instead of execing the real
# tailscaled, which would mutate live state).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="${REPO_ROOT}/scripts/tooling/sudoers/tailscale-wrapper.sh"
DST="/usr/local/sbin/tailscale"
PREV="/usr/local/sbin/tailscale.prev"
TMP="$(mktemp /tmp/tailscale-wrapper.XXXXXX)"
trap 'rm -f "$TMP"' EXIT

if [ ! -f "$SRC" ]; then
    echo "ERROR: source missing: $SRC" >&2
    exit 1
fi

cp "$SRC" "$TMP"
chmod 0755 "$TMP"

echo "Smoke testing wrapper at $TMP ..."
SMOKE_FAIL=0

run_smoke() {
    local label="$1"; shift
    local expect="$1"; shift  # PASS | REFUSED
    local out rc
    out=$(HAPI_TAILSCALE_WRAPPER_DRYRUN=1 "$TMP" "$@" 2>&1) || rc=$? && rc=${rc:-0}
    case "$expect" in
        PASS)
            if printf '%s' "$out" | grep -q '^DRYRUN-PASS:'; then
                echo "  OK:   $label -> pass-through"
            else
                echo "  FAIL: $label -> expected pass-through, got:" >&2
                printf '         %s\n' "$out" >&2
                SMOKE_FAIL=1
            fi
            ;;
        REFUSED)
            if printf '%s' "$out" | grep -q 'REFUSED\|did you mean\|Refusing this call'; then
                echo "  OK:   $label -> refused"
            else
                echo "  FAIL: $label -> expected refusal, got:" >&2
                printf '         %s\n' "$out" >&2
                SMOKE_FAIL=1
            fi
            ;;
    esac
}

# A: bare `tailscale up` (no flags) -> pass through (restores saved prefs).
run_smoke "bare 'tailscale up' (no flags)" PASS up

# B: `tailscale status` -> pass through (read-only).
run_smoke "'tailscale status'" PASS status

# C: `tailscale set --accept-dns=true` -> pass through (surgical, non-destructive).
run_smoke "'tailscale set --accept-dns=true'" PASS set --accept-dns=true

# D: `tailscale serve advertise svc:foo` -> pass through.
run_smoke "'tailscale serve advertise svc:foo'" PASS serve advertise svc:foo

# E: REFUSE `up --hostname=foo` (the bare-trap shape).
run_smoke "'up --hostname=foo' (no preservation flags)" REFUSED up --hostname=foo

# F: REFUSE `up --authkey=x --hostname=y` (the 2026-06-15 incident shape #1).
run_smoke "'up --authkey=x --hostname=y' (incident shape #1)" REFUSED up --authkey=tskey-test --hostname=proxmox

# G: REFUSE `up --authkey=x --hostname=y --reset` (incident shape #2 - reset alone is not enough).
run_smoke "'up --reset' (no preservation flags)" REFUSED up --authkey=tskey-test --hostname=proxmox --reset

# H: REFUSE `up --authkey=x --advertise-tags=t1 --reset` (only one of two preservation flags).
run_smoke "'up --advertise-tags only' (still one flag missing)" REFUSED up --authkey=tskey-test --advertise-tags=tag:hapi --reset

# I: REFUSE `up --advertise-services=s --hostname=h` (only services, missing tags).
run_smoke "'up --advertise-services only' (still one flag missing)" REFUSED up --advertise-services=svc:hapi --hostname=proxmox

# J: ALLOW `up` with both preservation flags named (the right-shape call).
run_smoke "'up --advertise-services=... --advertise-tags=...' (right shape)" PASS \
    up --authkey=tskey-test --hostname=proxmox \
    --advertise-services=svc:hapi,svc:activitywatch \
    --advertise-tags=tag:hapi,tag:activitywatch \
    --accept-dns=true --accept-routes

# K: ALLOW `up --reset` with both preservation flags (operator did the work).
run_smoke "'up --reset --advertise-services=... --advertise-tags=...' (explicit reset)" PASS \
    up --reset --advertise-services=svc:hapi --advertise-tags=tag:hapi --hostname=proxmox

# Class B (serve reset): REFUSE.
run_smoke "'serve reset' (the morning incident verb)" REFUSED serve reset

# ALLOW per-service teardown (not the global reset).
run_smoke "'serve --service=svc:foo --https=443 off' (per-service teardown)" PASS \
    serve --service=svc:foo --https=443 off
run_smoke "'serve clear svc:foo' (per-service teardown)" PASS serve clear svc:foo
run_smoke "'serve advertise svc:foo' (per-service announce)" PASS serve advertise svc:foo
run_smoke "'serve status' (read-only)" PASS serve status

# Class C (logout): REFUSE.
run_smoke "'logout' (destroys node identity)" REFUSED logout

# ALLOW related but harmless verbs.
run_smoke "'down' (stops daemon, doesn't destroy state)" PASS down
run_smoke "'debug prefs' (read-only)" PASS debug prefs

# L: TTY override env var: only honoured at TTY. From this installer's
# context (which IS a TTY for the operator running this script), the
# override should bypass. From a non-TTY shell it should refuse with the
# refusal banner. Either is acceptable as smoke - just check the wrapper
# didn't crash.
if [ -t 0 ]; then
    out=$(HAPI_TAILSCALE_WRAPPER_DRYRUN=1 HAPI_OPERATOR_TAILSCALE_OK=1 "$TMP" up --hostname=proxmox 2>&1) || true
    if printf '%s' "$out" | grep -q '^DRYRUN-PASS:'; then
        echo "  OK:   TTY context: HAPI_OPERATOR_TAILSCALE_OK=1 bypasses guard"
    else
        echo "  WARN: TTY context: override did not bypass; got:" >&2
        printf '         %s\n' "$out" >&2
    fi
else
    out=$(HAPI_TAILSCALE_WRAPPER_DRYRUN=1 HAPI_OPERATOR_TAILSCALE_OK=1 "$TMP" up --hostname=proxmox 2>&1) || true
    if printf '%s' "$out" | grep -q 'REFUSED\|did you mean'; then
        echo "  OK:   no-TTY context: override correctly refused (the agent-shell defence)"
    else
        echo "  FAIL: no-TTY context: override should have been refused" >&2
        SMOKE_FAIL=1
    fi
fi

if [ "$SMOKE_FAIL" = "1" ]; then
    echo
    echo "ABORT: smoke test failed; not installing" >&2
    exit 1
fi

echo
echo "Smoke test passed. Installing to $DST"
echo

if [ -f "$DST" ]; then
    sudo cp "$DST" "$PREV"
    echo "Backup: $PREV"
fi

sudo cp "$TMP" "$DST"
sudo chmod 0755 "$DST"
sudo chown root:root "$DST"

echo "Installed $DST"
echo
echo "Verification (against the live wrapper, via sudo, dry-run only):"

# Live test 1: REFUSE the incident shape #1 (no preservation flags).
LIVE_OUT=$(sudo HAPI_TAILSCALE_WRAPPER_DRYRUN=1 /usr/local/sbin/tailscale up --authkey=tskey-test --hostname=proxmox 2>&1 || true)
if printf '%s' "$LIVE_OUT" | grep -q 'REFUSED\|did you mean'; then
    echo "  OK:   live wrapper refuses 'sudo tailscale up --authkey=... --hostname=...'"
else
    echo "  WARN: live wrapper does NOT refuse - investigate" >&2
    printf '  output was: %s\n' "$LIVE_OUT" >&2
fi

# Live test 2: PASS pass-through (read-only).
LIVE_OUT2=$(sudo HAPI_TAILSCALE_WRAPPER_DRYRUN=1 /usr/local/sbin/tailscale status 2>&1 || true)
if printf '%s' "$LIVE_OUT2" | grep -q '^DRYRUN-PASS:'; then
    echo "  OK:   live wrapper passes through 'sudo tailscale status'"
else
    echo "  WARN: live wrapper did not pass through status; got:" >&2
    printf '         %s\n' "$LIVE_OUT2" >&2
fi

# Live test 3: PASS bare `tailscale up` (no flags).
LIVE_OUT3=$(sudo HAPI_TAILSCALE_WRAPPER_DRYRUN=1 /usr/local/sbin/tailscale up 2>&1 || true)
if printf '%s' "$LIVE_OUT3" | grep -q '^DRYRUN-PASS:'; then
    echo "  OK:   live wrapper passes through bare 'sudo tailscale up'"
else
    echo "  WARN: live wrapper did not pass through bare up; got:" >&2
    printf '         %s\n' "$LIVE_OUT3" >&2
fi

echo
echo "Cross-agent coverage now includes Cursor + Claude + Codex + Gemini + any other"
echo "agent or shell that calls 'sudo tailscale up'. Bypass via:"
echo "  HAPI_OPERATOR_TAILSCALE_OK=1 sudo tailscale up <args>     (TTY only)"
echo
echo "Surgical alternatives (no wrapper friction):"
echo "  sudo tailscale set --<flag>=<value>"
echo "  sudo tailscale serve advertise svc:<name>"
echo "  sudo tailscale serve --service=svc:<name> --https=443 off"
echo
echo "Rollback: sudo mv $PREV $DST  (or sudo rm $DST if no prev)"

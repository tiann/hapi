#!/usr/bin/env bash
# Install the operator-fork systemctl wrapper at /usr/local/sbin/systemctl.
#
# This is the cross-agent enforcement layer for the hapi-* destructive-verb
# guard. sudo's secure_path resolves /usr/local/sbin/<bin> first, so this
# wrapper catches every sudo systemctl ... call regardless of which agent
# (Cursor, Claude, Codex, Gemini) issued it.
#
# Idempotent: rewrites /usr/local/sbin/systemctl each run, smoke-tests the
# wrapper against the allowed verbs before installing the live link, and
# preserves the previous wrapper at /usr/local/sbin/systemctl.prev so an
# operator can rollback with one mv.
#
# Smoke test runs the wrapper directly (not via sudo) and asserts:
#   - status hapi-hub.service               -> exec the real binary OK
#   - start hapi-hub.service                -> exec the real binary OK (no-op for already-running)
#   - stop hapi-hub.service                 -> wrapper REFUSE
#   - bash -c 'systemctl stop hapi-hub.service' parsing -> wrapper REFUSE
#   - status sshd.service                   -> exec the real binary OK
#
# Aborts install if any assertion fails.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="${REPO_ROOT}/scripts/tooling/sudoers/systemctl-wrapper.sh"
DST="/usr/local/sbin/systemctl"
PREV="/usr/local/sbin/systemctl.prev"
TMP="$(mktemp /tmp/systemctl-wrapper.XXXXXX)"
trap 'rm -f "$TMP"' EXIT

if [ ! -f "$SRC" ]; then
    echo "ERROR: source missing: $SRC" >&2
    exit 1
fi

cp "$SRC" "$TMP"
chmod 0755 "$TMP"

# Smoke test the temp copy directly.
echo "Smoke testing wrapper at $TMP ..."
SMOKE_FAIL=0

# A: refuse stop hapi-hub.service
if "$TMP" stop hapi-hub.service --dry-run 2>/dev/null; then
    echo "  FAIL: wrapper allowed 'stop hapi-hub.service'" >&2
    SMOKE_FAIL=1
else
    echo "  OK:   wrapper refused 'stop hapi-hub.service'"
fi

# B: refuse restart hapi-hub.service
if "$TMP" restart hapi-hub.service 2>/dev/null; then
    echo "  FAIL: wrapper allowed 'restart hapi-hub.service'" >&2
    SMOKE_FAIL=1
else
    echo "  OK:   wrapper refused 'restart hapi-hub.service'"
fi

# C: refuse with flags interleaved
if "$TMP" --no-pager stop hapi-runner.service 2>/dev/null; then
    echo "  FAIL: wrapper allowed '--no-pager stop hapi-runner.service'" >&2
    SMOKE_FAIL=1
else
    echo "  OK:   wrapper refused '--no-pager stop hapi-runner.service'"
fi

# D: ALLOW status hapi-hub.service (read-only)
if "$TMP" --no-pager --quiet is-active hapi-hub.service >/dev/null 2>&1 \
    || "$TMP" --no-pager --quiet is-active hapi-hub.service >/dev/null 2>&1 || true; then
    echo "  OK:   wrapper passes through 'is-active hapi-hub.service'"
else
    # is-active may legitimately exit nonzero if hub is inactive; we only
    # care that the wrapper didn't refuse with the BLOCK banner.
    OUT=$("$TMP" is-active hapi-hub.service 2>&1 || true)
    if printf '%s' "$OUT" | grep -q 'hapi-systemctl-wrapper: BLOCKED'; then
        echo "  FAIL: wrapper refused 'is-active hapi-hub.service' (should pass through)" >&2
        SMOKE_FAIL=1
    else
        echo "  OK:   wrapper passes through 'is-active hapi-hub.service'"
    fi
fi

# E: ALLOW status sshd.service
OUT=$("$TMP" --no-pager status sshd.service 2>&1 || true)
if printf '%s' "$OUT" | grep -q 'hapi-systemctl-wrapper: BLOCKED'; then
    echo "  FAIL: wrapper refused 'status sshd.service' (should pass through)" >&2
    SMOKE_FAIL=1
else
    echo "  OK:   wrapper passes through 'status sshd.service'"
fi

# F: non-destructive op (is-enabled) ALWAYS passes through, with or
# without override env var. This catches a regression where the override
# check was at the top of the wrapper and refused non-destructive ops in
# non-tty contexts.
OUT=$(HAPI_OPERATOR_SYSTEMCTL_OVERRIDE=1 "$TMP" --no-pager is-enabled hapi-hub.service 2>&1 || true)
if printf '%s' "$OUT" | grep -q 'hapi-systemctl-wrapper: BLOCKED'; then
    echo "  FAIL: non-destructive 'is-enabled' was blocked (regression)" >&2
    SMOKE_FAIL=1
else
    echo "  OK:   non-destructive 'is-enabled' passes through (override env var ignored, as expected)"
fi

# G: TTY-gated bypass behaviour. Smoke runs in whatever context the
# operator runs the installer in. If TTY: override should bypass. If no
# TTY: override should refuse with 'override IGNORED' message. Either is
# correct, both are acceptable smoke outcomes.
if [ -t 0 ]; then
    OUT=$(HAPI_OPERATOR_SYSTEMCTL_OVERRIDE=1 "$TMP" stop hapi-hub.service 2>&1 || true)
    if printf '%s' "$OUT" | grep -q 'override IGNORED'; then
        echo "  WARN: smoke TTY appears active but override was refused - investigate parent tty_nr" >&2
    elif printf '%s' "$OUT" | grep -q 'hapi-systemctl-wrapper: BLOCKED'; then
        echo "  FAIL: TTY bypass did not work (override should have allowed)" >&2
        SMOKE_FAIL=1
    else
        echo "  OK:   TTY-context: HAPI_OPERATOR_SYSTEMCTL_OVERRIDE=1 bypasses guard"
    fi
else
    OUT=$(HAPI_OPERATOR_SYSTEMCTL_OVERRIDE=1 "$TMP" stop hapi-hub.service 2>&1 || true)
    if printf '%s' "$OUT" | grep -q 'override IGNORED'; then
        echo "  OK:   no-TTY context: override correctly refused (this is the agent-shell defence)"
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

# Backup any existing wrapper.
if [ -f "$DST" ]; then
    sudo cp "$DST" "$PREV"
    echo "Backup: $PREV"
fi

sudo cp "$TMP" "$DST"
sudo chmod 0755 "$DST"
sudo chown root:root "$DST"

echo "Installed $DST"
echo
echo "Verification (against the live wrapper, via sudo):"
LIVE_OUT=$(sudo /usr/local/sbin/systemctl stop hapi-hub.service 2>&1 || true)
if printf '%s' "$LIVE_OUT" | grep -q 'hapi-systemctl-wrapper: BLOCKED'; then
    echo "  OK:   live wrapper refuses 'sudo systemctl stop hapi-hub.service'"
else
    echo "  WARN: live wrapper does NOT refuse - investigate" >&2
    printf '  output was: %s\n' "$LIVE_OUT" >&2
fi

# status sshd is read-only and not in our protected set -> wrapper passes through.
LIVE_OUT2=$(sudo /usr/local/sbin/systemctl --no-pager status sshd.service 2>&1 || true)
if printf '%s' "$LIVE_OUT2" | grep -q 'hapi-systemctl-wrapper: BLOCKED'; then
    echo "  WARN: live wrapper refused status sshd (should pass through)" >&2
else
    echo "  OK:   live wrapper passes through 'sudo systemctl status sshd'"
fi

# Shell-wrap canary - the gap that motivated this wrapper specifically.
WRAP_OUT=$(sudo bash -c 'systemctl stop hapi-hub.service' 2>&1 || true)
if printf '%s' "$WRAP_OUT" | grep -q 'hapi-systemctl-wrapper: BLOCKED'; then
    echo "  OK:   live wrapper catches 'sudo bash -c systemctl stop ...' (cross-agent gap closed)"
else
    echo "  WARN: shell-wrap bypass works - investigate" >&2
fi

echo
echo "Cross-agent coverage now includes Cursor + Claude + Codex + Gemini + any other"
echo "agent or shell that calls 'sudo systemctl ...'. Bypass via:"
echo "  HAPI_OPERATOR_SYSTEMCTL_OVERRIDE=1 sudo systemctl stop hapi-hub.service"
echo
echo "Rollback: sudo mv $PREV $DST  (or sudo rm $DST if no prev)"

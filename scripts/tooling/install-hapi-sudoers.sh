#!/usr/bin/env bash
# Install the operator-fork sudoers signal-deny rule.
#
# This complements (does NOT replace) the Cursor preToolUse hook at
# scripts/tooling/hapi-systemctl-guard.sh. The hook is the actual enforcement
# layer; this sudoers rule is for discoverability (shows up in `sudo -l`)
# and to catch direct `sudo systemctl ...` invocations that bypass the hook
# (e.g. someone running from a regular shell, not from a Cursor tool call).
#
# Idempotent: rewrites /etc/sudoers.d/hapi-protect each run, validates with
# `visudo -cf` before installing, and aborts on validation failure.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="${REPO_ROOT}/scripts/tooling/sudoers/hapi-protect"
DST="/etc/sudoers.d/hapi-protect"
TMP="$(mktemp /tmp/hapi-protect.XXXXXX)"
trap 'rm -f "$TMP"' EXIT

if [ ! -f "$SRC" ]; then
    echo "ERROR: source file missing: $SRC" >&2
    exit 1
fi

cp "$SRC" "$TMP"
chmod 0440 "$TMP"

if ! sudo visudo -cf "$TMP"; then
    echo "ERROR: sudoers source failed visudo -cf check; refusing to install" >&2
    exit 1
fi

sudo cp "$TMP" "$DST"
sudo chmod 0440 "$DST"
sudo chown root:root "$DST"

echo "Installed $DST"
echo
echo "Verification:"
sudo -n -l /bin/systemctl stop hapi-hub.service >/dev/null 2>&1 \
    && echo "  WARN: stop hapi-hub.service is STILL ALLOWED - check rule order" \
    || echo "  OK:   stop hapi-hub.service is DENIED via sudoers"
sudo -n -l /bin/systemctl restart hapi-runner.service >/dev/null 2>&1 \
    && echo "  OK:   restart hapi-runner.service is ALLOWED (watchdog needs it)" \
    || echo "  WARN: restart hapi-runner.service is DENIED - watchdog will break"
echo
echo "Note: sudoers !-deny is bypassable via:"
echo "  - shell wrap:    sudo bash -c 'systemctl stop hapi-hub.service'"
echo "  - renamed bin:   sudo cp /bin/systemctl /tmp/x; sudo /tmp/x stop hapi-hub.service"
echo "Both are caught by the Cursor preToolUse hook (hapi-systemctl-guard.sh)"
echo "as long as agents stay inside Cursor's tool call layer."

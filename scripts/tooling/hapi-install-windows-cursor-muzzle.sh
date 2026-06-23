#!/usr/bin/env bash
# Deploy Windows Cursor muzzle: hapi-windows-estate.mdc + production mutation hook.
#
# Targets Teemo (HeavyGee desktop). Idempotent. Preserves unrelated hooks (e.g. limbic).
#
# Usage:
#   hapi-install-windows-cursor-muzzle.sh
#   HAPI_WINDOWS_SSH=heavygee@192.168.86.101 HAPI_WINDOWS_SSH_KEY=~/.ssh/id_ed25519_heavygee_desktop ...

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RULE_SRC="${REPO_ROOT}/scripts/tooling/cursor-rules/hapi-windows-estate.mdc"
PS1_SRC="${REPO_ROOT}/scripts/tooling/windows/hapi-production-mutation-guard.ps1"
GUARD_MJS="${REPO_ROOT}/scripts/tooling/windows/hapi-production-mutation-guard.mjs"
INSTALL_PS1="${REPO_ROOT}/scripts/tooling/windows/install-cursor-muzzle.ps1"

WINDOWS_SSH="${HAPI_WINDOWS_SSH:-heavygee@192.168.86.101}"
SSH_KEY="${HAPI_WINDOWS_SSH_KEY:-${HOME}/.ssh/id_ed25519_heavygee_desktop}"
SSH_OPTS=(-o ConnectTimeout=10 -o BatchMode=yes)
if [[ -f "$SSH_KEY" ]]; then
    SSH_OPTS+=(-i "$SSH_KEY")
fi

for f in "$RULE_SRC" "$GUARD_MJS" "$INSTALL_PS1"; do
    if [[ ! -f "$f" ]]; then
        echo "ERROR: missing $f" >&2
        exit 1
    fi
done

echo "Deploying Windows Cursor muzzle to ${WINDOWS_SSH} ..."

ssh "${SSH_OPTS[@]}" "$WINDOWS_SSH" "powershell.exe -NoProfile -Command \"New-Item -ItemType Directory -Force -Path (Join-Path \$env:USERPROFILE '.cursor\\rules'), (Join-Path \$env:USERPROFILE '.cursor\\hooks') | Out-Null\""

scp "${SSH_OPTS[@]}" "$RULE_SRC" "${WINDOWS_SSH}:.cursor/rules/hapi-windows-estate.mdc"
scp "${SSH_OPTS[@]}" "$GUARD_MJS" "${WINDOWS_SSH}:.cursor/hooks/hapi-production-mutation-guard.mjs"
scp "${SSH_OPTS[@]}" "$INSTALL_PS1" "${WINDOWS_SSH}:.cursor/hooks/install-cursor-muzzle.ps1"

ssh "${SSH_OPTS[@]}" "$WINDOWS_SSH" 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File .cursor/hooks/install-cursor-muzzle.ps1'

WORKSPACE_DEPLOY="${REPO_ROOT}/scripts/tooling/windows/deploy-workspace-muzzle.ps1"
scp "${SSH_OPTS[@]}" "$WORKSPACE_DEPLOY" "${WINDOWS_SSH}:.cursor/hooks/deploy-workspace-muzzle.ps1"
ssh "${SSH_OPTS[@]}" "$WINDOWS_SSH" 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File .cursor/hooks/deploy-workspace-muzzle.ps1'

echo ""
echo "Done. On Teemo: restart Cursor (or reload hooks) to pick up:"
echo "  ~/.cursor/rules/hapi-windows-estate.mdc"
echo "  ~/.cursor/hooks/hapi-production-mutation-guard.mjs (bun beforeShellExecution)"
echo "  hapi-source.mdc retired"

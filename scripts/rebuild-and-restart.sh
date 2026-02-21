#!/usr/bin/env bash
set -euo pipefail

# Rebuild from current branch, install binary, restart systemd services.
#
# Usage:
#   ./scripts/rebuild-and-restart.sh          # full rebuild (web + cli)
#   ./scripts/rebuild-and-restart.sh --quick   # skip web rebuild if dist/ exists
#
# Optional env overrides:
#   INSTALL_DIR=$HOME/.local/bin

INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
QUICK=0

for arg in "$@"; do
    case "$arg" in
        --quick) QUICK=1 ;;
        *) echo "unknown flag: $arg" >&2; exit 1 ;;
    esac
done

REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$REPO_ROOT"

detect_target() {
    local os arch
    os="$(uname -s | tr '[:upper:]' '[:lower:]')"
    arch="$(uname -m)"
    case "${os}-${arch}" in
        linux-x86_64)              echo "bun-linux-x64" ;;
        linux-aarch64|linux-arm64) echo "bun-linux-arm64" ;;
        darwin-x86_64)             echo "bun-darwin-x64" ;;
        darwin-arm64)              echo "bun-darwin-arm64" ;;
        *)
            echo "error: unsupported platform: ${os}-${arch}" >&2
            exit 1
            ;;
    esac
}

target="$(detect_target)"
branch="$(git branch --show-current)"
echo "==> rebuilding from branch: ${branch}"

if [[ "$QUICK" == "1" ]] && [[ -f "web/dist/index.html" ]]; then
    echo "==> --quick: skipping web build (using existing dist/)"
else
    echo "==> building web"
    bun run build:web
fi

echo "==> generating embedded web assets"
(cd hub && bun run generate:embedded-web-assets)

echo "==> building executable"
(cd cli && bun run build:exe:allinone)

binary_path="cli/dist-exe/${target}/hapi"
if [[ ! -x "$binary_path" ]]; then
    echo "error: binary not found: ${binary_path}" >&2
    exit 1
fi

echo "==> installing to ${INSTALL_DIR}/hapi"
mkdir -p "$INSTALL_DIR"
install -m755 "$binary_path" "${INSTALL_DIR}/hapi"

echo "==> restarting services"
systemctl --user restart hapi-hub.service
sleep 2
systemctl --user restart hapi-runner.service

echo ""
echo "done."
echo "binary:  ${INSTALL_DIR}/hapi"
echo "version: $("${INSTALL_DIR}/hapi" --version 2>/dev/null || echo 'unknown')"
echo "hub:     $(systemctl --user is-active hapi-hub.service)"
echo "runner:  $(systemctl --user is-active hapi-runner.service)"

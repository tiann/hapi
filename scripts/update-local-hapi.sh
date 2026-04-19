#!/usr/bin/env bash
set -euo pipefail

# Keep local forked main updated from upstream, build, install local binary, push fork.
#
# Defaults match this repo's current remote layout:
# - origin = upstream (tiann/hapi)
# - fork   = your fork
#
# Optional env overrides:
#   UPSTREAM_REMOTE=origin
#   FORK_REMOTE=fork
#   MAIN_BRANCH=main
#   INSTALL_DIR=$HOME/.local/bin
#   RUN_TESTS=0   # set to 1 to run typecheck + web tests before build

UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-origin}"
FORK_REMOTE="${FORK_REMOTE:-fork}"
MAIN_BRANCH="${MAIN_BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
RUN_TESTS="${RUN_TESTS:-0}"

require_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "error: missing required command: $1" >&2
        exit 1
    fi
}

detect_target() {
    local os arch
    os="$(uname -s | tr '[:upper:]' '[:lower:]')"
    arch="$(uname -m)"

    case "${os}-${arch}" in
        linux-x86_64) echo "bun-linux-x64" ;;
        linux-aarch64|linux-arm64) echo "bun-linux-arm64" ;;
        darwin-x86_64) echo "bun-darwin-x64" ;;
        darwin-arm64) echo "bun-darwin-arm64" ;;
        *)
            echo "error: unsupported platform: ${os}-${arch}" >&2
            echo "supported: linux/darwin on x64/arm64" >&2
            exit 1
            ;;
    esac
}

require_cmd git
require_cmd bun
require_cmd install

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "error: run this script inside the hapi git repo" >&2
    exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "error: working tree not clean; commit/stash first" >&2
    exit 1
fi

echo "==> checkout ${MAIN_BRANCH}"
git checkout "${MAIN_BRANCH}"

echo "==> fetch remotes"
git fetch "${UPSTREAM_REMOTE}" "${MAIN_BRANCH}"
git fetch "${FORK_REMOTE}" "${MAIN_BRANCH}" || true

echo "==> merge upstream changes"
git merge "${UPSTREAM_REMOTE}/${MAIN_BRANCH}"

echo "==> install dependencies"
bun install

if [[ "${RUN_TESTS}" == "1" ]]; then
    echo "==> run validation"
    bun run typecheck
    bun run test:web
fi

echo "==> build single binary"
bun run build:single-exe

target="$(detect_target)"
binary_path="cli/dist-exe/${target}/hapi"

if [[ ! -x "${binary_path}" ]]; then
    echo "error: built binary not found: ${binary_path}" >&2
    exit 1
fi

echo "==> install binary to ${INSTALL_DIR}/hapi"
mkdir -p "${INSTALL_DIR}"
install -m755 "${binary_path}" "${INSTALL_DIR}/hapi"

echo "==> push ${MAIN_BRANCH} to fork"
git push "${FORK_REMOTE}" "${MAIN_BRANCH}:${MAIN_BRANCH}"

echo ""
echo "done."
echo "binary: ${INSTALL_DIR}/hapi"
echo "version: $("${INSTALL_DIR}/hapi" --version || true)"

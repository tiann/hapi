#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"

fail() {
    echo "[docker-check] ERROR: $1" >&2
    exit 1
}

warn() {
    echo "[docker-check] WARN: $1" >&2
}

info() {
    echo "[docker-check] $1"
}

if [ ! -f "${ENV_FILE}" ]; then
    fail ".env 不存在。请先执行: cp .env.example .env"
fi

# shellcheck disable=SC1090
set -a
. "${ENV_FILE}"
set +a

if [ -z "${CLI_API_TOKEN:-}" ]; then
    fail "CLI_API_TOKEN 未设置"
fi

if [ -z "${CLAUDE_CONFIG_DIR:-}" ]; then
    fail "CLAUDE_CONFIG_DIR 未设置"
fi

case "${CLAUDE_CONFIG_DIR}" in
    /*) ;;
    *) fail "CLAUDE_CONFIG_DIR 必须是宿主机绝对路径" ;;
 esac

if [ ! -d "${CLAUDE_CONFIG_DIR}" ]; then
    fail "CLAUDE_CONFIG_DIR 指向的目录不存在: ${CLAUDE_CONFIG_DIR}"
fi

if [ -n "${ZCF_API_URL:-}" ]; then
    case "${ZCF_API_URL}" in
        http://*|https://*) ;;
        *) fail "ZCF_API_URL 必须是 http(s):// URL" ;;
    esac
fi

if [ -n "${ZCF_API_KEY:-}" ]; then
    case "${ZCF_API_KEY}" in
        http://*|https://*)
            fail "ZCF_API_KEY 看起来像 URL；请确认没有与 ZCF_API_URL 写反"
            ;;
    esac
fi

if [ -n "${ZCF_API_KEY:-}" ] && [ -z "${ZCF_API_URL:-}" ]; then
    warn "设置了 ZCF_API_KEY，但未设置 ZCF_API_URL；如果你依赖自定义网关，请确认这是预期行为"
fi

if [ -n "${ZCF_API_URL:-}" ] && [ -z "${ZCF_API_KEY:-}" ]; then
    warn "设置了 ZCF_API_URL，但未设置 ZCF_API_KEY；入口脚本会保留 api-type=skip"
fi

info "环境变量检查通过"

if ! docker compose --env-file "${ENV_FILE}" -f "${ROOT_DIR}/docker-compose.yml" config --quiet; then
    fail "docker compose 配置校验失败；请检查 .env 与 compose 配置是否一致"
fi

info "docker compose 配置检查通过"

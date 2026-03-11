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

get_env_value() {
    python3 - "$ENV_FILE" "$1" <<'PY'
import pathlib
import sys

env_path = pathlib.Path(sys.argv[1])
key = sys.argv[2]


def strip_inline_comment(value: str) -> str:
    in_single = False
    in_double = False
    escaped = False
    result = []
    for ch in value:
        if escaped:
            result.append(ch)
            escaped = False
            continue
        if ch == '\\':
            escaped = True
            result.append(ch)
            continue
        if ch == "'" and not in_double:
            in_single = not in_single
            result.append(ch)
            continue
        if ch == '"' and not in_single:
            in_double = not in_double
            result.append(ch)
            continue
        if ch == '#' and not in_single and not in_double:
            break
        result.append(ch)
    return ''.join(result).strip()


for raw_line in env_path.read_text(encoding='utf-8').splitlines():
    line = raw_line.strip()
    if not line or line.startswith('#') or '=' not in line:
        continue

    current_key, raw_value = line.split('=', 1)
    current_key = current_key.strip()
    if current_key.startswith('export '):
        current_key = current_key[len('export '):].strip()
    if current_key != key:
        continue

    value = strip_inline_comment(raw_value.strip())
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        value = value[1:-1]
    print(value)
    break
PY
}

CLI_API_TOKEN="$(get_env_value CLI_API_TOKEN)"
CLAUDE_CONFIG_DIR="$(get_env_value CLAUDE_CONFIG_DIR)"
ZCF_API_URL="$(get_env_value ZCF_API_URL)"
ZCF_API_KEY="$(get_env_value ZCF_API_KEY)"

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

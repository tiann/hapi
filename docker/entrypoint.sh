#!/usr/bin/env bash
set -e

# Runtime version switch via managers:
# - Node.js: nvm
# - Go: goenv

export NVM_DIR="${NVM_DIR:-/usr/local/nvm}"
export GOENV_ROOT="${GOENV_ROOT:-/usr/local/goenv}"
export PNPM_HOME="${PNPM_HOME:-/usr/local/pnpm}"
export PATH="${GOENV_ROOT}/bin:${GOENV_ROOT}/shims:${PNPM_HOME}:${PATH}"

# shellcheck disable=SC1091
if [ -f "${NVM_DIR}/nvm.sh" ]; then
    . "${NVM_DIR}/nvm.sh"
else
    echo "[entrypoint] ERROR: nvm not found at ${NVM_DIR}/nvm.sh" >&2
    exit 1
fi

if ! command -v goenv >/dev/null 2>&1; then
    echo "[entrypoint] ERROR: goenv command not found" >&2
    exit 1
fi

if [ -n "${ZS_NODE_VERSION}" ]; then
    if ! nvm ls "${ZS_NODE_VERSION}" >/dev/null 2>&1; then
        echo "[entrypoint] Node.js ${ZS_NODE_VERSION} not installed, installing with nvm..." >&2
        nvm install "${ZS_NODE_VERSION}"
    fi
    nvm use "${ZS_NODE_VERSION}" >/dev/null
    export PATH="${PNPM_HOME}:${PATH}"
fi

if [ -n "${ZS_GO_VERSION}" ]; then
    if ! goenv versions --bare | grep -qx "${ZS_GO_VERSION}"; then
        echo "[entrypoint] Go ${ZS_GO_VERSION} not installed, installing with goenv..." >&2
        goenv install -s "${ZS_GO_VERSION}"
    fi
    goenv global "${ZS_GO_VERSION}"
    eval "$(goenv init -)"
fi

CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-/root/.claude}"
export CLAUDE_CONFIG_DIR

if [ -n "${ZCF_API_KEY}" ] && [ -n "${ZCF_API_URL}" ]; then
    case "${ZCF_API_KEY}" in
        http://*|https://*)
            case "${ZCF_API_URL}" in
                http://*|https://*)
                    ;;
                *)
                    echo "[entrypoint] WARN: Detected swapped ZCF_API_KEY/ZCF_API_URL values, auto-correcting..." >&2
                    zcf_swapped_api_key="${ZCF_API_URL}"
                    ZCF_API_URL="${ZCF_API_KEY}"
                    ZCF_API_KEY="${zcf_swapped_api_key}"
                    export ZCF_API_KEY ZCF_API_URL
                    ;;
            esac
            ;;
    esac
fi

mkdir -p "${CLAUDE_CONFIG_DIR}"
if [ -z "$(ls -A "${CLAUDE_CONFIG_DIR}" 2>/dev/null)" ]; then
    echo "[entrypoint] Claude config is empty, running first-boot zcf init..." >&2
    HOME=/root zcf init --skip-prompt --config-action new --all-lang zh-CN --ai-output-lang zh-CN --code-type claude-code --api-type skip --api-model "${CLAUDE_PRIMARY_MODEL:-claude-sonnet-4-6}" --api-haiku-model "${CLAUDE_HAIKU_MODEL:-claude-haiku-4-5-20251001}" --api-sonnet-model "${CLAUDE_SONNET_MODEL:-claude-sonnet-4-6}" --api-opus-model "${CLAUDE_OPUS_MODEL:-claude-opus-4-6}" --output-styles all --default-output-style nekomata-engineer --workflows all --mcp-services Playwright,serena --install-cometix-line false

    mkdir -p "${CLAUDE_CONFIG_DIR}/commands/zcf" "${CLAUDE_CONFIG_DIR}/agents/zcf"
    find "${CLAUDE_CONFIG_DIR}/commands/zcf" -maxdepth 1 -type f ! -name 'init-project.md' -delete
    find "${CLAUDE_CONFIG_DIR}/agents/zcf" -mindepth 1 -maxdepth 1 ! -name 'common' -exec rm -rf {} +

    if [ -f "${CLAUDE_CONFIG_DIR}/settings.json" ]; then
        node -e "const fs=require('fs');const p=process.env.CLAUDE_CONFIG_DIR+'/settings.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));if(j.permissions&&Array.isArray(j.permissions.allow)){j.permissions.allow=j.permissions.allow.filter(x=>!x.startsWith('mcp__')||x==='mcp__Playwright'||x==='mcp__serena');}fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n');"
    fi
fi
runtime_override=false
if [ -n "${ZCF_API_KEY}" ] \
    || [ -n "${ZCF_API_URL}" ] \
    || [ -n "${ZCF_API_MODEL}" ] \
    || [ -n "${ZCF_API_HAIKU_MODEL}" ] \
    || [ -n "${ZCF_API_SONNET_MODEL}" ] \
    || [ -n "${ZCF_API_OPUS_MODEL}" ] \
    || [ -n "${ZCF_DEFAULT_OUTPUT_STYLE}" ] \
    || [ -n "${ZCF_ALL_LANG}" ] \
    || [ -n "${ZCF_AI_OUTPUT_LANG}" ]; then
    runtime_override=true
fi

if [ "${runtime_override}" = "true" ]; then
    echo "[entrypoint] Detected runtime Claude override vars, applying zcf config update..." >&2

    api_type="skip"
    if [ -n "${ZCF_API_KEY}" ]; then
        api_type="api_key"
    elif [ -n "${ZCF_API_URL}" ] || [ -n "${ZCF_API_MODEL}" ] || [ -n "${ZCF_API_HAIKU_MODEL}" ] || [ -n "${ZCF_API_SONNET_MODEL}" ] || [ -n "${ZCF_API_OPUS_MODEL}" ]; then
        echo "[entrypoint] WARN: Model/API URL override requested without ZCF_API_KEY; keeping api-type=skip" >&2
    fi

    (
        set -- --skip-prompt --config-action merge --code-type claude-code --install-cometix-line false --workflows skip --mcp-services skip --output-styles skip --api-type "${api_type}"

        if [ -n "${ZCF_API_KEY}" ]; then
            set -- "$@" --api-key "${ZCF_API_KEY}"
        fi
        if [ -n "${ZCF_API_URL}" ]; then
            set -- "$@" --api-url "${ZCF_API_URL}"
        fi
        if [ -n "${ZCF_API_MODEL}" ]; then
            set -- "$@" --api-model "${ZCF_API_MODEL}"
        fi
        if [ -n "${ZCF_API_HAIKU_MODEL}" ]; then
            set -- "$@" --api-haiku-model "${ZCF_API_HAIKU_MODEL}"
        fi
        if [ -n "${ZCF_API_SONNET_MODEL}" ]; then
            set -- "$@" --api-sonnet-model "${ZCF_API_SONNET_MODEL}"
        fi
        if [ -n "${ZCF_API_OPUS_MODEL}" ]; then
            set -- "$@" --api-opus-model "${ZCF_API_OPUS_MODEL}"
        fi
        if [ -n "${ZCF_DEFAULT_OUTPUT_STYLE}" ]; then
            set -- "$@" --default-output-style "${ZCF_DEFAULT_OUTPUT_STYLE}"
        fi
        if [ -n "${ZCF_ALL_LANG}" ]; then
            set -- "$@" --all-lang "${ZCF_ALL_LANG}"
        fi
        if [ -n "${ZCF_AI_OUTPUT_LANG}" ]; then
            set -- "$@" --ai-output-lang "${ZCF_AI_OUTPUT_LANG}"
        fi

        HOME=/root zcf init "$@"

        if [ -f "${CLAUDE_CONFIG_DIR}/settings.json" ]; then
            node -e "const fs=require('fs');const p=process.env.CLAUDE_CONFIG_DIR+'/settings.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));const set=(k,v)=>{if(v!==undefined&&v!==''){j[k]=v;}};set('apiKey',process.env.ZCF_API_KEY);set('apiUrl',process.env.ZCF_API_URL);set('apiModel',process.env.ZCF_API_MODEL);set('apiHaikuModel',process.env.ZCF_API_HAIKU_MODEL);set('apiSonnetModel',process.env.ZCF_API_SONNET_MODEL);set('apiOpusModel',process.env.ZCF_API_OPUS_MODEL);set('outputStyle',process.env.ZCF_DEFAULT_OUTPUT_STYLE);set('allLang',process.env.ZCF_ALL_LANG);set('aiOutputLang',process.env.ZCF_AI_OUTPUT_LANG);fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n');"
        fi
    )
fi

exec "$@"

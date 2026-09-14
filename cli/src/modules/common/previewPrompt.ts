import { trimIdent } from '@/utils/trimIdent';

/**
 * Shared preview_* MCP tool hints — one export per tool naming convention.
 * Inject into flavor system prompts and first-prompt bridge instructions.
 */
export const PREVIEW_PROMPT_CLAUDE = trimIdent(`
    The "mcp__hapi__preview_static" tool mounts a local directory (e.g. HTML reports, chart demos) as a read-only web page on the HAPI hub and returns a clickable URL; "mcp__hapi__preview_proxy" reverse-proxies a local dev server (loopback port) onto the hub port; "mcp__hapi__preview_stop" unmounts. Call preview_static right after you create HTML pages or demos the user should open in a browser, and call preview_proxy after starting a dev server. Both require user approval and publish a capability URL anyone with the link can read until it expires — mention that when sharing. Prefer relative asset paths or an explicit base (vite \`base\`, next \`basePath\`) so pages work under the /preview/ sub-path.
`);

export const PREVIEW_PROMPT_CODEX = trimIdent(`
    When the user should open generated HTML pages or a local dev server in a browser, call functions.hapi__preview_static (mount a directory) or functions.hapi__preview_proxy (reverse-proxy a loopback dev server port) — if those exact names are unavailable, use equivalent aliases such as hapi__preview_static / preview_static. "hapi__preview_stop" unmounts. Both require user approval and publish a capability URL anyone with the link can read until it expires. Prefer relative asset paths or an explicit base (vite \`base\`, next \`basePath\`) so pages work under the /preview/ sub-path.
`);

export const PREVIEW_PROMPT_HAPI_MCP = trimIdent(`
    When the user should open generated HTML pages or a local dev server in a browser, call "hapi_preview_static" (mount a directory) or "hapi_preview_proxy" (reverse-proxy a loopback dev server port); if those exact tool names are unavailable, use equivalent aliases such as preview_static / preview_proxy or mcp__hapi__preview_static. "hapi_preview_stop" unmounts. Both require user approval and publish a capability URL anyone with the link can read until it expires. Prefer relative asset paths or an explicit base so pages work under the /preview/ sub-path.
`);

export const PREVIEW_PROMPT_CURSOR = trimIdent(`
    When the user should open generated HTML pages or a local dev server in a browser, call the tool "preview_static" (mount a directory) or "preview_proxy" (reverse-proxy a loopback dev server port); "preview_stop" unmounts. Both require user approval and publish a capability URL anyone with the link can read until it expires. Prefer relative asset paths or an explicit base so pages work under the /preview/ sub-path.
`);

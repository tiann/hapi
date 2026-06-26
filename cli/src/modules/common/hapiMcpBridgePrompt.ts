import { trimIdent } from '@/utils/trimIdent';
import { DISPLAY_IMAGE_PROMPT_HAPI_MCP, DISPLAY_VIDEO_PROMPT_HAPI_MCP } from './displayImagePrompt';

const INLINE_MEDIA_SHELL_FALLBACK = trimIdent(`
    If display_image / display_video tools are not in your tool list, inline media via shell from the HAPI repo (needs bun + @modelcontextprotocol/sdk):
    cd <hapi-repo-root> && bun scripts/tooling/hapi-display-image.mjs <HAPI-session-id-prefix> <absolute-file-path> "title"
    Use the HAPI session uuid prefix from the web URL /sessions/<uuid> (first 8 chars), not cursorSessionId or other agent-native ids.
    Run hapi doctor inline-media to list active bridges and copy the exact command.
`);

/**
 * Title + display_image / display_video instructions for ACP flavors wired through buildHapiMcpBridge
 * (Gemini, Kimi, Cursor, OpenCode). Prepended on the first user prompt.
 */
export const HAPI_MCP_TITLE_INSTRUCTION = trimIdent(`
    Use the title tool sparingly. For a new chat, call the tool "hapi_change_title" once after the user's initial request is clear, and set a concise task title. Do not rename the chat for routine progress, substeps, implementation details, or a slightly better wording. Rename only when the user's primary objective changes substantially and the existing title would be misleading.
`);

export const HAPI_MCP_BRIDGE_PROMPT = trimIdent(`
    ${HAPI_MCP_TITLE_INSTRUCTION}
    ${DISPLAY_IMAGE_PROMPT_HAPI_MCP}
    ${DISPLAY_VIDEO_PROMPT_HAPI_MCP}
    ${INLINE_MEDIA_SHELL_FALLBACK}
`);

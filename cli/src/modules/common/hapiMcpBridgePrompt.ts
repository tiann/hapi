import { trimIdent } from '@/utils/trimIdent';
import { DISPLAY_IMAGE_PROMPT_HAPI_MCP } from './displayImagePrompt';

/**
 * Title + display_image instructions for ACP flavors wired through buildHapiMcpBridge
 * (Gemini, Kimi, Cursor, OpenCode). Prepended on the first user prompt.
 */
export const HAPI_MCP_TITLE_INSTRUCTION = trimIdent(`
    Use the title tool sparingly. For a new chat, call the tool "hapi_change_title" once after the user's initial request is clear, and set a concise task title. Do not rename the chat for routine progress, substeps, implementation details, or a slightly better wording. Rename only when the user's primary objective changes substantially and the existing title would be misleading.
`);

export const HAPI_MCP_BRIDGE_PROMPT = trimIdent(`
    ${HAPI_MCP_TITLE_INSTRUCTION}
    ${DISPLAY_IMAGE_PROMPT_HAPI_MCP}
`);

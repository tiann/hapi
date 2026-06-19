/**
 * Codex-specific system prompt for local mode.
 *
 * This prompt instructs Codex to call the hapi MCP tools for session title
 * and inline image display.
 */

import { trimIdent } from '@/utils/trimIdent';
import { DISPLAY_IMAGE_PROMPT_CODEX } from '@/modules/common/displayImagePrompt';

/**
 * Title instruction for Codex to call the hapi MCP tool.
 * Note: Codex exposes MCP tools under the `functions.` namespace,
 * so the tool is called as `functions.hapi__change_title`.
 */
const CODEX_TITLE_INSTRUCTION = trimIdent(`
    Use the title tool sparingly. For a new chat, call it once after the user's initial request is clear, and set a concise task title.
    Prefer calling functions.hapi__change_title.
    If that exact tool name is unavailable, call an equivalent alias such as hapi__change_title, mcp__hapi__change_title, or hapi_change_title.
    Do not rename the chat for routine progress, substeps, implementation details, or a slightly better wording.
    Rename only when the user's primary objective changes substantially and the existing title would be misleading.
`);

export const TITLE_INSTRUCTION = trimIdent(`
    ${CODEX_TITLE_INSTRUCTION}
    ${DISPLAY_IMAGE_PROMPT_CODEX}
`);

/**
 * The system prompt to inject via developer_instructions in local mode.
 */
export const codexSystemPrompt = TITLE_INSTRUCTION;

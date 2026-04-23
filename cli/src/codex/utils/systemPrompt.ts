/**
 * Codex-specific system prompt for local mode.
 *
 * This prompt keeps the HAPI title tool available without forcing an
 * extra title-tool turn in every Codex session.
 */

import { trimIdent } from '@/utils/trimIdent';

/**
 * Title instruction for Codex's HAPI MCP tool.
 * Note: Codex exposes MCP tools under the `functions.` namespace,
 * so the tool is called as `functions.hapi__change_title`.
 */
export const TITLE_INSTRUCTION = trimIdent(`
    Do not call the HAPI title tool automatically.
    Only call functions.hapi__change_title if the user explicitly asks to rename the current chat.
    If that exact tool name is unavailable, use an equivalent alias such as hapi__change_title, mcp__hapi__change_title, hapi_change_title, or change_title.
    Keep title tool calls silent; never mention title changes in the chat response.
`);

/**
 * The system prompt to inject via developer_instructions in local mode.
 */
export const codexSystemPrompt = TITLE_INSTRUCTION;

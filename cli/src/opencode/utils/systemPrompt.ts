/**
 * OpenCode-specific system prompt for change_title tool.
 *
 * OpenCode exposes MCP tools with the naming pattern: <server-name>_<tool-name>
 * The hapi MCP server exposes `change_title`, so it's called as `hapi_change_title`.
 */

import { buildTitleInstruction } from '@/utils/titleInstruction';

/**
 * Title instruction for OpenCode.
 * OpenCode exposes MCP tools as <server>_<tool> → hapi_change_title.
 */
export const TITLE_INSTRUCTION = buildTitleInstruction('hapi_change_title');

/**
 * The system prompt to inject for OpenCode sessions.
 */
export const opencodeSystemPrompt = TITLE_INSTRUCTION;

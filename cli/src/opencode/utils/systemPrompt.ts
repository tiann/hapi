/**
 * OpenCode-specific system prompt for change_title tool.
 *
 * OpenCode exposes MCP tools with the naming pattern: <server-name>_<tool-name>
 * The hapi MCP server exposes `change_title`, so it's called as `hapi_change_title`.
 */

import { trimIdent } from '@/utils/trimIdent';
import { SKILL_LOOKUP_INSTRUCTION } from '@/modules/common/skillLookupInstruction';

/**
 * Title instruction for OpenCode to call the hapi MCP tool.
 */
export const TITLE_INSTRUCTION = trimIdent(`
    Use the title tool sparingly. For a new chat, call the tool "hapi_change_title" once after the user's initial request is clear, and set a concise task title. Do not rename the chat for routine progress, substeps, implementation details, or a slightly better wording. Rename only when the user's primary objective changes substantially and the existing title would be misleading.
    When you create or find a local image file that the user should see, call the tool "hapi_display_image" with the image path so HAPI can show it inline.
    ${SKILL_LOOKUP_INSTRUCTION}
`);

/**
 * Tool instructions for native ACP sessions. Title updates come from ACP, so
 * advertise only the MCP tools that remain available to the model.
 */
export const OPENCODE_NATIVE_TOOL_INSTRUCTION = trimIdent(`
    When you create or find a local image file that the user should see, call the tool "hapi_display_image" with the image path so HAPI can show it inline.
    ${SKILL_LOOKUP_INSTRUCTION}
`);

/**
 * The system prompt to inject for OpenCode sessions.
 */
export const opencodeSystemPrompt = TITLE_INSTRUCTION;

/**
 * Instruction prepended to OpenCode prompts while HAPI plan mode is active.
 */
export const PLAN_MODE_INSTRUCTION = trimIdent(`
    You are in plan mode. Do not execute tools or make changes. Analyze the request, ask clarifying questions if needed, and respond with a concise implementation plan only.
`);

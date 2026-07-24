/**
 * OpenCode-specific system prompt for hapi MCP tools (change_title, display_image, display_video).
 *
 * OpenCode exposes MCP tools with the naming pattern: <server-name>_<tool-name>
 * The hapi MCP server exposes `change_title`, `display_image`, and `display_video`.
 */

import { trimIdent } from '@/utils/trimIdent';
import { HAPI_MCP_BRIDGE_PROMPT } from '@/modules/common/hapiMcpBridgePrompt';
import {
    DISPLAY_IMAGE_PROMPT_HAPI_MCP,
    DISPLAY_VIDEO_PROMPT_HAPI_MCP,
} from '@/modules/common/displayImagePrompt';
import { SKILL_LOOKUP_INSTRUCTION } from '@/modules/common/skillLookupInstruction';

/**
 * Title and display_image / display_video instructions for OpenCode to call the hapi MCP tools.
 */
export const TITLE_INSTRUCTION = trimIdent(`
    ${HAPI_MCP_BRIDGE_PROMPT}
    ${SKILL_LOOKUP_INSTRUCTION}
`);

/**
 * Tool instructions for native ACP sessions. Title updates come from ACP, so
 * advertise only the MCP tools that remain available to the model.
 */
export const OPENCODE_NATIVE_TOOL_INSTRUCTION = trimIdent(`
    ${DISPLAY_IMAGE_PROMPT_HAPI_MCP}
    ${DISPLAY_VIDEO_PROMPT_HAPI_MCP}
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

/**
 * OpenCode-specific system prompt for hapi MCP tools (change_title, display_image, display_video, display_media).
 *
 * OpenCode exposes MCP tools with the naming pattern: <server-name>_<tool-name>
 * The hapi MCP server exposes `change_title`, `display_image`, `display_video`, and `display_media`.
 */

import { trimIdent } from '@/utils/trimIdent';
import { buildSessionCitationSteerInstruction } from '@hapi/protocol/sessionCitation';
import { HAPI_MCP_BRIDGE_PROMPT } from '@/modules/common/hapiMcpBridgePrompt';
import {
    DISPLAY_IMAGE_PROMPT_HAPI_MCP,
    DISPLAY_MEDIA_PROMPT_HAPI_MCP,
    DISPLAY_VIDEO_PROMPT_HAPI_MCP,
} from '@/modules/common/displayImagePrompt';
import { SKILL_LOOKUP_INSTRUCTION } from '@/modules/common/skillLookupInstruction';
import { withSessionSummaryInstruction } from '@/modules/common/sessionSummaryInstruction';

/**
 * Title and display_image / display_video / display_media instructions for OpenCode to call the hapi MCP tools.
 */
export const TITLE_INSTRUCTION = trimIdent(`
    ${HAPI_MCP_BRIDGE_PROMPT}
    ${buildSessionCitationSteerInstruction({
        inspectTool: 'hapi_inspect_peer',
        pingTool: 'hapi_ping_peer',
        listPeersTool: 'hapi_list_peers',
    })}
    ${SKILL_LOOKUP_INSTRUCTION}
`);

export function getTitleInstruction(env: NodeJS.ProcessEnv = process.env): string {
    return withSessionSummaryInstruction(TITLE_INSTRUCTION, env)
}

/**
 * Tool instructions for native ACP sessions. Title updates come from ACP, so
 * advertise only the MCP tools that remain available to the model.
 */
export const OPENCODE_NATIVE_TOOL_INSTRUCTION = trimIdent(`
    ${DISPLAY_IMAGE_PROMPT_HAPI_MCP}
    ${DISPLAY_VIDEO_PROMPT_HAPI_MCP}
    ${DISPLAY_MEDIA_PROMPT_HAPI_MCP}
    ${buildSessionCitationSteerInstruction({
        inspectTool: 'hapi_inspect_peer',
        pingTool: 'hapi_ping_peer',
        listPeersTool: 'hapi_list_peers',
    })}
    ${SKILL_LOOKUP_INSTRUCTION}
`);

export function getOpencodeNativeToolInstruction(env: NodeJS.ProcessEnv = process.env): string {
    return withSessionSummaryInstruction(OPENCODE_NATIVE_TOOL_INSTRUCTION, env)
}

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

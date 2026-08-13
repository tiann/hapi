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
import { isHubPeerToolsEnabled } from '@/modules/common/peerToolsExposure';

/**
 * Title and display_image / display_video / display_media instructions for OpenCode to call the hapi MCP tools.
 */
const TITLE_INSTRUCTION_BASE = trimIdent(`
    ${HAPI_MCP_BRIDGE_PROMPT}
    ${SKILL_LOOKUP_INSTRUCTION}
`);

const PEER_CITATION_GUIDANCE = buildSessionCitationSteerInstruction({
    inspectTool: 'hapi_inspect_peer',
    pingTool: 'hapi_ping_peer',
    listPeersTool: 'hapi_list_peers',
});
export const TITLE_INSTRUCTION = `${TITLE_INSTRUCTION_BASE}\n\n${PEER_CITATION_GUIDANCE}`;

export function getTitleInstruction(env: NodeJS.ProcessEnv = process.env): string {
    const prompt = isHubPeerToolsEnabled() ? TITLE_INSTRUCTION : TITLE_INSTRUCTION_BASE;
    return withSessionSummaryInstruction(prompt, env)
}

/**
 * Tool instructions for native ACP sessions. Title updates come from ACP, so
 * advertise only the MCP tools that remain available to the model.
 */
const OPENCODE_NATIVE_TOOL_INSTRUCTION_BASE = trimIdent(`
    ${DISPLAY_IMAGE_PROMPT_HAPI_MCP}
    ${DISPLAY_VIDEO_PROMPT_HAPI_MCP}
    ${DISPLAY_MEDIA_PROMPT_HAPI_MCP}
    ${SKILL_LOOKUP_INSTRUCTION}
`);

const OPENCODE_NATIVE_PEER_CITATION_GUIDANCE = buildSessionCitationSteerInstruction({
    inspectTool: 'hapi_inspect_peer',
    pingTool: 'hapi_ping_peer',
    listPeersTool: 'hapi_list_peers',
});
export const OPENCODE_NATIVE_TOOL_INSTRUCTION = `${OPENCODE_NATIVE_TOOL_INSTRUCTION_BASE}\n\n${OPENCODE_NATIVE_PEER_CITATION_GUIDANCE}`;

export function getOpencodeNativeToolInstruction(env: NodeJS.ProcessEnv = process.env): string {
    const prompt = isHubPeerToolsEnabled() ? OPENCODE_NATIVE_TOOL_INSTRUCTION : OPENCODE_NATIVE_TOOL_INSTRUCTION_BASE;
    return withSessionSummaryInstruction(prompt, env)
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

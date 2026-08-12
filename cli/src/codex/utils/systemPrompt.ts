/**
 * Codex-specific system prompt for local mode.
 *
 * This prompt instructs Codex to call the hapi__change_title function
 * to set appropriate chat session titles.
 */

import { trimIdent } from '@/utils/trimIdent';
import { buildSessionCitationSteerInstruction } from '@hapi/protocol/sessionCitation';
import { DISPLAY_IMAGE_PROMPT_CODEX, DISPLAY_MEDIA_PROMPT_CODEX, DISPLAY_VIDEO_PROMPT_CODEX } from '@/modules/common/displayImagePrompt';
import { withSessionSummaryInstruction } from '@/modules/common/sessionSummaryInstruction';
import { isHubPeerToolsEnabled } from '@/modules/common/peerToolsExposure';

/**
 * Title instruction for Codex to call the hapi MCP tool.
 * Note: Codex exposes MCP tools under the `functions.` namespace,
 * so the tool is called as `functions.hapi__change_title`.
 */
const TITLE_INSTRUCTION_BASE = trimIdent(`
    Use the title tool sparingly. For a new chat, call it once after the user's initial request is clear, and set a concise task title.
    Prefer calling functions.hapi__change_title.
    If that exact tool name is unavailable, call an equivalent alias such as hapi__change_title, mcp__hapi__change_title, or hapi_change_title.
    Do not rename the chat for routine progress, substeps, implementation details, or a slightly better wording.
    Rename only when the user's primary objective changes substantially and the existing title would be misleading.
    ${DISPLAY_IMAGE_PROMPT_CODEX}
    ${DISPLAY_VIDEO_PROMPT_CODEX}
    ${DISPLAY_MEDIA_PROMPT_CODEX}
`);

const PEER_CITATION_GUIDANCE = buildSessionCitationSteerInstruction({
    inspectTool: 'functions.hapi__inspect_peer',
    pingTool: 'functions.hapi__ping_peer',
    listPeersTool: 'functions.hapi__list_peers',
});
export const TITLE_INSTRUCTION = `${TITLE_INSTRUCTION_BASE}\n\n${PEER_CITATION_GUIDANCE}`;

/**
 * The system prompt to inject via developer_instructions in local mode.
 * Session-summary contract is resolved at call time (hub toggle / env).
 */
export function getCodexSystemPrompt(env: NodeJS.ProcessEnv = process.env): string {
    const prompt = isHubPeerToolsEnabled() ? TITLE_INSTRUCTION : TITLE_INSTRUCTION_BASE;
    return withSessionSummaryInstruction(prompt, env)
}

/** Alias kept for existing call sites / tests that expect a string constant name. */
export const codexSystemPrompt = TITLE_INSTRUCTION

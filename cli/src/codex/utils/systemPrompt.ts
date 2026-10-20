/**
 * Codex-specific system prompt for local mode.
 *
 * This prompt instructs Codex to call the hapi__change_title function
 * to set appropriate chat session titles.
 */

import { trimIdent } from '@/utils/trimIdent';
import { buildSessionCitationSteerInstruction, SESSION_CITATION_DISABLED_STEER } from '@hapi/protocol/sessionCitation';
import { DISPLAY_IMAGE_PROMPT_CODEX, DISPLAY_MEDIA_PROMPT_CODEX, DISPLAY_VIDEO_PROMPT_CODEX } from '@/modules/common/displayImagePrompt';
import { isPeerToolsDisabled } from '@/modules/common/peerTools';
import { withSessionSummaryInstruction } from '@/modules/common/sessionSummaryInstruction';

/**
 * Title instruction for Codex to call the hapi MCP tool.
 * Note: Codex exposes MCP tools under the `functions.` namespace,
 * so the tool is called as `functions.hapi__change_title`.
 */
function buildCodexTitleInstruction(env: NodeJS.ProcessEnv): string {
    return trimIdent(`
    Use the title tool sparingly. For a new chat, call it once after the user's initial request is clear, and set a concise task title.
    Prefer calling functions.hapi__change_title.
    If that exact tool name is unavailable, call an equivalent alias such as hapi__change_title, mcp__hapi__change_title, or hapi_change_title.
    Do not rename the chat for routine progress, substeps, implementation details, or a slightly better wording.
    Rename only when the user's primary objective changes substantially and the existing title would be misleading.
    ${DISPLAY_IMAGE_PROMPT_CODEX}
    ${DISPLAY_VIDEO_PROMPT_CODEX}
    ${DISPLAY_MEDIA_PROMPT_CODEX}
    ${isPeerToolsDisabled(env) ? SESSION_CITATION_DISABLED_STEER : buildSessionCitationSteerInstruction({
        inspectTool: 'functions.hapi__inspect_peer',
        pingTool: 'functions.hapi__ping_peer',
        listPeersTool: 'functions.hapi__list_peers',
    })}
`);
}

/**
 * Import-time snapshot resolved from process.env only; does not reflect the
 * hub toggle applied at session bootstrap. Kept for existing tests — use
 * getCodexSystemPrompt(env) in production paths.
 *
 * @deprecated use getCodexSystemPrompt(env)
 */
export const TITLE_INSTRUCTION = buildCodexTitleInstruction(process.env)

/**
 * The system prompt to inject via developer_instructions in local mode.
 * Session-summary contract and the peer steer are resolved at call time
 * (hub toggle / env).
 */
export function getCodexSystemPrompt(env: NodeJS.ProcessEnv = process.env): string {
    return withSessionSummaryInstruction(buildCodexTitleInstruction(env), env)
}

/**
 * @deprecated Import-time snapshot; use getCodexSystemPrompt(env).
 */
export const codexSystemPrompt = TITLE_INSTRUCTION

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
import { buildPerTurnTitleParagraph, isAutoTitlePerTurnEnabled } from '@/modules/common/titleInstruction';

/**
 * Title instruction for Codex to call the hapi MCP tool (per-turn mode off —
 * kept verbatim as the default so off-mode prompts stay byte-identical).
 * Note: Codex exposes MCP tools under the `functions.` namespace,
 * so the tool is called as `functions.hapi__change_title`.
 */
export const TITLE_INSTRUCTION = trimIdent(`
    Use the title tool sparingly. For a new chat, call it once after the user's initial request is clear, and set a concise task title.
    Prefer calling functions.hapi__change_title.
    If that exact tool name is unavailable, call an equivalent alias such as hapi__change_title, mcp__hapi__change_title, or hapi_change_title.
    Do not rename the chat for routine progress, substeps, implementation details, or a slightly better wording.
    Rename only when the user's primary objective changes substantially and the existing title would be misleading.
    ${DISPLAY_IMAGE_PROMPT_CODEX}
    ${DISPLAY_VIDEO_PROMPT_CODEX}
    ${DISPLAY_MEDIA_PROMPT_CODEX}
    ${buildSessionCitationSteerInstruction({
        inspectTool: 'functions.hapi__inspect_peer',
        pingTool: 'functions.hapi__ping_peer',
        listPeersTool: 'functions.hapi__list_peers',
    })}
`);

/**
 * Per-turn variant: swaps the sparing block for the shared rewrite steer
 * (keeps the Codex alias hint) while display/citation blocks stay put.
 */
function buildPerTurnTitleInstruction(): string {
    return trimIdent(`
    ${buildPerTurnTitleParagraph('functions.hapi__change_title')}
    If that exact tool name is unavailable, call an equivalent alias such as hapi__change_title, mcp__hapi__change_title, or hapi_change_title.
    ${DISPLAY_IMAGE_PROMPT_CODEX}
    ${DISPLAY_VIDEO_PROMPT_CODEX}
    ${DISPLAY_MEDIA_PROMPT_CODEX}
    ${buildSessionCitationSteerInstruction({
        inspectTool: 'functions.hapi__inspect_peer',
        pingTool: 'functions.hapi__ping_peer',
        listPeersTool: 'functions.hapi__list_peers',
    })}
`);
}

/**
 * The system prompt to inject via developer_instructions in local mode.
 * Session-summary contract and the per-turn title steer are resolved at call
 * time (hub toggle / env).
 */
export function getCodexSystemPrompt(env: NodeJS.ProcessEnv = process.env): string {
    const base = isAutoTitlePerTurnEnabled(env)
        ? buildPerTurnTitleInstruction()
        : TITLE_INSTRUCTION;
    return withSessionSummaryInstruction(base, env);
}

/** Alias kept for existing call sites / tests that expect a string constant name. */
export const codexSystemPrompt = TITLE_INSTRUCTION

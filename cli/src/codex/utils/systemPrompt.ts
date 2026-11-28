/**
 * Codex-specific system prompt for local mode.
 *
 * This prompt instructs Codex to call the hapi__change_title function
 * to set appropriate chat session titles.
 */

import { trimIdent } from '@/utils/trimIdent';
import { buildSessionCitationSteerInstruction, SESSION_CITATION_DISABLED_STEER } from '@hapi/protocol/sessionCitation';
import { isPeerToolsDisabled } from '@/modules/common/peerTools';
import { withSessionJobInstruction } from '@/modules/common/sessionJobInstruction';
import { withSessionSummaryInstruction } from '@/modules/common/sessionSummaryInstruction';
import { buildTitleInstruction } from '@/modules/common/titleInstruction';

/**
 * Title instruction for Codex to call the hapi MCP tool.
 * Note: Codex exposes MCP tools under the `functions.` namespace,
 * so the tool is called as `functions.hapi__change_title`.
 */
export const TITLE_INSTRUCTION = trimIdent(`
    ${buildTitleInstruction('functions.hapi__change_title (or its available alias)')}
    ${isPeerToolsDisabled() ? SESSION_CITATION_DISABLED_STEER : buildSessionCitationSteerInstruction({
        inspectTool: 'functions.hapi__inspect_peer',
    })}
`);

/**
 * The system prompt to inject via developer_instructions in local mode.
 * Session-summary contract is resolved at call time (hub toggle / env).
 */
export function getCodexSystemPrompt(env: NodeJS.ProcessEnv = process.env): string {
    return withSessionSummaryInstruction(withSessionJobInstruction(TITLE_INSTRUCTION), env)
}

/** Alias kept for existing call sites / tests that expect a string constant name. */
export const codexSystemPrompt = TITLE_INSTRUCTION

/**
 * Codex-specific system prompt for local mode.
 *
 * This prompt instructs Codex to call the hapi__change_title function
 * to set appropriate chat session titles.
 */

import { trimIdent } from '@/utils/trimIdent';

/**
 * Title instruction for Codex to call the hapi MCP tool.
 * Note: Codex exposes MCP tools under the `functions.` namespace,
 * so the tool is called as `functions.hapi__change_title`.
 */
export const TITLE_INSTRUCTION = trimIdent(`
    Based on this message, call functions.hapi__change_title to change chat session title that would represent the current task. If chat idea would change dramatically - call this function again to update the title.
`);

/**
 * Spawn instruction for Codex to call the hapi MCP spawn tool.
 */
export const SPAWN_INSTRUCTION = trimIdent(`
    Use functions.hapi__spawn_session when a delegated parallel subtask should run separately, when isolated worktree/session context is needed, or when keeping context split will reduce confusion. Do not spawn for simple follow-ups or when continuing the same focused task. The required parameter is directory (prefer absolute path); optional parameters include machineId and agent.
`);

/**
 * The system prompt to inject via developer_instructions in local mode.
 */
export const codexSystemPrompt = trimIdent(`
    ${TITLE_INSTRUCTION}

    ${SPAWN_INSTRUCTION}
`);

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
    Use functions.hapi__spawn_session when a delegated parallel subtask should run separately, when isolated worktree/session context is needed, or when keeping context split will reduce confusion. Do not spawn for simple follow-ups or when continuing the same focused task.

    Required parameter:
    - directory: Working directory for the new session (prefer absolute path).

    Optional parameters:
    - machineId: Target machine ID. Defaults to the current session's machine when available. If multiple machines are online and none is specified, the call will fail listing available machines.
    - agent: Agent flavor — claude (default), codex, gemini, or opencode. When the user requests a specific agent (e.g. "spawn a codex agent", "use gemini"), pass the matching value.
    - model: Model override string for the spawned session (e.g. "o3", "gemini-2.5-pro").
    - yolo: Set true to enable aggressive auto-approval mode. Warn the user before passing yolo: true since the spawned session will auto-approve all tool calls.
    - sessionType: "simple" (default) or "worktree". Worktree sessions create an isolated git worktree so changes don't affect the main branch.
    - worktreeName: Hint for the worktree directory name (worktree sessions only).
    - worktreeBranch: Git branch name for the worktree (worktree sessions only).
    - initialPrompt: A prompt/task to send to the spawned session immediately after it starts (max 100000 chars). Use this to give the new session its instructions so it can begin working autonomously. The response will indicate whether the prompt was delivered or timed out.
`);

/**
 * The system prompt to inject via developer_instructions in local mode.
 */
export const codexSystemPrompt = trimIdent(`
    ${TITLE_INSTRUCTION}

    ${SPAWN_INSTRUCTION}
`);

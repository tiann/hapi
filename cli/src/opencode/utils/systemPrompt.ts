/**
 * OpenCode-specific system prompt for change_title tool.
 *
 * OpenCode exposes MCP tools with the naming pattern: <server-name>_<tool-name>
 * The hapi MCP server exposes `change_title`, so it's called as `hapi_change_title`.
 */

import { trimIdent } from '@/utils/trimIdent';

/**
 * Title instruction for OpenCode to call the hapi MCP tool.
 */
export const TITLE_INSTRUCTION = trimIdent(`
    ALWAYS when you start a new chat - you must call the tool "hapi_change_title" to set a chat title. When you think chat title is not relevant anymore - call the tool again to change it. When chat name is too generic and you have a chance to make it more specific - call the tool again to change it. This title is needed to easily find the chat in the future. Help human.
`);

/**
 * Spawn instruction for OpenCode to call the hapi MCP spawn tool.
 */
export const SPAWN_INSTRUCTION = trimIdent(`
    Use hapi_spawn_session when a delegated parallel subtask should run in a separate context, when an isolated worktree/session is needed, or when context separation will reduce mistakes. Do not spawn for simple follow-ups or while continuing the same focused task.

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
 * The system prompt to inject for OpenCode sessions.
 */
export const opencodeSystemPrompt = trimIdent(`
    ${TITLE_INSTRUCTION}

    ${SPAWN_INSTRUCTION}
`);

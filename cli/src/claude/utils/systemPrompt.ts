import { trimIdent } from "@/utils/trimIdent";

/**
 * System prompt shared across all configurations
 */
export const TITLE_INSTRUCTION = trimIdent(`
    ALWAYS when you start a new chat - you must call a tool "mcp__hapi__change_title" to set a chat title. When you think chat title is not relevant anymore - call the tool again to change it. When chat name is too generic and you have a change to make it more specific - call the tool again to change it. This title is needed to easily find the chat in the future. Help human.
`);

export const SPAWN_INSTRUCTION = trimIdent(`
    Use mcp__hapi__spawn_session when work should be delegated as a parallel subtask, when an isolated worktree/session is needed, or when context should be kept separate. Do not spawn for simple follow-ups or when continuing the same focused thread.

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

export const systemPrompt = trimIdent(`
    ${TITLE_INSTRUCTION}

    ${SPAWN_INSTRUCTION}
`);

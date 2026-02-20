import { trimIdent } from "@/utils/trimIdent";

/**
 * System prompt shared across all configurations
 */
export const TITLE_INSTRUCTION = trimIdent(`
    ALWAYS when you start a new chat - you must call a tool "mcp__hapi__change_title" to set a chat title. When you think chat title is not relevant anymore - call the tool again to change it. When chat name is too generic and you have a change to make it more specific - call the tool again to change it. This title is needed to easily find the chat in the future. Help human.
`);

export const SPAWN_INSTRUCTION = trimIdent(`
    Use mcp__hapi__spawn_session when work should be delegated as a parallel subtask, when an isolated worktree/session is needed, or when context should be kept separate. Do not spawn for simple follow-ups or when continuing the same focused thread. The required parameter is directory (prefer absolute path); optional parameters include machineId and agent. When the user requests a specific agent (e.g. "spawn a codex agent", "use gemini"), pass the matching value as the agent parameter (claude, codex, gemini, or opencode). Defaults to claude if omitted.
`);

export const systemPrompt = trimIdent(`
    ${TITLE_INSTRUCTION}

    ${SPAWN_INSTRUCTION}
`);

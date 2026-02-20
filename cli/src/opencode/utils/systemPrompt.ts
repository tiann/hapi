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
    Use hapi_spawn_session when a delegated parallel subtask should run in a separate context, when an isolated worktree/session is needed, or when context separation will reduce mistakes. Do not spawn for simple follow-ups or while continuing the same focused task. The required parameter is directory (prefer absolute path); optional parameters include machineId and agent.
`);

/**
 * The system prompt to inject for OpenCode sessions.
 */
export const opencodeSystemPrompt = trimIdent(`
    ${TITLE_INSTRUCTION}

    ${SPAWN_INSTRUCTION}
`);

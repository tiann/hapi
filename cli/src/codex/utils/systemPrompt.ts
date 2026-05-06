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
    ALWAYS when you start a new chat, call the title tool to set a concise task title.
    Prefer calling functions.hapi__change_title.
    If that exact tool name is unavailable, call an equivalent alias such as hapi__change_title, mcp__hapi__change_title, or hapi_change_title.
    If the task focus changes significantly later, call the title tool again with a better title.
`);

export const SUBAGENT_RESTRICTION_INSTRUCTION = trimIdent(`
    Subagent nesting rule:
    - The main/root agent may start direct child agents when useful.
    - A child/subagent must never start, resume, message, wait for, close, or otherwise delegate to another agent.
    - If you are running as a spawned agent, do the assigned work yourself and report back to the parent agent.
`);

/**
 * The system prompt to inject via developer_instructions in local mode.
 */
export const codexSystemPrompt = `${TITLE_INSTRUCTION}\n\n${SUBAGENT_RESTRICTION_INSTRUCTION}`;

/**
 * Codex-specific system prompt for local mode.
 *
 * This prompt instructs Codex to call the hapi__change_title function
 * to set appropriate chat session titles.
 */

import { trimIdent } from '@/utils/trimIdent';
import { buildTitleInstruction } from '@/utils/titleInstruction';

/**
 * Title instruction for Codex.
 * Codex exposes MCP tools under the `functions.` namespace → functions.hapi__change_title.
 */
export const TITLE_INSTRUCTION = buildTitleInstruction('functions.hapi__change_title');

export const GOAL_INSTRUCTION = trimIdent(`
    Goal management on HAPI:
    - Do not call HAPI goal tools by default in ordinary chat turns; active goals can trigger autonomous continuation, so opt-in only.
    - Only set an active goal when the user sends /goal or asks for continuous autonomous progress ("keep working until complete"). Otherwise avoid goals; for passive state use paused/blocked/complete and do not omit status because omitted status creates an active goal.
    - Use functions.hapi__get_goal only when needed; functions.hapi__clear_goal only when user asks or when replacing a terminal completed/budget-limited goal.
    - Do not use native create_goal; it is create-only and can fail after a completed prior goal.
`);

export const CAPABILITY_DISCOVERY_INSTRUCTION = trimIdent(`
    Codex capability discovery on HAPI:
    - HAPI Codex uses deferred tool loading; for Codex CLI/plugin/connector/MCP/sub-agent requests, search before saying unavailable.
    - If tool_search is available and the user asks for subagents/sub-agents/delegation/parallel/isolated agents, first search: multi agent spawn_agent subagent. Use multi_agent_v1.spawn_agent or equivalent when real subagents are requested.
    - If tool_search is available and the user asks for browser, Chrome, UI automation, GitHub, Gmail, Figma, documents, spreadsheets, presentations, OpenAI docs, node/JavaScript REPL, or plugin-specific behavior, search matching namespace first.
    - "final answer text only"/"only output text" constrains visible final text; it does not forbid internal tool calls. Tools are forbidden only if user explicitly says not to use tools.
`);

/**
 * The system prompt to inject via developer_instructions in local mode.
 */
export const codexSystemPrompt = `${TITLE_INSTRUCTION}\n\n${GOAL_INSTRUCTION}\n\n${CAPABILITY_DISCOVERY_INSTRUCTION}`;

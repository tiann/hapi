/**
 * Discovery copy for agents that can host a durable system / instructions block
 * (OpenCode, Grok). Do **not** prepend this to user turns — that path looks like
 * prompt injection on Cursor ACP and similar remotes (tiann/hapi#1095).
 *
 * Cursor / Kimi / generic ACP rely on the `skill_lookup` MCP tool description
 * (and Cursor's native `.cursor/mcp.json` overlay where session/new mcpServers
 * are ignored) instead of a user-message prepend.
 */
export const SKILL_LOOKUP_INSTRUCTION =
    'When a user message starts with "$name", call HAPI\'s skill_lookup tool with "name" (without "$") before acting.'

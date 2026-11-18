/**
 * Helpers for carrying user-configured Codex MCP servers into HAPI sessions.
 *
 * The app-server reports the effective Codex configuration, so keep external
 * entries opaque here. This preserves newer Codex MCP fields without making
 * HAPI duplicate Codex's transport schema.
 */

export interface CodexMcpServerConfig {
    [key: string]: unknown;
}

export type CodexMcpServersConfig = Record<string, CodexMcpServerConfig>;

export const HAPI_MCP_SERVER_NAME = 'hapi';

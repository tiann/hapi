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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMcpServerConfig(value: unknown): value is CodexMcpServerConfig {
    if (!isRecord(value)) {
        return false;
    }

    if (value.command !== undefined && typeof value.command !== 'string') {
        return false;
    }
    if (value.args !== undefined && (
        !Array.isArray(value.args)
        || value.args.some((arg) => typeof arg !== 'string')
    )) {
        return false;
    }
    if (value.url !== undefined && typeof value.url !== 'string') {
        return false;
    }

    return typeof value.command === 'string' || typeof value.url === 'string';
}

function omitNullishFields(value: CodexMcpServerConfig): CodexMcpServerConfig {
    return Object.fromEntries(
        Object.entries(value).filter(([, entryValue]) => entryValue !== null && entryValue !== undefined)
    );
}

/**
 * Extract the MCP server table from a Codex config/read response.
 *
 * `hapi` is intentionally excluded: that name is reserved for the bridge
 * HAPI injects into every Codex session.
 */
export function extractCodexMcpServers(config: unknown): CodexMcpServersConfig {
    if (!isRecord(config) || !isRecord(config.mcp_servers)) {
        return {};
    }

    const servers: CodexMcpServersConfig = {};
    for (const [name, value] of Object.entries(config.mcp_servers)) {
        if (name === HAPI_MCP_SERVER_NAME) {
            continue;
        }
        if (!isMcpServerConfig(value)) {
            throw new Error(`Invalid Codex MCP server configuration for "${name}"`);
        }
        servers[name] = omitNullishFields(value);
    }
    return servers;
}

/**
 * Merge user entries with HAPI's bridge configuration.
 *
 * HAPI wins on the reserved name, while all other user entries remain opaque
 * so Codex can handle the transport-specific fields it understands.
 */
export function mergeCodexMcpServers(
    userMcpServers: CodexMcpServersConfig,
    hapiMcpServers: CodexMcpServersConfig
): CodexMcpServersConfig {
    const merged = { ...userMcpServers };
    delete merged[HAPI_MCP_SERVER_NAME];
    return {
        ...merged,
        ...hapiMcpServers
    };
}

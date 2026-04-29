/**
 * Utilities for building Codex CLI config arguments (-c) for MCP servers
 * hooks, MCP servers, and developer instructions.
 *
 * Codex CLI accepts -c / --config flags with TOML-formatted key=value pairs.
 * This module generates the appropriate arguments for passing MCP server
 * configuration and developer instructions at runtime.
 */

import { getHappyCliCommand } from '@/utils/spawnHappyCLI';

/**
 * Escape a string value for use in a TOML string literal.
 * Handles double quotes, backslashes, and newlines.
 */
function escapeTomlString(value: string): string {
    return value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');
}

/**
 * Escape a string value for use in a TOML single-quoted literal string.
 * Only single quotes need escaping (by doubling them).
 */
function escapeTomlLiteralString(value: string): string {
    return value.replace(/'/g, "''");
}

function buildTomlLiteralArray(values: string[]): string {
    const items = values.map((value) => `'${escapeTomlLiteralString(value)}'`);
    return `[${items.join(',')}]`;
}

function shellQuote(value: string): string {
    if (value.length === 0) {
        return '""';
    }

    if (/^[A-Za-z0-9_\/:=-]+$/.test(value)) {
        return value;
    }

    return '"' + value.replace(/(["\\$`])/g, '\\$1') + '"';
}

function shellJoin(parts: string[]): string {
    return parts.map(shellQuote).join(' ');
}

export function buildSessionStartHookConfigArgs(port: number, token: string): string[] {
    const { command, args } = getHappyCliCommand([
        'hook-forwarder',
        '--port',
        String(port),
        '--token',
        token
    ]);
    const hookCommand = shellJoin([command, ...args]);
    const escapedHookCommand = escapeTomlString(hookCommand);
    const hookConfig = `hooks.SessionStart=[{ hooks = [{ type = "command", command = "${escapedHookCommand}" }] }]`;
    return ['-c', hookConfig];
}

/**
 * Build -c arguments for MCP server configuration.
 *
 * Generates arguments like:
 *   -c 'mcp_servers.hapi.command="hapi"'
 *   -c 'mcp_servers.hapi.args=['mcp', '--url', 'http://...']'
 *
 * @param mcpServers - Map of server name to server config
 * @returns Array of CLI arguments to pass to codex
 */
export function buildMcpServerConfigArgs(
    mcpServers: Record<string, { command: string; args: string[] }>
): string[] {
    const configArgs: string[] = [];

    for (const [name, server] of Object.entries(mcpServers)) {
        // -c 'mcp_servers.<name>.command="<command>"'
        configArgs.push('-c', `mcp_servers.${name}.command="${escapeTomlString(server.command)}"`);

        // -c 'mcp_servers.<name>.args=['arg1','arg2']'
        // Use TOML literal strings to avoid shell-quote mangling on Windows.
        const argsToml = buildTomlLiteralArray(server.args);
        configArgs.push('-c', `mcp_servers.${name}.args=${argsToml}`);
    }

    return configArgs;
}

/**
 * Build -c argument for developer instructions.
 *
 * Generates argument like:
 *   -c 'developer_instructions="<escaped instructions>"'
 *
 * @param instructions - Developer instructions text
 * @returns Array of CLI arguments to pass to codex
 */
export function buildDeveloperInstructionsArg(instructions: string): string[] {
    const escaped = escapeTomlString(instructions);
    return ['-c', `developer_instructions="${escaped}"`];
}

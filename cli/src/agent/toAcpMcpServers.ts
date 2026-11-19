import type { McpServerStdio } from './types';

export function toAcpMcpServers(config: Record<string, { command: string; args: string[] }>): McpServerStdio[] {
    return Object.entries(config).map(([name, entry]) => ({ name, command: entry.command, args: entry.args, env: [] }));
}

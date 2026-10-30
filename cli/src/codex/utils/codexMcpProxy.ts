import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getHappyCliCommand } from '@/utils/spawnHappyCLI';
import type { CodexMcpServersConfig } from './codexMcpServers';

const WINDOWS_COMMAND_SHIMS = new Set([
    'bunx',
    'npx',
    'npm',
    'pnpm',
    'uv',
    'uvx',
    'yarn'
]);

type StdioProxySpec = {
    command: string;
    args: string[];
    cwd?: string;
};

export type PreparedCodexMcpServers = {
    servers: CodexMcpServersConfig;
    proxiedServerNames: string[];
    cleanup: () => Promise<void>;
};

function commandBaseName(command: string): string {
    const normalized = command.trim().replace(/[\\/]+$/, '');
    const lastSeparator = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'));
    return (lastSeparator >= 0 ? normalized.slice(lastSeparator + 1) : normalized).toLowerCase();
}

/**
 * Codex currently launches Windows MCP commands verbatim. Package-manager
 * shims can close before returning the initialize response when launched by
 * the Rust stdio launcher, while the same process works through a native
 * HAPI child process. Keep the workaround narrow to known command shims.
 */
export function shouldProxyCodexMcpStdio(command: string, platform = process.platform): boolean {
    if (platform !== 'win32') {
        return false;
    }

    const baseName = commandBaseName(command);
    const executableName = baseName.endsWith('.exe') ? baseName.slice(0, -4) : baseName;
    return WINDOWS_COMMAND_SHIMS.has(baseName)
        || WINDOWS_COMMAND_SHIMS.has(executableName)
        || baseName.endsWith('.cmd')
        || baseName.endsWith('.bat');
}

function runsOnRemoteEnvironment(server: Record<string, unknown>): boolean {
    return server.experimental_environment === 'remote'
        || (typeof server.environment_id === 'string' && server.environment_id !== 'local');
}

async function writeProxySpec(spec: StdioProxySpec): Promise<{ directory: string; path: string }> {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-codex-mcp-'));
    const path = join(directory, `${randomUUID()}.json`);
    await writeFile(path, JSON.stringify(spec), { encoding: 'utf8', mode: 0o600 });
    return { directory, path };
}

/**
 * Prepare user MCP entries for a Codex session.
 *
 * Only Windows package-manager shims are proxied. All other entries, URL
 * transports, environment fields, and newer Codex fields remain unchanged.
 */
export async function prepareCodexMcpServers(
    servers: CodexMcpServersConfig,
    platform = process.platform
): Promise<PreparedCodexMcpServers> {
    const prepared: CodexMcpServersConfig = {};
    const proxiedServerNames: string[] = [];
    const temporaryDirectories: string[] = [];

    try {
        for (const [name, server] of Object.entries(servers)) {
            if (
                typeof server.command !== 'string'
                || runsOnRemoteEnvironment(server)
                || !shouldProxyCodexMcpStdio(server.command, platform)
            ) {
                prepared[name] = server;
                continue;
            }

            const spec = await writeProxySpec({
                command: server.command,
                args: Array.isArray(server.args)
                    ? server.args.filter((arg): arg is string => typeof arg === 'string')
                    : [],
                ...(typeof server.cwd === 'string' && server.cwd.trim().length > 0
                    ? { cwd: server.cwd }
                    : {})
            });
            temporaryDirectories.push(spec.directory);

            const proxyCommand = getHappyCliCommand(['mcp-proxy', '--spec', spec.path]);
            prepared[name] = {
                ...server,
                command: proxyCommand.command,
                args: proxyCommand.args
            };
            proxiedServerNames.push(name);
        }
    } catch (error) {
        await Promise.all(temporaryDirectories.map((directory) => rm(directory, { force: true, recursive: true })));
        throw error;
    }

    let cleaned = false;
    const cleanup = async () => {
        if (cleaned) {
            return;
        }
        cleaned = true;
        await Promise.all(temporaryDirectories.map((directory) => rm(directory, { force: true, recursive: true })));
    };

    return { servers: prepared, proxiedServerNames, cleanup };
}

/**
 * Cursor ACP does not connect MCP servers passed on session/new (upstream limitation).
 * The working path is project .cursor/mcp.json + `agent mcp enable <id>`.
 * See https://forum.cursor.com/t/acp-agent-silently-ignores-mcpservers-in-session-new/153623
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { logger } from '@/ui/logger';

export const CURSOR_HAPI_MCP_SERVER_ID = 'hapi';

type McpServerEntry = {
    command: string;
    args: string[];
    env?: Record<string, string>;
};

type CursorMcpJson = {
    mcpServers?: Record<string, McpServerEntry>;
};

export type CursorMcpOverlayHandle = {
    cleanup: () => void;
};

function parseMcpJson(raw: string): CursorMcpJson {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object') {
        return { mcpServers: {} };
    }
    return parsed as CursorMcpJson;
}

function readMcpJson(path: string): CursorMcpJson {
    if (!existsSync(path)) {
        return { mcpServers: {} };
    }
    return parseMcpJson(readFileSync(path, 'utf-8'));
}

function writeMcpJson(path: string, config: CursorMcpJson): void {
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

/**
 * Merge the per-session HAPI stdio bridge into `<cwd>/.cursor/mcp.json` and approve it
 * for Cursor's native MCP loader.
 *
 * Cleanup removes only the HAPI entry (or restores a pre-existing one). It never
 * rewrites the whole file from a pre-session snapshot, so concurrent edits to
 * other mcpServers keys survive the session.
 */
export function installCursorMcpOverlay(
    cwd: string,
    bridge: { command: string; args: string[] }
): CursorMcpOverlayHandle {
    const cursorDir = join(cwd, '.cursor');
    const mcpJsonPath = join(cursorDir, 'mcp.json');
    mkdirSync(cursorDir, { recursive: true });

    const hadFile = existsSync(mcpJsonPath);
    const previous = hadFile ? readMcpJson(mcpJsonPath) : { mcpServers: {} as Record<string, McpServerEntry> };
    previous.mcpServers ??= {};
    const hadHapi = Object.prototype.hasOwnProperty.call(previous.mcpServers, CURSOR_HAPI_MCP_SERVER_ID);
    const previousHapi = hadHapi ? previous.mcpServers[CURSOR_HAPI_MCP_SERVER_ID] : undefined;

    const config: CursorMcpJson = {
        ...previous,
        mcpServers: {
            ...previous.mcpServers,
            [CURSOR_HAPI_MCP_SERVER_ID]: {
                command: bridge.command,
                args: [...bridge.args],
            },
        },
    };

    writeMcpJson(mcpJsonPath, config);

    const enable = spawnSync('agent', ['mcp', 'enable', CURSOR_HAPI_MCP_SERVER_ID], {
        cwd,
        encoding: 'utf-8',
        timeout: 30_000,
    });

    if (enable.status !== 0) {
        const detail = (enable.stderr || enable.stdout || '').trim();
        logger.warn(
            `[cursor-acp] agent mcp enable ${CURSOR_HAPI_MCP_SERVER_ID} failed (status=${enable.status ?? 'null'}${detail ? `: ${detail}` : ''})`
        );
    } else {
        logger.debug(`[cursor-acp] enabled native MCP server ${CURSOR_HAPI_MCP_SERVER_ID} via .cursor/mcp.json`);
    }

    return {
        cleanup: () => {
            try {
                if (!existsSync(mcpJsonPath)) {
                    return;
                }

                const current = readMcpJson(mcpJsonPath);
                current.mcpServers ??= {};

                if (hadHapi && previousHapi) {
                    current.mcpServers[CURSOR_HAPI_MCP_SERVER_ID] = previousHapi;
                } else {
                    delete current.mcpServers[CURSOR_HAPI_MCP_SERVER_ID];
                }

                const remaining = Object.keys(current.mcpServers);
                if (!hadFile && remaining.length === 0) {
                    rmSync(mcpJsonPath, { force: true });
                    return;
                }

                writeMcpJson(mcpJsonPath, current);
            } catch (error) {
                logger.debug('[cursor-acp] cursor MCP overlay cleanup failed', error);
            }
        },
    };
}

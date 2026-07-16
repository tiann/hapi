import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { CURSOR_HAPI_MCP_SERVER_ID, installCursorMcpOverlay } from './cursorMcpOverlay';

describe('installCursorMcpOverlay', () => {
    const roots: string[] = [];

    afterEach(() => {
        for (const root of roots.splice(0)) {
            rmSync(root, { recursive: true, force: true });
        }
    });

    function makeProjectDir(initialMcpJson?: string): string {
        const root = join(tmpdir(), `hapi-cursor-mcp-${randomUUID()}`);
        mkdirSync(root, { recursive: true });
        roots.push(root);
        if (initialMcpJson !== undefined) {
            mkdirSync(join(root, '.cursor'), { recursive: true });
            writeFileSync(join(root, '.cursor', 'mcp.json'), initialMcpJson, 'utf-8');
        }
        return root;
    }

    it('writes hapi bridge into .cursor/mcp.json and restores on cleanup', () => {
        const cwd = makeProjectDir(JSON.stringify({
            mcpServers: {
                other: { command: 'echo', args: ['x'] },
            },
        }, null, 2));

        const mcpPath = join(cwd, '.cursor', 'mcp.json');
        const before = readFileSync(mcpPath, 'utf-8');

        const handle = installCursorMcpOverlay(cwd, {
            command: '/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:12345/'],
        });

        const merged = JSON.parse(readFileSync(mcpPath, 'utf-8')) as {
            mcpServers: Record<string, { command: string; args: string[] }>;
        };
        expect(merged.mcpServers.other).toEqual({ command: 'echo', args: ['x'] });
        expect(merged.mcpServers[CURSOR_HAPI_MCP_SERVER_ID]).toEqual({
            command: '/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:12345/'],
        });

        handle.cleanup();
        expect(readFileSync(mcpPath, 'utf-8')).toBe(before);
    });

    it('creates .cursor/mcp.json when missing and removes hapi entry on cleanup', () => {
        const cwd = makeProjectDir();
        expect(existsSync(join(cwd, '.cursor', 'mcp.json'))).toBe(false);

        const handle = installCursorMcpOverlay(cwd, {
            command: 'hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:9999/'],
        });

        const mcpPath = join(cwd, '.cursor', 'mcp.json');
        expect(existsSync(mcpPath)).toBe(true);

        handle.cleanup();

        if (existsSync(mcpPath)) {
            const after = JSON.parse(readFileSync(mcpPath, 'utf-8')) as {
                mcpServers?: Record<string, unknown>;
            };
            expect(after.mcpServers?.[CURSOR_HAPI_MCP_SERVER_ID]).toBeUndefined();
        }
    });
});

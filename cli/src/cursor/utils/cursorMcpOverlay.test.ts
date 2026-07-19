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

    it('writes hapi bridge into .cursor/mcp.json and removes only hapi on cleanup', () => {
        const cwd = makeProjectDir(JSON.stringify({
            mcpServers: {
                other: { command: 'echo', args: ['x'] },
            },
        }, null, 2));

        const mcpPath = join(cwd, '.cursor', 'mcp.json');

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
        const after = JSON.parse(readFileSync(mcpPath, 'utf-8')) as {
            mcpServers: Record<string, { command: string; args: string[] }>;
        };
        expect(after.mcpServers.other).toEqual({ command: 'echo', args: ['x'] });
        expect(after.mcpServers[CURSOR_HAPI_MCP_SERVER_ID]).toBeUndefined();
    });

    it('preserves mcpServers keys added during the session on cleanup', () => {
        const cwd = makeProjectDir(JSON.stringify({
            mcpServers: {
                other: { command: 'echo', args: ['x'] },
            },
        }, null, 2));

        const mcpPath = join(cwd, '.cursor', 'mcp.json');
        const handle = installCursorMcpOverlay(cwd, {
            command: '/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:12345/'],
        });

        writeFileSync(mcpPath, JSON.stringify({
            mcpServers: {
                other: { command: 'echo', args: ['x'] },
                [CURSOR_HAPI_MCP_SERVER_ID]: {
                    command: '/bin/hapi',
                    args: ['mcp', '--url', 'http://127.0.0.1:12345/'],
                },
                concurrent: { command: 'npx', args: ['-y', 'some-mcp'] },
            },
        }, null, 2) + '\n', 'utf-8');

        handle.cleanup();

        const after = JSON.parse(readFileSync(mcpPath, 'utf-8')) as {
            mcpServers: Record<string, { command: string; args: string[] }>;
        };
        expect(after.mcpServers.other).toEqual({ command: 'echo', args: ['x'] });
        expect(after.mcpServers.concurrent).toEqual({ command: 'npx', args: ['-y', 'some-mcp'] });
        expect(after.mcpServers[CURSOR_HAPI_MCP_SERVER_ID]).toBeUndefined();
    });

    it('restores a pre-existing hapi entry instead of deleting it', () => {
        const priorHapi = { command: 'old-hapi', args: ['mcp'] };
        const cwd = makeProjectDir(JSON.stringify({
            mcpServers: {
                [CURSOR_HAPI_MCP_SERVER_ID]: priorHapi,
            },
        }, null, 2));

        const mcpPath = join(cwd, '.cursor', 'mcp.json');
        const handle = installCursorMcpOverlay(cwd, {
            command: '/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:12345/'],
        });

        handle.cleanup();

        const after = JSON.parse(readFileSync(mcpPath, 'utf-8')) as {
            mcpServers: Record<string, { command: string; args: string[] }>;
        };
        expect(after.mcpServers[CURSOR_HAPI_MCP_SERVER_ID]).toEqual(priorHapi);
    });

    it('preserves a mid-session replacement of the hapi entry on cleanup', () => {
        const cwd = makeProjectDir(JSON.stringify({
            mcpServers: {
                other: { command: 'echo', args: ['x'] },
            },
        }, null, 2));

        const mcpPath = join(cwd, '.cursor', 'mcp.json');
        const handle = installCursorMcpOverlay(cwd, {
            command: '/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:12345/'],
        });

        const userOwnedHapi = { command: 'user-hapi', args: ['mcp', '--custom'] };
        writeFileSync(mcpPath, JSON.stringify({
            mcpServers: {
                other: { command: 'echo', args: ['x'] },
                [CURSOR_HAPI_MCP_SERVER_ID]: userOwnedHapi,
            },
        }, null, 2) + '\n', 'utf-8');

        handle.cleanup();

        const after = JSON.parse(readFileSync(mcpPath, 'utf-8')) as {
            mcpServers: Record<string, { command: string; args: string[] }>;
        };
        expect(after.mcpServers[CURSOR_HAPI_MCP_SERVER_ID]).toEqual(userOwnedHapi);
        expect(after.mcpServers.other).toEqual({ command: 'echo', args: ['x'] });
    });

    it('creates .cursor/mcp.json when missing and removes file when only hapi was present', () => {
        const cwd = makeProjectDir();
        expect(existsSync(join(cwd, '.cursor', 'mcp.json'))).toBe(false);

        const handle = installCursorMcpOverlay(cwd, {
            command: 'hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:9999/'],
        });

        const mcpPath = join(cwd, '.cursor', 'mcp.json');
        expect(existsSync(mcpPath)).toBe(true);

        handle.cleanup();
        expect(existsSync(mcpPath)).toBe(false);
    });

    it('throws when existing .cursor/mcp.json is not valid JSON', () => {
        const cwd = makeProjectDir('{ not-json');
        expect(() => installCursorMcpOverlay(cwd, {
            command: 'hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:9999/'],
        })).toThrow();
        // Malformed project config must stay untouched for the launcher try/catch path.
        expect(readFileSync(join(cwd, '.cursor', 'mcp.json'), 'utf-8')).toBe('{ not-json');
    });
});

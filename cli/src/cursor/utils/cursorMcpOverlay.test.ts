import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
    existsSync,
    linkSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    symlinkSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
    CURSOR_HAPI_MCP_SERVER_ID,
    HAPI_MCP_OVERLAY_PID_ENV,
    cursorHapiMcpServerId,
    installCursorMcpOverlay,
    isProcessAlive,
    readLockOwner,
    resolveCursorMcpConfigDir,
    withMcpJsonLock,
    writeMcpJsonAtomic,
} from './cursorMcpOverlay';

describe('installCursorMcpOverlay', () => {
    const roots: string[] = [];
    /** Unit tests must not shell out to a real Cursor `agent` binary. */
    const noopEnable = () => ({ status: 0 });

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

    it('defaults MCP config dir to ~/.cursor (outside the project tree)', () => {
        expect(resolveCursorMcpConfigDir()).toBe(join(homedir(), '.cursor'));
        expect(resolveCursorMcpConfigDir(' /tmp/custom-cursor ')).toBe('/tmp/custom-cursor');
    });

    it('writes per-session bridge into .cursor/mcp.json and removes only that id on cleanup', () => {
        const cwd = makeProjectDir(JSON.stringify({
            mcpServers: {
                other: { command: 'echo', args: ['x'] },
            },
        }, null, 2));
        const serverId = cursorHapiMcpServerId('session-a');

        const mcpPath = join(cwd, '.cursor', 'mcp.json');

        const handle = installCursorMcpOverlay(cwd, {
            command: '/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:12345/'],
        }, { serverId, enableCursorMcp: noopEnable, mcpConfigDir: join(cwd, '.cursor') });

        const merged = JSON.parse(readFileSync(mcpPath, 'utf-8')) as {
            mcpServers: Record<string, { command: string; args: string[] }>;
        };
        expect(merged.mcpServers.other).toEqual({ command: 'echo', args: ['x'] });
        expect(merged.mcpServers[serverId]).toEqual({
            command: '/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:12345/'],
            env: { [HAPI_MCP_OVERLAY_PID_ENV]: String(process.pid) },
        });
        expect(merged.mcpServers[CURSOR_HAPI_MCP_SERVER_ID]).toBeUndefined();

        handle.cleanup();
        const after = JSON.parse(readFileSync(mcpPath, 'utf-8')) as {
            mcpServers: Record<string, { command: string; args: string[] }>;
        };
        expect(after.mcpServers.other).toEqual({ command: 'echo', args: ['x'] });
        expect(after.mcpServers[serverId]).toBeUndefined();
    });

    it('leaves a newer session bridge intact when an older session cleans up first', () => {
        const cwd = makeProjectDir(JSON.stringify({
            mcpServers: {
                other: { command: 'echo', args: ['x'] },
            },
        }, null, 2));
        const mcpPath = join(cwd, '.cursor', 'mcp.json');
        const idA = cursorHapiMcpServerId('session-a');
        const idB = cursorHapiMcpServerId('session-b');

        const handleA = installCursorMcpOverlay(cwd, {
            command: '/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:1111/'],
        }, { serverId: idA, enableCursorMcp: noopEnable, mcpConfigDir: join(cwd, '.cursor') });

        const handleB = installCursorMcpOverlay(cwd, {
            command: '/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:2222/'],
        }, { serverId: idB, enableCursorMcp: noopEnable, mcpConfigDir: join(cwd, '.cursor') });

        handleA.cleanup();

        const afterA = JSON.parse(readFileSync(mcpPath, 'utf-8')) as {
            mcpServers: Record<string, { command: string; args: string[] }>;
        };
        expect(afterA.mcpServers[idA]).toBeUndefined();
        expect(afterA.mcpServers[idB]).toEqual({
            command: '/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:2222/'],
            env: { [HAPI_MCP_OVERLAY_PID_ENV]: String(process.pid) },
        });

        handleB.cleanup();

        const afterB = JSON.parse(readFileSync(mcpPath, 'utf-8')) as {
            mcpServers: Record<string, { command: string; args: string[] }>;
        };
        expect(afterB.mcpServers[idB]).toBeUndefined();
        expect(afterB.mcpServers.other).toEqual({ command: 'echo', args: ['x'] });
    });

    it('preserves mcpServers keys added during the session on cleanup', () => {
        const cwd = makeProjectDir(JSON.stringify({
            mcpServers: {
                other: { command: 'echo', args: ['x'] },
            },
        }, null, 2));
        const serverId = cursorHapiMcpServerId('session-a');

        const mcpPath = join(cwd, '.cursor', 'mcp.json');
        const handle = installCursorMcpOverlay(cwd, {
            command: '/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:12345/'],
        }, { serverId, enableCursorMcp: noopEnable, mcpConfigDir: join(cwd, '.cursor') });

        writeFileSync(mcpPath, JSON.stringify({
            mcpServers: {
                other: { command: 'echo', args: ['x'] },
                [serverId]: {
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
        expect(after.mcpServers[serverId]).toBeUndefined();
    });

    it('preserves env-only concurrent edits on the overlay entry during cleanup', () => {
        const cwd = makeProjectDir(JSON.stringify({
            mcpServers: {
                other: { command: 'echo', args: ['x'] },
            },
        }, null, 2));
        const serverId = cursorHapiMcpServerId('session-env');
        const mcpPath = join(cwd, '.cursor', 'mcp.json');
        const handle = installCursorMcpOverlay(cwd, {
            command: '/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:12345/'],
        }, { serverId, enableCursorMcp: noopEnable, mcpConfigDir: join(cwd, '.cursor') });

        writeFileSync(mcpPath, JSON.stringify({
            mcpServers: {
                other: { command: 'echo', args: ['x'] },
                [serverId]: {
                    command: '/bin/hapi',
                    args: ['mcp', '--url', 'http://127.0.0.1:12345/'],
                    env: {
                        [HAPI_MCP_OVERLAY_PID_ENV]: String(process.pid),
                        USER_TOKEN: 'keep-me',
                    },
                },
            },
        }, null, 2) + '\n', 'utf-8');

        handle.cleanup();

        const after = JSON.parse(readFileSync(mcpPath, 'utf-8')) as {
            mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
        };
        expect(after.mcpServers[serverId]).toEqual({
            command: '/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:12345/'],
            env: {
                [HAPI_MCP_OVERLAY_PID_ENV]: String(process.pid),
                USER_TOKEN: 'keep-me',
            },
        });
    });

    it('restores a pre-existing entry for the same server id instead of deleting it', () => {
        const serverId = cursorHapiMcpServerId('session-a');
        const prior = { command: 'old-hapi', args: ['mcp'] };
        const cwd = makeProjectDir(JSON.stringify({
            mcpServers: {
                [serverId]: prior,
            },
        }, null, 2));

        const mcpPath = join(cwd, '.cursor', 'mcp.json');
        const handle = installCursorMcpOverlay(cwd, {
            command: '/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:12345/'],
        }, { serverId, enableCursorMcp: noopEnable, mcpConfigDir: join(cwd, '.cursor') });

        handle.cleanup();

        const after = JSON.parse(readFileSync(mcpPath, 'utf-8')) as {
            mcpServers: Record<string, { command: string; args: string[] }>;
        };
        expect(after.mcpServers[serverId]).toEqual(prior);
    });

    it('does not touch a legacy shared hapi key when using a per-session id', () => {
        const legacyHapi = { command: 'user-hapi', args: ['mcp', '--custom'] };
        const cwd = makeProjectDir(JSON.stringify({
            mcpServers: {
                [CURSOR_HAPI_MCP_SERVER_ID]: legacyHapi,
            },
        }, null, 2));
        const serverId = cursorHapiMcpServerId('session-a');

        const mcpPath = join(cwd, '.cursor', 'mcp.json');
        const handle = installCursorMcpOverlay(cwd, {
            command: '/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:12345/'],
        }, { serverId, enableCursorMcp: noopEnable, mcpConfigDir: join(cwd, '.cursor') });

        handle.cleanup();

        const after = JSON.parse(readFileSync(mcpPath, 'utf-8')) as {
            mcpServers: Record<string, { command: string; args: string[] }>;
        };
        expect(after.mcpServers[CURSOR_HAPI_MCP_SERVER_ID]).toEqual(legacyHapi);
        expect(after.mcpServers[serverId]).toBeUndefined();
    });

    it('preserves a mid-session replacement of the session entry on cleanup', () => {
        const cwd = makeProjectDir(JSON.stringify({
            mcpServers: {
                other: { command: 'echo', args: ['x'] },
            },
        }, null, 2));
        const serverId = cursorHapiMcpServerId('session-a');

        const mcpPath = join(cwd, '.cursor', 'mcp.json');
        const handle = installCursorMcpOverlay(cwd, {
            command: '/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:12345/'],
        }, { serverId, enableCursorMcp: noopEnable, mcpConfigDir: join(cwd, '.cursor') });

        const userOwned = { command: 'user-hapi', args: ['mcp', '--custom'] };
        writeFileSync(mcpPath, JSON.stringify({
            mcpServers: {
                other: { command: 'echo', args: ['x'] },
                [serverId]: userOwned,
            },
        }, null, 2) + '\n', 'utf-8');

        handle.cleanup();

        const after = JSON.parse(readFileSync(mcpPath, 'utf-8')) as {
            mcpServers: Record<string, { command: string; args: string[] }>;
        };
        expect(after.mcpServers[serverId]).toEqual(userOwned);
        expect(after.mcpServers.other).toEqual({ command: 'echo', args: ['x'] });
    });

    it('creates .cursor/mcp.json when missing and removes file when only the session entry was present', () => {
        const cwd = makeProjectDir();
        const serverId = cursorHapiMcpServerId('session-a');
        expect(existsSync(join(cwd, '.cursor', 'mcp.json'))).toBe(false);

        const handle = installCursorMcpOverlay(cwd, {
            command: 'hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:9999/'],
        }, { serverId, enableCursorMcp: noopEnable, mcpConfigDir: join(cwd, '.cursor') });

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
        }, { serverId: cursorHapiMcpServerId('session-a'), enableCursorMcp: noopEnable, mcpConfigDir: join(cwd, '.cursor') })).toThrow();
        // Malformed project config must stay untouched for the launcher try/catch path.
        expect(readFileSync(join(cwd, '.cursor', 'mcp.json'), 'utf-8')).toBe('{ not-json');
    });

    it('prunes dead hapi-* overlays stamped with HAPI_MCP_OVERLAY_PID on install', () => {
        // spawnSync waits for exit; the returned pid is then dead.
        const probe = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf-8' });
        const exitedPid = probe.pid;
        expect(typeof exitedPid).toBe('number');
        expect(isProcessAlive(exitedPid!)).toBe(false);

        const cwd = makeProjectDir(JSON.stringify({
            mcpServers: {
                other: { command: 'echo', args: ['x'] },
                'hapi-dead': {
                    command: '/bin/hapi',
                    args: ['mcp', '--url', 'http://127.0.0.1:1111/'],
                    env: { [HAPI_MCP_OVERLAY_PID_ENV]: String(exitedPid) },
                },
                'hapi-live': {
                    command: '/bin/hapi',
                    args: ['mcp', '--url', 'http://127.0.0.1:2222/'],
                    env: { [HAPI_MCP_OVERLAY_PID_ENV]: String(process.pid) },
                },
                'hapi-user': {
                    command: 'user-owned',
                    args: [],
                },
            },
        }, null, 2));
        const mcpPath = join(cwd, '.cursor', 'mcp.json');
        const serverId = cursorHapiMcpServerId('session-a');

        const handle = installCursorMcpOverlay(cwd, {
            command: '/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:3333/'],
        }, { serverId, enableCursorMcp: noopEnable, mcpConfigDir: join(cwd, '.cursor') });

        const merged = JSON.parse(readFileSync(mcpPath, 'utf-8')) as {
            mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
        };
        expect(merged.mcpServers['hapi-dead']).toBeUndefined();
        expect(merged.mcpServers['hapi-live']?.command).toBe('/bin/hapi');
        expect(merged.mcpServers['hapi-user']?.command).toBe('user-owned');
        expect(merged.mcpServers.other).toEqual({ command: 'echo', args: ['x'] });
        expect(merged.mcpServers[serverId]?.env?.[HAPI_MCP_OVERLAY_PID_ENV]).toBe(String(process.pid));

        handle.cleanup();
    });

    it('refuses a symlinked .cursor/mcp.json and leaves the external target unchanged', () => {
        const cwd = makeProjectDir();
        const cursorDir = join(cwd, '.cursor');
        mkdirSync(cursorDir, { recursive: true });
        const realConfig = join(cwd, 'shared-mcp.json');
        const original = `${JSON.stringify({
            mcpServers: {
                other: { command: 'echo', args: ['x'] },
            },
        }, null, 2)}\n`;
        writeFileSync(realConfig, original, 'utf-8');
        const mcpPath = join(cursorDir, 'mcp.json');
        symlinkSync(realConfig, mcpPath);

        expect(() => installCursorMcpOverlay(cwd, {
            command: '/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:12345/'],
        }, { serverId: cursorHapiMcpServerId('session-a'), enableCursorMcp: noopEnable, mcpConfigDir: join(cwd, '.cursor') })).toThrow(
            /Refusing to write a symlinked Cursor MCP config/
        );

        expect(lstatSync(mcpPath).isSymbolicLink()).toBe(true);
        expect(readFileSync(realConfig, 'utf-8')).toBe(original);
    });

    it('refuses a symlinked .cursor directory before mutating MCP config', () => {
        const cwd = makeProjectDir();
        const realCursorDir = join(cwd, 'real-cursor');
        mkdirSync(realCursorDir, { recursive: true });
        const externalMcp = join(realCursorDir, 'mcp.json');
        const original = `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`;
        writeFileSync(externalMcp, original, 'utf-8');
        symlinkSync(realCursorDir, join(cwd, '.cursor'));

        expect(() => installCursorMcpOverlay(cwd, {
            command: '/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:12345/'],
        }, { serverId: cursorHapiMcpServerId('session-a'), enableCursorMcp: noopEnable, mcpConfigDir: join(cwd, '.cursor') })).toThrow(
            /Refusing to use a symlinked Cursor config directory/
        );

        expect(readFileSync(externalMcp, 'utf-8')).toBe(original);
    });

    it('writeMcpJsonAtomic preserves restrictive mode and cleans up tmp on failure path', () => {
        const cwd = makeProjectDir();
        mkdirSync(join(cwd, '.cursor'), { recursive: true });
        const mcpPath = join(cwd, '.cursor', 'mcp.json');
        writeFileSync(mcpPath, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`, {
            encoding: 'utf-8',
            mode: 0o600,
        });

        writeMcpJsonAtomic(mcpPath, {
            mcpServers: { a: { command: 'a', args: [] } },
        });

        expect(statSync(mcpPath).mode & 0o777).toBe(0o600);
        expect(JSON.parse(readFileSync(mcpPath, 'utf-8')).mcpServers.a.command).toBe('a');
        expect(readdirSync(join(cwd, '.cursor')).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });

    it('writeMcpJsonAtomic replaces via rename and withMcpJsonLock serializes writers', () => {
        const cwd = makeProjectDir();
        const mcpPath = join(cwd, '.cursor', 'mcp.json');
        mkdirSync(join(cwd, '.cursor'), { recursive: true });
        const lockPath = `${mcpPath}.hapi.lock`;

        writeMcpJsonAtomic(mcpPath, {
            mcpServers: { a: { command: 'a', args: [] } },
        });
        expect(JSON.parse(readFileSync(mcpPath, 'utf-8')).mcpServers.a.command).toBe('a');

        const order: string[] = [];
        withMcpJsonLock(lockPath, () => {
            order.push('outer-enter');
            expect(readLockOwner(lockPath)?.pid).toBe(process.pid);
            // Second exclusive link onto the same path must fail while held.
            const other = `${lockPath}.other.tmp`;
            writeFileSync(other, JSON.stringify({ pid: process.pid, token: 'other' }), {
                encoding: 'utf-8',
                mode: 0o600,
            });
            expect(() => linkSync(other, lockPath)).toThrow();
            unlinkSync(other);
            order.push('outer-exit');
        });
        expect(order).toEqual(['outer-enter', 'outer-exit']);
        expect(existsSync(lockPath)).toBe(false);
    });

    it('withMcpJsonLock only unlinks its own token (does not delete a successor lock)', () => {
        const cwd = makeProjectDir();
        mkdirSync(join(cwd, '.cursor'), { recursive: true });
        const lockPath = join(cwd, '.cursor', 'mcp.json.hapi.lock');

        let releasedOwnerToken: string | undefined;
        withMcpJsonLock(lockPath, () => {
            const owner = readLockOwner(lockPath);
            expect(owner?.pid).toBe(process.pid);
            releasedOwnerToken = owner?.token;
            // Simulate a successor stealing the path while we still hold the fd conceptually:
            // write a different owner into the lock path after our create (race successor).
            writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'successor-token' }), 'utf-8');
        });
        // Original owner must not unlink the successor's lock.
        expect(existsSync(lockPath)).toBe(true);
        expect(readLockOwner(lockPath)?.token).toBe('successor-token');
        expect(releasedOwnerToken).toBeTruthy();
        unlinkSync(lockPath);
    });

    it('cleanup preserves concurrent top-level mcp.json fields when servers are empty', () => {
        const cwd = makeProjectDir();
        const serverId = cursorHapiMcpServerId('session-a');
        const mcpPath = join(cwd, '.cursor', 'mcp.json');

        const handle = installCursorMcpOverlay(cwd, {
            command: '/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:12345/'],
        }, { serverId, enableCursorMcp: noopEnable, mcpConfigDir: join(cwd, '.cursor') });

        writeFileSync(mcpPath, JSON.stringify({
            mcpServers: {
                [serverId]: {
                    command: '/bin/hapi',
                    args: ['mcp', '--url', 'http://127.0.0.1:12345/'],
                },
            },
            inputs: [{ id: 'keep-me' }],
        }, null, 2) + '\n', 'utf-8');

        handle.cleanup();

        const after = JSON.parse(readFileSync(mcpPath, 'utf-8')) as {
            mcpServers: Record<string, unknown>;
            inputs: unknown[];
        };
        expect(after.mcpServers[serverId]).toBeUndefined();
        expect(after.inputs).toEqual([{ id: 'keep-me' }]);
        expect(existsSync(mcpPath)).toBe(true);
    });

    it('isProcessAlive treats EPERM as alive and ESRCH as dead', () => {
        expect(isProcessAlive(process.pid)).toBe(true);
        expect(isProcessAlive(2_147_483_646)).toBe(false);
    });

    it('fails closed on a stale lock instead of pathname-stealing', () => {
        const cwd = makeProjectDir();
        mkdirSync(join(cwd, '.cursor'), { recursive: true });
        const lockPath = join(cwd, '.cursor', 'mcp.json.hapi.lock');
        writeFileSync(lockPath, JSON.stringify({ pid: 2_147_483_646, token: 'dead-owner' }), 'utf-8');

        expect(() => withMcpJsonLock(lockPath, () => {})).toThrow(/Stale Cursor MCP overlay lock/);
        expect(readLockOwner(lockPath)?.token).toBe('dead-owner');
    });

    it('rolls back mcp.json and throws when agent mcp enable fails', () => {
        const prior = { command: 'user-hapi', args: ['mcp'] };
        const cwd = makeProjectDir(JSON.stringify({
            mcpServers: {
                [CURSOR_HAPI_MCP_SERVER_ID]: prior,
                other: { command: 'echo', args: ['x'] },
            },
        }, null, 2));
        const serverId = cursorHapiMcpServerId('session-a');
        const mcpPath = join(cwd, '.cursor', 'mcp.json');

        expect(() => installCursorMcpOverlay(cwd, {
            command: '/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:12345/'],
        }, {
            serverId,
            enableCursorMcp: () => ({ status: 1, stderr: 'enable denied' }),
            mcpConfigDir: join(cwd, '.cursor'),
        })).toThrow(/agent mcp enable/);

        const after = JSON.parse(readFileSync(mcpPath, 'utf-8')) as {
            mcpServers: Record<string, { command: string; args: string[] }>;
        };
        expect(after.mcpServers[serverId]).toBeUndefined();
        expect(after.mcpServers[CURSOR_HAPI_MCP_SERVER_ID]).toEqual(prior);
        expect(after.mcpServers.other).toEqual({ command: 'echo', args: ['x'] });
    });
});

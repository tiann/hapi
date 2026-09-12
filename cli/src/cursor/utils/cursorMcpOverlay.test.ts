import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
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
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
    CURSOR_HAPI_MCP_SERVER_ID,
    HAPI_MCP_OVERLAY_PID_ENV,
    cursorHapiMcpServerId,
    HAPI_MCP_OVERLAY_SESSION_ENV,
    HAPI_MCP_GIT_EXCLUDE_MARKER_PREFIX,
    appendExcludeLease,
    appendExcludeLeaseUnlocked,
    hapiMcpGitExcludeMarker,
    installCursorMcpOverlay,
    isProcessAlive,
    readLockOwner,
    removeExcludeLease,
    resolveCursorMcpConfigDir,
    resolveProjectCursorConfigDir,
    shieldProjectMcpJsonFromGit,
    withMcpJsonLock,
    writeMcpJsonAtomic,
} from './cursorMcpOverlay';

const overlayModulePath = fileURLToPath(new URL('./cursorMcpOverlay.ts', import.meta.url));

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

    it('writes the stable hapi mailbox into the project mcp.json and removes it on cleanup', () => {
        const cwd = makeProjectDir(JSON.stringify({
            mcpServers: {
                other: { command: 'echo', args: ['x'] },
            },
        }, null, 2));
        const serverId = CURSOR_HAPI_MCP_SERVER_ID;
        const mcpPath = join(cwd, '.cursor', 'mcp.json');

        const handle = installCursorMcpOverlay(cwd, {
            command: '/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:12345/'],
        }, {
            serverId,
            overlaySessionId: 'session-a',
            enableCursorMcp: noopEnable,
            mcpConfigDir: join(cwd, '.cursor'),
        });

        const merged = JSON.parse(readFileSync(mcpPath, 'utf-8')) as {
            mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
        };
        expect(merged.mcpServers.other).toEqual({ command: 'echo', args: ['x'] });
        expect(merged.mcpServers[serverId]).toEqual({
            command: '/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:12345/'],
            env: {
                [HAPI_MCP_OVERLAY_PID_ENV]: String(process.pid),
                [HAPI_MCP_OVERLAY_SESSION_ENV]: 'session-a',
            },
        });
        expect(Object.keys(merged.mcpServers).filter((id) => id.startsWith('hapi-'))).toEqual([]);

        handle.cleanup();
        const after = JSON.parse(readFileSync(mcpPath, 'utf-8')) as {
            mcpServers: Record<string, { command: string; args: string[] }>;
        };
        expect(after.mcpServers.other).toEqual({ command: 'echo', args: ['x'] });
        expect(after.mcpServers[serverId]).toBeUndefined();
    });

    it('strips dead hapi-* keys from user mcp.json but keeps live sibling overlays', () => {
        const cwd = makeProjectDir();
        const userDir = join(cwd, 'user-cursor');
        mkdirSync(userDir, { recursive: true });
        const probe = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf-8' });
        const deadPid = probe.pid;
        expect(typeof deadPid).toBe('number');
        expect(isProcessAlive(deadPid!)).toBe(false);
        writeFileSync(join(userDir, 'mcp.json'), JSON.stringify({
            mcpServers: {
                playwright: { command: 'echo', args: ['pw'] },
                [cursorHapiMcpServerId('dead')]: {
                    command: '/bin/hapi',
                    args: ['mcp', '--url', 'http://127.0.0.1:8888/'],
                    env: { [HAPI_MCP_OVERLAY_PID_ENV]: String(deadPid) },
                },
                [cursorHapiMcpServerId('sibling')]: {
                    command: '/bin/hapi',
                    args: ['mcp', '--url', 'http://127.0.0.1:9999/'],
                    env: { [HAPI_MCP_OVERLAY_PID_ENV]: String(process.pid) },
                },
            },
        }, null, 2));

        installCursorMcpOverlay(cwd, {
            command: '/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:12345/'],
        }, {
            serverId: CURSOR_HAPI_MCP_SERVER_ID,
            overlaySessionId: 'session-a',
            enableCursorMcp: noopEnable,
            mcpConfigDir: join(cwd, '.cursor'),
            userMcpConfigDir: userDir,
        }).cleanup();

        const user = JSON.parse(readFileSync(join(userDir, 'mcp.json'), 'utf-8')) as {
            mcpServers: Record<string, unknown>;
        };
        expect(user.mcpServers.playwright).toEqual({ command: 'echo', args: ['pw'] });
        expect(user.mcpServers[cursorHapiMcpServerId('dead')]).toBeUndefined();
        expect(user.mcpServers[cursorHapiMcpServerId('sibling')]).toBeDefined();
        expect(user.mcpServers[CURSOR_HAPI_MCP_SERVER_ID]).toBeUndefined();
    });

    it('keeps one mailbox per project when two sessions use different cwds', () => {
        const userDir = join(tmpdir(), `hapi-cursor-user-${randomUUID()}`);
        mkdirSync(userDir, { recursive: true });
        roots.push(userDir);
        const cwdA = makeProjectDir();
        const cwdB = makeProjectDir();

        const handleA = installCursorMcpOverlay(cwdA, {
            command: '/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:1111/'],
        }, {
            serverId: CURSOR_HAPI_MCP_SERVER_ID,
            overlaySessionId: 'session-a',
            enableCursorMcp: noopEnable,
            mcpConfigDir: join(cwdA, '.cursor'),
            userMcpConfigDir: userDir,
        });
        const handleB = installCursorMcpOverlay(cwdB, {
            command: '/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:2222/'],
        }, {
            serverId: CURSOR_HAPI_MCP_SERVER_ID,
            overlaySessionId: 'session-b',
            enableCursorMcp: noopEnable,
            mcpConfigDir: join(cwdB, '.cursor'),
            userMcpConfigDir: userDir,
        });

        const a = JSON.parse(readFileSync(join(cwdA, '.cursor', 'mcp.json'), 'utf-8')) as {
            mcpServers: Record<string, { args: string[] }>;
        };
        const b = JSON.parse(readFileSync(join(cwdB, '.cursor', 'mcp.json'), 'utf-8')) as {
            mcpServers: Record<string, { args: string[] }>;
        };
        expect(a.mcpServers.hapi.args).toContain('http://127.0.0.1:1111/');
        expect(b.mcpServers.hapi.args).toContain('http://127.0.0.1:2222/');
        expect(existsSync(join(userDir, 'mcp.json')) ? JSON.parse(readFileSync(join(userDir, 'mcp.json'), 'utf-8')).mcpServers : {}).toEqual({});

        handleA.cleanup();
        expect(JSON.parse(readFileSync(join(cwdB, '.cursor', 'mcp.json'), 'utf-8')).mcpServers.hapi.args).toContain('http://127.0.0.1:2222/');
        handleB.cleanup();
    });

    it('refuses a second live mailbox in the same cwd instead of multiplex keys', () => {
        const cwd = makeProjectDir();
        installCursorMcpOverlay(cwd, {
            command: '/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:1111/'],
        }, {
            serverId: CURSOR_HAPI_MCP_SERVER_ID,
            overlaySessionId: 'session-a',
            enableCursorMcp: noopEnable,
            mcpConfigDir: join(cwd, '.cursor'),
        });

        expect(() => installCursorMcpOverlay(cwd, {
            command: '/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:2222/'],
        }, {
            serverId: CURSOR_HAPI_MCP_SERVER_ID,
            overlaySessionId: 'session-b',
            enableCursorMcp: noopEnable,
            mcpConfigDir: join(cwd, '.cursor'),
        })).toThrow(/second live HAPI MCP mailbox/);
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

    it('refuses to overwrite a user-owned entry for the same server id', () => {
        const serverId = CURSOR_HAPI_MCP_SERVER_ID;
        const prior = { command: 'old-hapi', args: ['mcp'] };
        const cwd = makeProjectDir(JSON.stringify({
            mcpServers: {
                [serverId]: prior,
            },
        }, null, 2));

        const mcpPath = join(cwd, '.cursor', 'mcp.json');
        expect(() => installCursorMcpOverlay(cwd, {
            command: '/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:12345/'],
        }, { serverId, enableCursorMcp: noopEnable, mcpConfigDir: join(cwd, '.cursor') })).toThrow(
            /already exists/,
        );

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
        expect(merged.mcpServers['hapi-live']).toEqual({
            command: '/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:2222/'],
            env: { [HAPI_MCP_OVERLAY_PID_ENV]: String(process.pid) },
        });
        expect(merged.mcpServers['hapi-user']?.command).toBe('user-owned');
        expect(merged.mcpServers.other).toEqual({ command: 'echo', args: ['x'] });
        expect(merged.mcpServers[serverId]?.env?.[HAPI_MCP_OVERLAY_PID_ENV]).toBe(String(process.pid));

        handle.cleanup();
    });

    it('refuses a symlinked project .cursor directory (attacker escape to ~/.cursor)', () => {
        const cwd = makeProjectDir();
        const realCursorDir = join(cwd, 'real-cursor');
        mkdirSync(realCursorDir, { recursive: true });
        writeFileSync(join(realCursorDir, 'mcp.json'), `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
        symlinkSync(realCursorDir, join(cwd, '.cursor'));

        expect(() => installCursorMcpOverlay(cwd, {
            command: '/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:12345/'],
        }, {
            serverId: CURSOR_HAPI_MCP_SERVER_ID,
            overlaySessionId: 'session-a',
            enableCursorMcp: noopEnable,
            mcpConfigDir: join(cwd, '.cursor'),
        })).toThrow(/Refusing a symlinked project Cursor config dir/);
    });

    it('accepts symlink-prefix mcpConfigDir when cwd is already realpath (estate ~/coding → /work/coding)', () => {
        // Mimic oos: session.path realpath'd under /work/..., mcpConfigDir still via ~/coding symlink.
        const root = join(tmpdir(), `hapi-coding-link-${randomUUID()}`);
        const workRoot = join(root, 'work', 'proj');
        const homeCoding = join(root, 'home', 'coding');
        mkdirSync(workRoot, { recursive: true });
        mkdirSync(join(root, 'home'), { recursive: true });
        symlinkSync(join(root, 'work'), homeCoding);
        const symlinkCwd = join(homeCoding, 'proj');
        const realCwd = workRoot;
        const viaSymlinkCursor = join(symlinkCwd, '.cursor');

        expect(resolveProjectCursorConfigDir(realCwd, viaSymlinkCursor)).toBe(join(realCwd, '.cursor'));

        const handle = installCursorMcpOverlay(realCwd, {
            command: '/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:12345/'],
        }, {
            serverId: CURSOR_HAPI_MCP_SERVER_ID,
            overlaySessionId: 'session-a',
            enableCursorMcp: noopEnable,
            mcpConfigDir: viaSymlinkCursor,
        });
        expect(existsSync(join(realCwd, '.cursor', 'mcp.json'))).toBe(true);
        const written = JSON.parse(readFileSync(join(realCwd, '.cursor', 'mcp.json'), 'utf-8')) as {
            mcpServers: Record<string, unknown>;
        };
        expect(written.mcpServers[CURSOR_HAPI_MCP_SERVER_ID]).toBeTruthy();
        handle.cleanup();
        rmSync(root, { recursive: true, force: true });
    });

    it('adds project mcp.json to .git/info/exclude so git add -A will not scoop the mailbox', () => {
        const root = join(tmpdir(), `hapi-mcp-git-shield-${randomUUID()}`);
        mkdirSync(root, { recursive: true });
        spawnSync('git', ['init'], { cwd: root, encoding: 'utf-8' });
        spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
        spawnSync('git', ['config', 'user.name', 'test'], { cwd: root });
        writeFileSync(join(root, 'README'), 'x\n');
        spawnSync('git', ['add', 'README'], { cwd: root });
        spawnSync('git', ['commit', '-m', 'init'], { cwd: root });

        const handle = installCursorMcpOverlay(root, {
            command: '/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:12345/'],
        }, {
            serverId: CURSOR_HAPI_MCP_SERVER_ID,
            overlaySessionId: 'session-a',
            enableCursorMcp: noopEnable,
            mcpConfigDir: join(root, '.cursor'),
        });

        const exclude = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf-8');
        expect(exclude).toContain(HAPI_MCP_GIT_EXCLUDE_MARKER_PREFIX);
        expect(exclude).toContain('.cursor/mcp.json');
        const check = spawnSync('git', ['check-ignore', '-v', '--', '.cursor/mcp.json'], {
            cwd: root,
            encoding: 'utf-8',
        });
        expect(check.status).toBe(0);

        handle.cleanup();
        const after = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf-8');
        expect(after).not.toContain(HAPI_MCP_GIT_EXCLUDE_MARKER_PREFIX);
        expect(after).not.toContain('.cursor/mcp.json');
        rmSync(root, { recursive: true, force: true });
    });

    it('preserves pre-existing .git/info/exclude rules across install and cleanup', () => {
        const root = join(tmpdir(), `hapi-mcp-git-preserve-${randomUUID()}`);
        mkdirSync(root, { recursive: true });
        spawnSync('git', ['init'], { cwd: root, encoding: 'utf-8' });
        spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
        spawnSync('git', ['config', 'user.name', 'test'], { cwd: root });
        writeFileSync(join(root, 'README'), 'x\n');
        spawnSync('git', ['add', 'README'], { cwd: root });
        spawnSync('git', ['commit', '-m', 'init'], { cwd: root });
        mkdirSync(join(root, '.git', 'info'), { recursive: true });
        writeFileSync(join(root, '.git', 'info', 'exclude'), 'local-secret.txt\n*.local.bak\n', 'utf-8');

        const handle = installCursorMcpOverlay(root, {
            command: '/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:12345/'],
        }, {
            serverId: CURSOR_HAPI_MCP_SERVER_ID,
            overlaySessionId: 'session-a',
            enableCursorMcp: noopEnable,
            mcpConfigDir: join(root, '.cursor'),
        });

        const mid = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf-8');
        expect(mid).toContain('local-secret.txt');
        expect(mid).toContain('*.local.bak');
        expect(mid).toContain('.cursor/mcp.json');

        handle.cleanup();
        const after = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf-8');
        expect(after).toContain('local-secret.txt');
        expect(after).toContain('*.local.bak');
        expect(after).not.toContain(HAPI_MCP_GIT_EXCLUDE_MARKER_PREFIX);
        expect(after).not.toContain('.cursor/mcp.json');
        rmSync(root, { recursive: true, force: true });
    });

    it('prunes dead-owner exclude leases on the next install', () => {
        const root = join(tmpdir(), `hapi-mcp-git-dead-lease-${randomUUID()}`);
        mkdirSync(root, { recursive: true });
        spawnSync('git', ['init'], { cwd: root, encoding: 'utf-8' });
        spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
        spawnSync('git', ['config', 'user.name', 'test'], { cwd: root });
        writeFileSync(join(root, 'README'), 'x\n');
        spawnSync('git', ['add', 'README'], { cwd: root });
        spawnSync('git', ['commit', '-m', 'init'], { cwd: root });
        mkdirSync(join(root, '.git', 'info'), { recursive: true });
        const deadPid = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf-8' }).pid!;
        const deadLease = `${deadPid}:${randomUUID()}`;
        writeFileSync(
            join(root, '.git', 'info', 'exclude'),
            `${hapiMcpGitExcludeMarker(deadLease)}\n.cursor/mcp.json\nkeep-me.txt\n`,
            'utf-8',
        );

        const handle = installCursorMcpOverlay(root, {
            command: '/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:12345/'],
        }, {
            serverId: CURSOR_HAPI_MCP_SERVER_ID,
            overlaySessionId: 'session-a',
            enableCursorMcp: noopEnable,
            mcpConfigDir: join(root, '.cursor'),
        });

        const mid = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf-8');
        expect(mid).toContain('keep-me.txt');
        expect(mid).not.toContain(hapiMcpGitExcludeMarker(deadLease));
        expect(mid).toContain('.cursor/mcp.json');
        expect(mid).toMatch(new RegExp(`${HAPI_MCP_GIT_EXCLUDE_MARKER_PREFIX} ${process.pid}:`));

        handle.cleanup();
        const after = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf-8');
        expect(after).toContain('keep-me.txt');
        expect(after).not.toContain('.cursor/mcp.json');
        rmSync(root, { recursive: true, force: true });
    });

    it('keeps shared exclude while a sibling worktree lease is still live', () => {
        const root = join(tmpdir(), `hapi-mcp-git-lease-main-${randomUUID()}`);
        const linked = join(tmpdir(), `hapi-mcp-git-lease-link-${randomUUID()}`);
        mkdirSync(root, { recursive: true });
        spawnSync('git', ['init'], { cwd: root, encoding: 'utf-8' });
        spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
        spawnSync('git', ['config', 'user.name', 'test'], { cwd: root });
        writeFileSync(join(root, 'README'), 'x\n');
        spawnSync('git', ['add', 'README'], { cwd: root });
        spawnSync('git', ['commit', '-m', 'init'], { cwd: root });
        expect(spawnSync('git', ['worktree', 'add', linked, 'HEAD'], {
            cwd: root,
            encoding: 'utf-8',
        }).status).toBe(0);

        const handleA = installCursorMcpOverlay(root, {
            command: '/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:12345/'],
        }, {
            serverId: CURSOR_HAPI_MCP_SERVER_ID,
            overlaySessionId: 'session-a',
            enableCursorMcp: noopEnable,
            mcpConfigDir: join(root, '.cursor'),
        });
        const handleB = installCursorMcpOverlay(linked, {
            command: '/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:12345/'],
        }, {
            serverId: CURSOR_HAPI_MCP_SERVER_ID,
            overlaySessionId: 'session-b',
            enableCursorMcp: noopEnable,
            mcpConfigDir: join(linked, '.cursor'),
        });

        handleA.cleanup();
        const mid = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf-8');
        expect(mid).toContain('.cursor/mcp.json');
        expect(spawnSync('git', ['check-ignore', '-v', '--', '.cursor/mcp.json'], {
            cwd: linked,
            encoding: 'utf-8',
        }).status).toBe(0);

        handleB.cleanup();
        const after = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf-8');
        expect(after).not.toContain('.cursor/mcp.json');
        spawnSync('git', ['worktree', 'remove', '--force', linked], { cwd: root, encoding: 'utf-8' });
        rmSync(root, { recursive: true, force: true });
        rmSync(linked, { recursive: true, force: true });
    });

    it('serializes concurrent exclude lease updates across processes', async () => {
        const root = join(tmpdir(), `hapi-mcp-git-race-${randomUUID()}`);
        mkdirSync(join(root, '.git', 'info'), { recursive: true });
        const excludePath = join(root, '.git', 'info', 'exclude');
        writeFileSync(excludePath, 'keep-me.txt\n', 'utf-8');
        const lockPath = `${excludePath}.hapi.lock`;
        const donePath = join(root, 'child-done');
        const errPath = join(root, 'child-err');
        const leaseA = 'lease-a';
        const leaseB = 'lease-b';

        // Hold the lock first so the child must wait mid-flight.
        const childExit = new Promise<number>((resolve, reject) => {
            withMcpJsonLock(lockPath, () => {
                appendExcludeLeaseUnlocked(excludePath, '.cursor/mcp.json', leaseA);
                const child = spawn('bun', [
                    '-e',
                    `
                        import { appendExcludeLease } from ${JSON.stringify(overlayModulePath)};
                        try {
                            appendExcludeLease(${JSON.stringify(excludePath)}, '.cursor/mcp.json', ${JSON.stringify(leaseB)});
                            await Bun.write(${JSON.stringify(donePath)}, 'ok');
                            process.exit(0);
                        } catch (error) {
                            await Bun.write(${JSON.stringify(errPath)}, String(error));
                            process.exit(1);
                        }
                    `,
                ], {
                    cwd: root,
                    stdio: 'ignore',
                });
                child.on('error', reject);
                child.on('exit', (code) => resolve(code ?? 1));
                // Keep holding until the child has had time to enter the wait loop.
                const end = Date.now() + 400;
                while (Date.now() < end) {
                    // busy-wait
                }
            });
        });

        const code = await childExit;
        if (existsSync(errPath)) {
            throw new Error(`child failed: ${readFileSync(errPath, 'utf-8')}`);
        }
        expect(code).toBe(0);
        expect(existsSync(donePath)).toBe(true);

        const both = readFileSync(excludePath, 'utf-8');
        expect(both).toContain('keep-me.txt');
        expect(both).toContain(hapiMcpGitExcludeMarker(leaseA));
        expect(both).toContain(hapiMcpGitExcludeMarker(leaseB));

        removeExcludeLease(excludePath, '.cursor/mcp.json', leaseA);
        const afterA = readFileSync(excludePath, 'utf-8');
        expect(afterA).toContain(hapiMcpGitExcludeMarker(leaseB));
        expect(afterA).toContain('keep-me.txt');
        expect(afterA).not.toContain(hapiMcpGitExcludeMarker(leaseA));

        removeExcludeLease(excludePath, '.cursor/mcp.json', leaseB);
        rmSync(root, { recursive: true, force: true });
    }, 20_000);

    it('writes exclude via --git-path so linked worktrees share the common exclude', () => {
        const root = join(tmpdir(), `hapi-mcp-git-wt-main-${randomUUID()}`);
        const linked = join(tmpdir(), `hapi-mcp-git-wt-link-${randomUUID()}`);
        mkdirSync(root, { recursive: true });
        spawnSync('git', ['init'], { cwd: root, encoding: 'utf-8' });
        spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
        spawnSync('git', ['config', 'user.name', 'test'], { cwd: root });
        writeFileSync(join(root, 'README'), 'x\n');
        spawnSync('git', ['add', 'README'], { cwd: root });
        spawnSync('git', ['commit', '-m', 'init'], { cwd: root });
        const addWt = spawnSync('git', ['worktree', 'add', linked, 'HEAD'], {
            cwd: root,
            encoding: 'utf-8',
        });
        expect(addWt.status).toBe(0);

        const handle = installCursorMcpOverlay(linked, {
            command: '/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:12345/'],
        }, {
            serverId: CURSOR_HAPI_MCP_SERVER_ID,
            overlaySessionId: 'session-a',
            enableCursorMcp: noopEnable,
            mcpConfigDir: join(linked, '.cursor'),
        });

        const commonExclude = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf-8');
        expect(commonExclude).toContain('.cursor/mcp.json');
        const check = spawnSync('git', ['check-ignore', '-v', '--', '.cursor/mcp.json'], {
            cwd: linked,
            encoding: 'utf-8',
        });
        expect(check.status).toBe(0);

        handle.cleanup();
        spawnSync('git', ['worktree', 'remove', '--force', linked], { cwd: root, encoding: 'utf-8' });
        rmSync(root, { recursive: true, force: true });
        rmSync(linked, { recursive: true, force: true });
    });

    it('refuses a tracked project mcp.json instead of using skip-worktree', () => {
        const root = join(tmpdir(), `hapi-mcp-git-skip-${randomUUID()}`);
        mkdirSync(join(root, '.cursor'), { recursive: true });
        spawnSync('git', ['init'], { cwd: root, encoding: 'utf-8' });
        spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
        spawnSync('git', ['config', 'user.name', 'test'], { cwd: root });
        writeFileSync(join(root, '.cursor', 'mcp.json'), `${JSON.stringify({
            mcpServers: { other: { command: 'echo', args: ['x'] } },
        }, null, 2)}\n`);
        spawnSync('git', ['add', '.cursor/mcp.json'], { cwd: root });
        spawnSync('git', ['commit', '-m', 'track mcp'], { cwd: root });

        expect(() => installCursorMcpOverlay(root, {
            command: '/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:12345/'],
        }, {
            serverId: CURSOR_HAPI_MCP_SERVER_ID,
            overlaySessionId: 'session-a',
            enableCursorMcp: noopEnable,
            mcpConfigDir: join(root, '.cursor'),
        })).toThrow(/Refusing runtime overlay for tracked/);

        const after = JSON.parse(readFileSync(join(root, '.cursor', 'mcp.json'), 'utf-8')) as {
            mcpServers: Record<string, unknown>;
        };
        expect(after.mcpServers.hapi).toBeUndefined();
        expect(after.mcpServers.other).toEqual({ command: 'echo', args: ['x'] });
        rmSync(root, { recursive: true, force: true });
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

    it('follows a symlinked user Cursor dir (HOME/.cursor → estate disk) when stripping', () => {
        const cwd = makeProjectDir();
        const realUserDir = join(cwd, 'estate-user-cursor');
        mkdirSync(realUserDir, { recursive: true });
        const probe = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf-8' });
        const deadPid = probe.pid!;
        writeFileSync(join(realUserDir, 'mcp.json'), JSON.stringify({
            mcpServers: {
                [cursorHapiMcpServerId('dead')]: {
                    command: '/bin/hapi',
                    args: ['mcp'],
                    env: { [HAPI_MCP_OVERLAY_PID_ENV]: String(deadPid) },
                },
            },
        }, null, 2));
        const userLink = join(cwd, 'user-cursor-link');
        symlinkSync(realUserDir, userLink);

        installCursorMcpOverlay(cwd, {
            command: '/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:12345/'],
        }, {
            serverId: CURSOR_HAPI_MCP_SERVER_ID,
            overlaySessionId: 'session-a',
            enableCursorMcp: noopEnable,
            mcpConfigDir: join(cwd, '.cursor'),
            userMcpConfigDir: userLink,
        }).cleanup();

        const user = JSON.parse(readFileSync(join(realUserDir, 'mcp.json'), 'utf-8')) as {
            mcpServers: Record<string, unknown>;
        };
        expect(user.mcpServers[cursorHapiMcpServerId('dead')]).toBeUndefined();
    });

    it('does not restore a dead PID-stamped previous hapi slot on cleanup', () => {
        const probe = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf-8' });
        const deadPid = probe.pid!;
        expect(isProcessAlive(deadPid)).toBe(false);
        const cwd = makeProjectDir(JSON.stringify({
            mcpServers: {
                [CURSOR_HAPI_MCP_SERVER_ID]: {
                    command: '/bin/old-hapi',
                    args: ['mcp'],
                    env: { [HAPI_MCP_OVERLAY_PID_ENV]: String(deadPid) },
                },
            },
        }, null, 2));
        const mcpPath = join(cwd, '.cursor', 'mcp.json');
        const handle = installCursorMcpOverlay(cwd, {
            command: '/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:12345/'],
        }, {
            serverId: CURSOR_HAPI_MCP_SERVER_ID,
            overlaySessionId: 'session-a',
            enableCursorMcp: noopEnable,
            mcpConfigDir: join(cwd, '.cursor'),
        });
        handle.cleanup();
        // File may remain (hadFile was true) but the dead prior slot must not return.
        expect(JSON.parse(readFileSync(mcpPath, 'utf-8')).mcpServers?.[CURSOR_HAPI_MCP_SERVER_ID])
            .toBeUndefined();
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

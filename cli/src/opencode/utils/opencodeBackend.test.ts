import { beforeEach, describe, expect, it, vi } from 'vitest';

const constructorCalls: Array<{ command: string; args?: string[]; env?: Record<string, string> }> = [];
const spawnCalls: Array<{ command: string; args?: string[]; options?: Record<string, unknown> }> = [];

type FakeChild = {
    stdout: { on: (event: string, cb: (chunk: string) => void) => void };
    on: (event: string, cb: (arg?: unknown) => void) => void;
    kill: () => void;
};

let fakeSpawnImpl: ((command: string, args: string[]) => FakeChild) | null = null;

vi.mock('node:child_process', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:child_process')>()),
    spawn: (command: string, args: string[], options?: Record<string, unknown>) => {
        spawnCalls.push({ command, args, options });
        if (!fakeSpawnImpl) {
            throw new Error('spawn not configured');
        }
        return fakeSpawnImpl(command, args);
    }
}));

function makeFakeChild(stdoutText: string, opts?: { error?: Error; noClose?: boolean }): FakeChild {
    const handlers = new Map<string, Array<(arg?: unknown) => void>>();
    const stdoutHandlers = new Map<string, Array<(chunk: string) => void>>();
    const child: FakeChild = {
        stdout: {
            on: (event, cb) => {
                const list = stdoutHandlers.get(event) ?? [];
                list.push(cb);
                stdoutHandlers.set(event, list);
            }
        },
        on: (event, cb) => {
            const list = handlers.get(event) ?? [];
            list.push(cb);
            handlers.set(event, list);
        },
        kill: () => {}
    };
    queueMicrotask(() => {
        for (const cb of stdoutHandlers.get('data') ?? []) cb(stdoutText);
        if (opts?.error) {
            for (const cb of handlers.get('error') ?? []) cb(opts.error);
        } else if (!opts?.noClose) {
            for (const cb of handlers.get('close') ?? []) cb();
        }
    });
    return child;
}

function configureSpawn(stdoutText: string, opts?: { error?: Error }): void {
    fakeSpawnImpl = () => makeFakeChild(stdoutText, opts);
}

vi.mock('@/agent/backends/acp', () => ({
    AcpSdkBackend: vi.fn().mockImplementation(function (
        this: unknown,
        opts: { command: string; args?: string[]; env?: Record<string, string> }
    ) {
        constructorCalls.push(opts);
        return { __opts: opts };
    })
}));

vi.mock('node:fs/promises', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:fs/promises')>()),
    readdir: vi.fn(async () => ['self'])
}));

import { allocateFreePort, createOpencodeBackend, detectOpencodeFlavorVersion, discoverOpencodeV2RestPort, listChildPids, listLoopbackListeners, listLoopbackListenersForPids, parseLsofListeners, parseSsListeners, parseSsPidListeners } from './opencodeBackend';

describe('detectOpencodeFlavorVersion', () => {
    beforeEach(() => {
        spawnCalls.length = 0;
        fakeSpawnImpl = null;
    });

    it('detects v2 from "opencode v2.0.29" stdout', async () => {
        configureSpawn('opencode v2.0.29\n');
        await expect(detectOpencodeFlavorVersion('myopencode')).resolves.toBe('v2');
        expect(spawnCalls).toEqual([{ command: 'myopencode', args: ['--version'], options: expect.objectContaining({ stdio: ['ignore', 'pipe', 'ignore'] }) }]);
    });

    it('detects v1 from "1.19.0" stdout', async () => {
        configureSpawn('1.19.0\n');
        await expect(detectOpencodeFlavorVersion('opencode')).resolves.toBe('v1');
    });

    it('detects v2 from "opencode 2.1.0" stdout without v prefix', async () => {
        configureSpawn('opencode 2.1.0\n');
        await expect(detectOpencodeFlavorVersion('opencode')).resolves.toBe('v2');
    });

    it('falls back to v1 when stdout is empty', async () => {
        configureSpawn('');
        await expect(detectOpencodeFlavorVersion('opencode')).resolves.toBe('v1');
    });

    it('falls back to v1 when spawn errors', async () => {
        configureSpawn('', { error: new Error('spawn failed') });
        await expect(detectOpencodeFlavorVersion('opencode')).resolves.toBe('v1');
    });

    it('spawns through a shell on Windows so .cmd shims resolve', async () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'win32' });
        try {
            configureSpawn('opencode v2.0.29\n');
            await expect(detectOpencodeFlavorVersion('opencode')).resolves.toBe('v2');
        } finally {
            Object.defineProperty(process, 'platform', { value: originalPlatform });
        }
        expect(spawnCalls[spawnCalls.length - 1]?.options).toMatchObject({ shell: true, windowsHide: true });
    });
});

describe('allocateFreePort', () => {
    it('resolves a bindable loopback port number', async () => {
        const port = await allocateFreePort('127.0.0.1');
        expect(typeof port).toBe('number');
        expect(Number.isInteger(port)).toBe(true);
        expect(port).toBeGreaterThan(0);
        expect(port).toBeLessThan(65536);
    });

    it('releases the port so it can be reused by a later caller', async () => {
        // Each call must close its probe socket before resolving, otherwise a
        // consumer that immediately tries to bind the returned port (e.g. the
        // spawned `opencode acp --port <port>` process) would collide with it.
        const first = await allocateFreePort('127.0.0.1');
        const second = await allocateFreePort('127.0.0.1');
        expect(typeof second).toBe('number');
        // Not asserting first !== second (OS may reuse immediately-freed ports),
        // only that a second allocation does not hang or throw EADDRINUSE.
        expect(first).toBeGreaterThan(0);
    });
});

describe('createOpencodeBackend', () => {
    beforeEach(() => {
        constructorCalls.length = 0;
    });

    it('passes --port and --hostname args when provided', () => {
        createOpencodeBackend({ cwd: '/tmp/x', port: 5555, hostname: '127.0.0.1' });
        expect(constructorCalls[0]?.args).toEqual([
            'acp', '--cwd', '/tmp/x', '--port', '5555', '--hostname', '127.0.0.1'
        ]);
    });

    it('omits --port/--hostname when not provided (backward compatible)', () => {
        createOpencodeBackend({ cwd: '/tmp/x' });
        expect(constructorCalls[0]?.args).toEqual(['acp', '--cwd', '/tmp/x']);
    });

    it('v1: keeps existing args even when majorVersion is explicitly v1', () => {
        createOpencodeBackend({ cwd: '/tmp/x', port: 5555, hostname: '127.0.0.1', majorVersion: 'v1' });
        expect(constructorCalls[0]?.args).toEqual([
            'acp', '--cwd', '/tmp/x', '--port', '5555', '--hostname', '127.0.0.1'
        ]);
    });

    it('v2: passes only [acp] args with spawnCwd and config-option model switch', () => {
        createOpencodeBackend({ cwd: '/tmp/x', majorVersion: 'v2' });
        const call = constructorCalls[0] as unknown as {
            args?: string[];
            spawnCwd?: string;
            acpModelSwitchViaConfigOption?: boolean;
        };
        expect(call.args).toEqual(['acp']);
        expect(call.spawnCwd).toBe('/tmp/x');
        expect(call.acpModelSwitchViaConfigOption).toBe(true);
    });

    it('advertises OpenCode child session updates only for v2', () => {
        createOpencodeBackend({ cwd: '/tmp/x', majorVersion: 'v2' });
        createOpencodeBackend({ cwd: '/tmp/x', majorVersion: 'v1' });
        const calls = constructorCalls as unknown as Array<{ childSessionUpdates?: boolean }>;
        expect(calls[0]?.childSessionUpdates).toBe(true);
        expect(calls[1]?.childSessionUpdates).toBeUndefined();
    });

    it('v2: defaults spawnCwd to the invoked cwd when opts.cwd is absent', () => {
        createOpencodeBackend({ majorVersion: 'v2' });
        const call = constructorCalls[0] as unknown as { spawnCwd?: string };
        expect(typeof call.spawnCwd).toBe('string');
        expect(call.spawnCwd?.length).toBeGreaterThan(0);
    });
});

describe('parseSsListeners', () => {
    it('extracts only 127.0.0.1 LISTEN ports from ss -tln output', () => {
        const output = [
            'State   Recv-Q  Send-Q   Local Address:Port    Peer Address:Port  Process',
            'LISTEN  0       128      127.0.0.1:40941      0.0.0.0:*',
            'LISTEN  0       511          [::1]:40942          [::]:*',
            'LISTEN  0       4096       0.0.0.0:22             0.0.0.0:*',
            'LISTEN  0       128      127.0.0.1:39999      0.0.0.0:*'
        ].join('\n');
        expect(parseSsListeners(output)).toEqual(new Set([40941, 39999]));
    });

    it('returns empty set for output without loopback listeners', () => {
        expect(parseSsListeners('State Recv-Q Send-Q\nLISTEN 0 128 0.0.0.0:22 0.0.0.0:*')).toEqual(new Set());
        expect(parseSsListeners('')).toEqual(new Set());
    });
});

describe('parseLsofListeners', () => {
    it('extracts only 127.0.0.1 LISTEN ports from lsof output', () => {
        const output = [
            'COMMAND   PID  USER   FD   TYPE             DEVICE  SIZE/OFF NODE NAME',
            'node    12345 lupin   24u  IPv4  0x1234567890abcdef      0t0  TCP 127.0.0.1:40941 (LISTEN)',
            'node    12345 lupin   25u  IPv6  0x1234567890abcdee      0t0  TCP [::1]:40942 (LISTEN)',
            'sshd     1000  root    3u   IPv4  0x1234567890abcddf      0t0  TCP *:22 (LISTEN)'
        ].join('\n');
        expect(parseLsofListeners(output)).toEqual(new Set([40941]));
    });

    it('returns empty set for output without loopback listeners', () => {
        expect(parseLsofListeners('COMMAND PID USER\nsshd 1000 root 3u IPv4 *:22 (LISTEN)')).toEqual(new Set());
        expect(parseLsofListeners('')).toEqual(new Set());
    });
});

describe('listLoopbackListeners', () => {
    it('parses ss output on linux', async () => {
        const listeners = await listLoopbackListeners({
            execImpl: async (command, args) => {
                expect(command).toBe('ss');
                expect(args).toEqual(['-tln']);
                return 'LISTEN 0 128 127.0.0.1:41000 0.0.0.0:*';
            }
        });
        expect(listeners).toEqual(new Set([41000]));
    });

    it('falls back to lsof on darwin', async () => {
        const listeners = await listLoopbackListeners({
            platform: 'darwin',
            execImpl: async (command, args) => {
                expect(command).toBe('lsof');
                expect(args).toEqual(['-iTCP', '-sTCP:LISTEN', '-n', '-P']);
                return 'node 1 u 4u IPv4 TCP 127.0.0.1:41001 (LISTEN)';
            }
        });
        expect(listeners).toEqual(new Set([41001]));
    });

    it('returns empty set when both commands fail', async () => {
        const listeners = await listLoopbackListeners({
            execImpl: async () => {
                throw new Error('no ss, no lsof');
            }
        });
        expect(listeners.size).toBe(0);
    });
});

describe('discoverOpencodeV2RestPort', () => {
    it('returns the first port newly bound since the before snapshot', async () => {
        const beforeSnapshot = new Set([1000, 2000]);
        let call = 0;
        const port = await discoverOpencodeV2RestPort({
            beforeSnapshot,
            pollIntervalMs: 1,
            scanImpl: async () => {
                call++;
                return call === 1 ? new Set([1000, 2000]) : new Set([1000, 2000, 41234]);
            }
        });
        expect(port).toBe(41234);
    });

    it('prefers the lowest new port when several appear', async () => {
        const port = await discoverOpencodeV2RestPort({
            beforeSnapshot: new Set(),
            pollIntervalMs: 1,
            scanImpl: async () => new Set([55555, 40000, 47777])
        });
        expect(port).toBe(40000);
    });

    it('returns null on timeout when no new port appears', async () => {
        const port = await discoverOpencodeV2RestPort({
            beforeSnapshot: new Set([1000]),
            timeoutMs: 30,
            pollIntervalMs: 10,
            scanImpl: async () => new Set([1000])
        });
        expect(port).toBeNull();
    });

    it('returns null when scanning always fails', async () => {
        const port = await discoverOpencodeV2RestPort({
            beforeSnapshot: new Set(),
            timeoutMs: 30,
            pollIntervalMs: 10,
            scanImpl: async () => {
                throw new Error('scan failed');
            }
        });
        expect(port).toBeNull();
    });
});
describe('parseSsPidListeners', () => {
    it('extracts 127.0.0.1 ports owned by the given pid from ss -tlnp output', () => {
        const output = [
            'State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process',
            'LISTEN 0      128    127.0.0.1:41234    0.0.0.0:*         users:(("opencode",pid=4242,fd=18))',
            'LISTEN 0      128    127.0.0.1:41999    0.0.0.0:*         users:(("other",pid=999,fd=11))',
            'LISTEN 0      4096   0.0.0.0:22         0.0.0.0:*         users:(("sshd",pid=4242,fd=3))'
        ].join('\n');
        expect(parseSsPidListeners(output, 4242)).toEqual(new Set([41234]));
    });

    it('returns empty set when the pid owns no loopback listener', () => {
        const output = 'LISTEN 0 128 127.0.0.1:41999 0.0.0.0:* users:(("other",pid=999,fd=11))';
        expect(parseSsPidListeners(output, 4242)).toEqual(new Set());
    });
});

describe('listLoopbackListenersForPids', () => {
    it('parses ss -tlnp output filtered by pid on linux', async () => {
        const listeners = await listLoopbackListenersForPids([4242], {
            platform: 'linux',
            execImpl: async (command, args) => {
                expect(command).toBe('ss');
                expect(args).toEqual(['-tlnp']);
                return 'LISTEN 0 128 127.0.0.1:41234 0.0.0.0:* users:(("opencode",pid=4242,fd=18))';
            }
        });
        expect(listeners).toEqual(new Set([41234]));
    });

    it('falls back to lsof -a -p when ss fails', async () => {
        const listeners = await listLoopbackListenersForPids([4242], {
            execImpl: async (command, args) => {
                if (command === 'ss') {
                    throw new Error('ss missing');
                }
                expect(command).toBe('lsof');
                expect(args).toEqual(['-a', '-p', '4242', '-iTCP', '-sTCP:LISTEN', '-n', '-P']);
                return 'node 4242 u 20u IPv4 TCP 127.0.0.1:41235 (LISTEN)';
            }
        });
        expect(listeners).toEqual(new Set([41235]));
    });

    it('throws when ss fails and lsof is missing (caller falls back to the diff heuristic)', async () => {
        await expect(listLoopbackListenersForPids([4242], {
            execImpl: async (command) => {
                if (command === 'lsof') {
                    const err: NodeJS.ErrnoException = new Error('lsof not found');
                    err.code = 'ENOENT';
                    throw err;
                }
                throw new Error('ss failed');
            }
        })).rejects.toThrow();
    });

    it('treats a lsof no-match (non-ENOENT failure) as an empty set so a listening sibling survives', async () => {
        // macOS: no ss; lsof exits 1 when the pid owns no socket. The ACP
        // parent often owns no listener — its failure must not discard the
        // serve child's result.
        const listeners = await listLoopbackListenersForPids([111, 222], {
            execImpl: async (command, args) => {
                if (command === 'ss') throw new Error('ss missing');
                expect(args).toEqual(['-a', '-p', expect.any(String), '-iTCP', '-sTCP:LISTEN', '-n', '-P']);
                // Decisive: pid 111's scan must never contribute a port, so
                // the pre-fix Promise.all rejection path (discarding pid 222's
                // result and falling back to the diff heuristic) and any
                // misattribution both fail this assertion.
                if (args[2] === '111') throw new Error('lsof exited 1: no match');
                if (args[2] === '222') return 'node 222 u 20u IPv4 TCP 127.0.0.1:41236 (LISTEN)';
                throw new Error('unexpected lsof invocation');
            }
        });
        expect(listeners).toEqual(new Set([41236]));
    });
});

describe('discoverOpencodeV2RestPort ownerPid preference', () => {
    it('prefers a post-snapshot owned port over a pre-existing one owned by the same tree', async () => {
        const port = await discoverOpencodeV2RestPort({
            beforeSnapshot: new Set([41234]),
            pollIntervalMs: 1,
            ownerPids: [4242],
            scanImpl: async () => new Set([41234, 40000, 47777]),
            scanOwnedImpl: async () => new Set([41234, 47777])
        });
        expect(port).toBe(47777);
    });

    it('returns the pid-owned port even when it was already in the before snapshot', async () => {
        const port = await discoverOpencodeV2RestPort({
            beforeSnapshot: new Set([41234]),
            pollIntervalMs: 1,
            ownerPid: 4242,
            scanImpl: async () => new Set(),
            scanOwnedImpl: async () => new Set([41234])
        });
        expect(port).toBe(41234);
    });

    it('falls back to the diff heuristic when the owned scan fails', async () => {
        const port = await discoverOpencodeV2RestPort({
            beforeSnapshot: new Set([1000]),
            pollIntervalMs: 1,
            ownerPid: 4242,
            scanImpl: async () => new Set([1000, 41999]),
            scanOwnedImpl: async () => {
                throw new Error('tools missing');
            }
        });
        expect(port).toBe(41999);
    });

    it('keeps polling the owned scan and does not fall back while it succeeds but is empty', async () => {
        let ownedCalls = 0;
        let diffCalls = 0;
        const port = await discoverOpencodeV2RestPort({
            beforeSnapshot: new Set([1000]),
            timeoutMs: 60,
            pollIntervalMs: 10,
            ownerPid: 4242,
            scanImpl: async () => {
                diffCalls++;
                return new Set([1000, 55555]);
            },
            scanOwnedImpl: async () => {
                ownedCalls++;
                return ownedCalls >= 2 ? new Set([47777]) : new Set();
            }
        });
        expect(port).toBe(47777);
        expect(ownedCalls).toBeGreaterThanOrEqual(2);
        expect(diffCalls).toBe(0);
    });
});

describe('listChildPids', () => {
    it('parses NUL/space-separated children from a /proc children fixture', async () => {
        const pids = await listChildPids(4242, {
            platform: 'linux',
            readChildrenFile: async (pid: number, task: string) => {
                expect(pid).toBe(4242);
                expect(typeof task).toBe('string');
                return '2017934\u00002017935 2017936';
            }
        });
        expect(pids).toEqual([2017934, 2017935, 2017936]);
    });

    it('runs pgrep -P on non-linux platforms', async () => {
        const pids = await listChildPids(4242, {
            platform: 'darwin',
            execImpl: async (command, args) => {
                expect(command).toBe('pgrep');
                expect(args).toEqual(['-P', '4242']);
                return '2017934\n2017936\n';
            }
        });
        expect(pids).toEqual([2017934, 2017936]);
    });

    it('returns an empty array when reading fails (linux)', async () => {
        const pids = await listChildPids(4242, {
            platform: 'linux',
            readChildrenFile: async () => {
                throw new Error('ENOENT');
            }
        });
        expect(pids).toEqual([]);
    });

    it('returns an empty array when pgrep fails (darwin)', async () => {
        const pids = await listChildPids(4242, {
            platform: 'darwin',
            execImpl: async () => {
                throw new Error('no such process');
            }
        });
        expect(pids).toEqual([]);
    });
});

describe('discoverOpencodeV2RestPort ownerPids union', () => {
    it('returns the lowest port owned by any of the given pids', async () => {
        const port = await discoverOpencodeV2RestPort({
            beforeSnapshot: new Set(),
            pollIntervalMs: 1,
            ownerPids: [1000, 4242],
            scanImpl: async () => new Set(),
            scanOwnedImpl: async (pids) => {
                expect(pids).toEqual([1000, 4242]);
                return new Set([47777, 34019]);
            }
        });
        expect(port).toBe(34019);
    });

    it('falls back to the diff heuristic when the owned scan fails', async () => {
        const port = await discoverOpencodeV2RestPort({
            beforeSnapshot: new Set([1000]),
            pollIntervalMs: 1,
            ownerPids: [4242],
            scanImpl: async () => new Set([1000, 41999]),
            scanOwnedImpl: async () => {
                throw new Error('tools missing');
            }
        });
        expect(port).toBe(41999);
    });

    it('keeps polling when the owned scan succeeds but is empty', async () => {
        let ownedCalls = 0;
        let diffCalls = 0;
        const port = await discoverOpencodeV2RestPort({
            beforeSnapshot: new Set([1000]),
            timeoutMs: 60,
            pollIntervalMs: 10,
            ownerPids: [4242],
            scanImpl: async () => {
                diffCalls++;
                return new Set([1000, 55555]);
            },
            scanOwnedImpl: async () => {
                ownedCalls++;
                return ownedCalls >= 2 ? new Set([47777]) : new Set();
            }
        });
        expect(port).toBe(47777);
        expect(ownedCalls).toBeGreaterThanOrEqual(2);
        expect(diffCalls).toBe(0);
    });
});

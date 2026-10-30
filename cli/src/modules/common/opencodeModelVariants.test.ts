import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { extractOpencodeAcpPorts, extractOpencodeAcpServers, parseOpencodeProviderVariants, listOpencodeModelVariants } from './opencodeModelVariants'

describe('parseOpencodeProviderVariants', () => {
    it('collects variants for models that have at least one variant keyed by providerID/modelId', () => {
        const payload = {
            all: [
                {
                    id: 'opencode-go',
                    models: {
                        'ox-alpha-free': {
                            id: 'ox-alpha-free',
                            providerID: 'opencode-go',
                            variants: { low: {}, high: {}, max: {} }
                        },
                        'bare-model': {
                            id: 'bare-model',
                            providerID: 'opencode-go'
                        }
                    }
                },
                {
                    id: 'other',
                    models: {
                        'muse-spark': {
                            id: 'muse-spark',
                            providerID: 'other',
                            variants: { minimal: null }
                        }
                    }
                }
            ]
        }

        expect(parseOpencodeProviderVariants(payload)).toEqual({
            'opencode-go/ox-alpha-free': ['low', 'high', 'max'],
            'other/muse-spark': ['minimal']
        })
    })

    it('skips models with empty or invalid variant maps and malformed entries', () => {
        const payload = {
            all: [
                {
                    id: 'p1',
                    models: {
                        'no-variants': { id: 'no-variants', providerID: 'p1', variants: {} },
                        'bad-variants': { id: 'bad-variants', providerID: 'p1', variants: 'nope' },
                        'missing-id': { providerID: 'p1', variants: { low: {} } },
                        'missing-provider': { id: 'x', variants: { low: {} } },
                        ok: { id: 'ok', providerID: 'p1', variants: { high: {} } }
                    }
                },
                'not-an-object',
                { noModels: true }
            ]
        }

        expect(parseOpencodeProviderVariants(payload)).toEqual({
            'p1/ok': ['high']
        })
    })

    it('returns an empty map for non-object payloads', () => {
        expect(parseOpencodeProviderVariants(null)).toEqual({})
        expect(parseOpencodeProviderVariants('string')).toEqual({})
        expect(parseOpencodeProviderVariants({})).toEqual({})
        expect(parseOpencodeProviderVariants({ all: 'nope' })).toEqual({})
    })
})

describe('extractOpencodeAcpPorts', () => {
    it('extracts ports from live opencode acp process args', () => {
        const ps = [
            '/home/user/.local/bin/hapi-runner opencode --hapi-starting-mode remote --model opencode-go/ox-alpha-free',
            'opencode acp --cwd /home/user --port 42495 --hostname 127.0.0.1',
            'opencode acp --cwd /tmp --port 38971 --hostname 127.0.0.1',
            'opencode serve --port 46123',
            'bun run hub/src/index.ts'
        ].join('\n');
        expect(extractOpencodeAcpPorts(ps)).toEqual([42495, 38971]);
    });

    it('dedupes and rejects malformed ports', () => {
        const ps = [
            'opencode acp --port 70000',
            'opencode acp --port 42495',
            'opencode acp --port 42495 --hostname 127.0.0.1',
            'opencode acp --cwd /x'
        ].join('\n');
        expect(extractOpencodeAcpPorts(ps)).toEqual([42495]);
    });
});


describe('listOpencodeModelVariants resident lifecycle', () => {
    const providerPayload = {
        all: [{ id: 'p', models: { m: { id: 'm', providerID: 'p', variants: { low: {}, high: {} } } } }]
    };

    function makeProc(argv: string[]) {
        return {
            argv,
            kill: vi.fn(),
            exitCode: null,
            stdout: new ReadableStream<Uint8Array>({ start(c) { c.close(); } })
        };
    }

    let procs: ReturnType<typeof makeProc>[];
    let mod: typeof import('./opencodeModelVariants');

    beforeEach(async () => {
        vi.useFakeTimers();
        vi.resetModules();
        procs = [];
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(providerPayload), { status: 200 })));
        vi.stubGlobal('Bun', {
            spawn: vi.fn((argv: string[], opts?: { cwd?: string }) => {
                const proc = makeProc(argv);
                (proc as unknown as { spawnCwd?: string }).spawnCwd = opts?.cwd;
                if (argv[0] === 'ps') {
                    proc.stdout = new ReadableStream<Uint8Array>({
                        start(c) { c.enqueue(new TextEncoder().encode('')); c.close(); }
                    });
                }
                procs.push(proc);
                return proc;
            })
        });
        mod = await import('./opencodeModelVariants');
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    const serveProcs = () => procs.filter((p) => p.argv[0] === 'opencode');

    it('spawns serve once, keeps it resident, and answers subsequent calls without respawn', async () => {
        const first = mod.listOpencodeModelVariants();
        await vi.advanceTimersByTimeAsync(300);
        const r1 = await first;
        expect(r1.success).toBe(true);
        expect(serveProcs().length).toBe(1);

        await mod.listOpencodeModelVariants();
        await mod.listOpencodeModelVariants();
        expect(serveProcs().length).toBe(1);
    });

    it('reaps the resident serve after the idle timeout and respawns on the next call', async () => {
        const first = mod.listOpencodeModelVariants();
        await vi.advanceTimersByTimeAsync(300);
        await first;
        const initialServe = serveProcs()[0];

        await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
        expect(initialServe.kill).toHaveBeenCalled();

        const second = mod.listOpencodeModelVariants();
        await vi.advanceTimersByTimeAsync(300);
        const r2 = await second;
        expect(r2.success).toBe(true);
        expect(serveProcs().length).toBe(2);
        expect(serveProcs()[1].kill).not.toHaveBeenCalled();
    });

    it('does not reuse a project server when no cwd was requested', async () => {
        // Seed the ps scan with a live acp server in /a, then request with cwd=null.
        vi.stubGlobal('Bun', {
            spawn: vi.fn((argv: string[]) => {
                const proc = makeProc(argv);
                if (argv[0] === 'ps') {
                    proc.stdout = new ReadableStream<Uint8Array>({
                        start(c) {
                            c.enqueue(new TextEncoder().encode('opencode acp --cwd /a --port 42495 --hostname 127.0.0.1'));
                            c.close();
                        }
                    });
                }
                procs.push(proc);
                return proc;
            })
        });
        mod = await import('./opencodeModelVariants');
        const result = mod.listOpencodeModelVariants();
        await vi.advanceTimersByTimeAsync(300);
        const r = await result;
        // The /a server must be skipped; the answer comes from a fresh spawn.
        expect(r.success).toBe(true);
        const liveFetchProc = procs.find((p) => p.argv[0] === 'ps');
        void liveFetchProc;
        expect(serveProcs().length).toBe(1);
    });

    it('kills the resident and respawns when the requested cwd changes', async () => {
        const first = mod.listOpencodeModelVariants({ cwd: '/a' });
        await vi.advanceTimersByTimeAsync(300);
        await first;
        const firstServe = serveProcs()[0];

        const second = mod.listOpencodeModelVariants({ cwd: '/b' });
        await vi.advanceTimersByTimeAsync(300);
        const r2 = await second;
        expect(r2.success).toBe(true);
        expect(firstServe.kill).toHaveBeenCalled();
        const newServe = serveProcs()[1];
        expect(newServe).toBeDefined();
        expect(newServe.kill).not.toHaveBeenCalled();
    });

    it('kills an unresponsive resident before replacing it', async () => {
        const first = mod.listOpencodeModelVariants({ cwd: '/a' });
        await vi.advanceTimersByTimeAsync(300);
        await first;
        const firstServe = serveProcs()[0];

        const fetchMock = vi.mocked(fetch);
        fetchMock.mockRejectedValueOnce(new Error('server unavailable'));
        const second = mod.listOpencodeModelVariants({ cwd: '/a' });
        await vi.advanceTimersByTimeAsync(300);
        await second;

        expect(firstServe.kill).toHaveBeenCalled();
        expect(serveProcs().length).toBe(2);
    });

    it('does not coalesce concurrent calls for different cwds', async () => {
        const first = mod.listOpencodeModelVariants({ cwd: '/a' });
        const second = mod.listOpencodeModelVariants({ cwd: '/b' });
        await vi.advanceTimersByTimeAsync(300);
        const [r1, r2] = await Promise.all([first, second]);
        expect(r1.success).toBe(true);
        expect(r2.success).toBe(true);
        // One serve per cwd — the two requests must not share a catalog.
        expect(serveProcs().length).toBe(2);
        // The loser of the resident slot must not leak: the replaced serve is
        // killed once the second spawn takes over.
        expect(serveProcs()[0].kill).toHaveBeenCalled();
    });

    it('registers an exit hook that kills the resident serve', async () => {
        const exitSpy = vi.spyOn(process, 'on');
        const first = mod.listOpencodeModelVariants();
        await vi.advanceTimersByTimeAsync(300);
        await first;
        const calls = exitSpy.mock.calls as unknown as Array<[string, (...args: unknown[]) => void]>;
        const hook = calls.find(([event]) => event === 'exit')?.[1];
        expect(hook).toBeDefined();
        const residentServe = serveProcs()[0];
        hook?.();
        expect(residentServe.kill).toHaveBeenCalled();
        exitSpy.mockRestore();
    });
});

describe('extractOpencodeAcpServers', () => {
    it('extracts port and cwd pairs', () => {
        const ps = [
            'opencode acp --cwd /home/user --port 42495 --hostname 127.0.0.1',
            'opencode acp --port 38971'
        ].join('\n');
        expect(extractOpencodeAcpServers(ps)).toEqual([
            { port: 42495, cwd: '/home/user' },
            { port: 38971, cwd: null }
        ]);
    });
});

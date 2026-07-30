import { describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
    runLocalRemoteArgs: [] as Array<Record<string, unknown>>,
    localCalls: [] as Array<{ opts: unknown }>,
    remoteCalls: [] as Array<{ opts: unknown }>
}));

vi.mock('@/agent/loopBase', () => ({
    runLocalRemoteSession: vi.fn(async (opts: Record<string, unknown>) => {
        harness.runLocalRemoteArgs.push(opts);
    })
}));

vi.mock('./opencodeLocalLauncher', () => ({
    opencodeLocalLauncher: vi.fn(async (_instance: unknown, opts: unknown) => {
        harness.localCalls.push({ opts });
        return 'exit';
    })
}));

vi.mock('./opencodeRemoteLauncher', () => ({
    opencodeRemoteLauncher: vi.fn(async (_instance: unknown, opts: unknown) => {
        harness.remoteCalls.push({ opts });
        return 'exit';
    })
}));

// loop.ts constructs a real OpencodeSession internally (not injectable) —
// mock it so this test exercises only opencodeLoop's own glue logic (option
// forwarding + the compact-availability reset below), not the full
// AgentSessionBase construction contract.
vi.mock('./session', () => ({
    OpencodeSession: vi.fn().mockImplementation(function (this: { onSessionFound: () => void }) {
        this.onSessionFound = vi.fn();
    })
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        getLogPath: () => '/tmp/hapi-loop-test.log'
    }
}));

import { opencodeLoop } from './loop';

function baseOpts(overrides: Record<string, unknown> = {}) {
    return {
        path: '/tmp/hapi-loop-test',
        messageQueue: {} as never,
        session: { rpcHandlerManager: {} } as never,
        api: {} as never,
        onModeChange: vi.fn(),
        hookServer: { port: 1234, stop: vi.fn() } as never,
        hookUrl: 'http://127.0.0.1:1234/hook/opencode',
        ...overrides
    };
}

describe('opencodeLoop compact availability wiring', () => {
    it('resets compact availability to false right before every local-mode entry', async () => {
        const events: boolean[] = [];

        await opencodeLoop(baseOpts({
            startingMode: 'local',
            onCompactAvailabilityChange: (available: boolean) => events.push(available)
        }) as Parameters<typeof opencodeLoop>[0]);

        const opts = harness.runLocalRemoteArgs[0] as { runLocal: (instance: unknown) => Promise<unknown> };
        expect(opts.runLocal).toBeDefined();

        await opts.runLocal({});

        // The reset must happen before opencodeLocalLauncher runs (not after)
        // — this is what actually protects against a stale "available" flag
        // surviving a remote->local handoff, since opencodeLocalLauncher
        // itself never touches compact availability.
        expect(events).toEqual([false]);
        expect(harness.localCalls.length).toBe(1);
    });

    it('forwards onCompactAvailabilityChange unchanged to the remote launcher', async () => {
        const onCompactAvailabilityChange = vi.fn();

        await opencodeLoop(baseOpts({
            startingMode: 'remote',
            onCompactAvailabilityChange
        }) as Parameters<typeof opencodeLoop>[0]);

        const opts = harness.runLocalRemoteArgs.at(-1) as { runRemote: (instance: unknown) => Promise<unknown> };
        await opts.runRemote({});

        expect(harness.remoteCalls.length).toBe(1);
        const remoteOpts = harness.remoteCalls[0]?.opts as { onCompactAvailabilityChange?: unknown };
        expect(remoteOpts.onCompactAvailabilityChange).toBe(onCompactAvailabilityChange);
    });

    it('resets compact availability again on a second local entry (simulating a remote->local->remote->local handoff)', async () => {
        const events: boolean[] = [];

        await opencodeLoop(baseOpts({
            startingMode: 'local',
            onCompactAvailabilityChange: (available: boolean) => events.push(available)
        }) as Parameters<typeof opencodeLoop>[0]);

        const opts = harness.runLocalRemoteArgs.at(-1) as { runLocal: (instance: unknown) => Promise<unknown> };
        await opts.runLocal({});
        await opts.runLocal({});

        expect(events).toEqual([false, false]);
    });
});

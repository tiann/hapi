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
    // Resetting availability to false used to be loop.ts's job, done here in
    // runLocal right before every local-mode entry. That left a window
    // between "a switch/exit was requested" and "runLocal actually ran"
    // where availability was still stale-true — a PR-review round found a
    // /compact slash command arriving in that window could still queue and
    // (via local mode bouncing straight back to remote to drain a non-empty
    // queue) end up running despite the user having already asked to leave
    // remote mode. The reset now happens as early as possible on the
    // *leaving-remote* side instead (OpencodeRemoteLauncher's
    // onLeavingRemote() override, called from RemoteLauncherBase's
    // requestExit()/start()) — see opencodeRemoteLauncher.test.ts's
    // "flips /compact availability to false synchronously..." test for that
    // half of the contract. runLocal here must NOT also reset it: by the
    // time runLocal ever runs, the prior remote launcher's promise (and
    // therefore its onLeavingRemote() call) has already resolved.
    it('does not call onCompactAvailabilityChange from runLocal — availability is already false by the time runLocal runs, reset earlier by the remote launcher leaving', async () => {
        const events: boolean[] = [];

        await opencodeLoop(baseOpts({
            startingMode: 'local',
            onCompactAvailabilityChange: (available: boolean) => events.push(available)
        }) as Parameters<typeof opencodeLoop>[0]);

        const opts = harness.runLocalRemoteArgs[0] as { runLocal: (instance: unknown) => Promise<unknown> };
        expect(opts.runLocal).toBeDefined();

        await opts.runLocal({});

        expect(events).toEqual([]);
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
});

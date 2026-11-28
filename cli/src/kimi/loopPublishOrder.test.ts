import { describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
    runLocalRemoteArgs: [] as Array<Record<string, unknown>>
}));

vi.mock('@/agent/loopBase', () => ({
    runLocalRemoteSession: vi.fn(async (opts: Record<string, unknown>) => {
        harness.runLocalRemoteArgs.push(opts);
    })
}));

vi.mock('./kimiLocalLauncher', () => ({
    kimiLocalLauncher: vi.fn(async () => 'exit')
}));

vi.mock('./kimiRemoteLauncher', () => ({
    kimiRemoteLauncher: vi.fn(async () => 'exit')
}));

vi.mock('./session', () => ({
    KimiSession: vi.fn().mockImplementation(function (this: {
        sessionId: string | null;
        onSessionFound: ReturnType<typeof vi.fn>;
    }, opts: { sessionId?: string | null }) {
        this.sessionId = opts.sessionId ?? null;
        this.onSessionFound = vi.fn((id: string) => { this.sessionId = id });
    })
}));

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn(), getLogPath: () => '/tmp/hapi-kimi-loop-test.log' }
}));

import { kimiLoop } from './loop';

function baseOpts(overrides: Record<string, unknown> = {}) {
    return {
        path: '/tmp/hapi-kimi-loop-test',
        messageQueue: {} as never,
        session: {} as never,
        api: {} as never,
        onModeChange: vi.fn(),
        ...overrides
    };
}

describe('kimiLoop resume id publish order', () => {
    it.each(['local', 'remote'] as const)(
        'keeps the requested id in launcher state without publishing it before a %s launch',
        async (startingMode) => {
            harness.runLocalRemoteArgs.length = 0;
            await kimiLoop(baseOpts({ startingMode, resumeSessionId: 'kimi-requested-1' }) as Parameters<typeof kimiLoop>[0]);

            const runOpts = harness.runLocalRemoteArgs.at(-1) as {
                session: { sessionId: string | null; onSessionFound: ReturnType<typeof vi.fn> };
            };
            expect(runOpts.session.sessionId).toBe('kimi-requested-1');
            expect(runOpts.session.onSessionFound).not.toHaveBeenCalled();
        }
    );
});

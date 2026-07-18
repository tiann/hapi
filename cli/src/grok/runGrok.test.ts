import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
    startupOrder: [] as string[],
    reportStartedToRunner: vi.fn<() => Promise<void>>(),
    grokLoop: vi.fn<() => Promise<void>>(),
    cleanupAndExit: vi.fn(async () => {}),
    session: {
        onUserMessage: vi.fn(),
        rpcHandlerManager: {
            registerHandler: vi.fn()
        }
    }
}));

vi.mock('@/agent/sessionFactory', () => ({
    bootstrapSession: vi.fn(async () => ({
        api: {},
        session: harness.session,
        sessionInfo: { id: 'test-grok-session' },
        reportStartedToRunner: harness.reportStartedToRunner
    }))
}));

vi.mock('./loop', () => ({
    grokLoop: vi.fn(async () => {
        harness.startupOrder.push('loop');
        await harness.grokLoop();
    })
}));

vi.mock('@/agent/runnerLifecycle', () => ({
    createModeChangeHandler: vi.fn(() => vi.fn()),
    createRunnerLifecycle: vi.fn(() => ({
        registerProcessHandlers: vi.fn(() => { harness.startupOrder.push('handlers'); }),
        cleanupAndExit: harness.cleanupAndExit,
        markCrash: vi.fn(),
        setExitCode: vi.fn(),
        setArchiveReason: vi.fn()
    })),
    setControlledByUser: vi.fn()
}));

vi.mock('@/claude/registerKillSessionHandler', () => ({
    registerKillSessionHandler: vi.fn()
}));

vi.mock('@/agent/sessionEnvironment', () => ({
    applyHapiSessionEnvironment: vi.fn()
}));

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn() }
}));

vi.mock('@/utils/invokedCwd', () => ({
    getInvokedCwd: vi.fn(() => '/tmp/project')
}));

vi.mock('@/utils/attachmentFormatter', () => ({
    formatMessageWithAttachments: vi.fn((text: string) => text)
}));

import { runGrok } from './runGrok';

describe('runGrok managed startup', () => {
    beforeEach(() => {
        harness.startupOrder.length = 0;
        harness.reportStartedToRunner.mockReset();
        harness.reportStartedToRunner.mockImplementation(async () => {
            harness.startupOrder.push('reported');
        });
        harness.grokLoop.mockReset();
        harness.grokLoop.mockResolvedValue(undefined);
        harness.cleanupAndExit.mockClear();
        harness.session.onUserMessage.mockReset();
        harness.session.rpcHandlerManager.registerHandler.mockReset();
    });

    it('reports exactly once after lifecycle handlers and before the provider loop', async () => {
        await runGrok({ startedBy: 'runner' });

        expect(harness.reportStartedToRunner).toHaveBeenCalledTimes(1);
        expect(harness.startupOrder).toEqual(['handlers', 'reported', 'loop']);
    });

    it('does not start the provider loop when managed registration is exhausted', async () => {
        harness.reportStartedToRunner.mockRejectedValueOnce(new Error('runner registration exhausted'));

        await expect(runGrok({ startedBy: 'runner' })).rejects.toThrow('runner registration exhausted');
        expect(harness.grokLoop).not.toHaveBeenCalled();
    });
});

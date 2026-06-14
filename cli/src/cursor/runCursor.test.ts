import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCursorSession = vi.hoisted(() => ({
    setPermissionMode: vi.fn(),
    setModel: vi.fn(),
    pushKeepAlive: vi.fn(),
    stopKeepAlive: vi.fn(),
    canApplyModelConfig: vi.fn(() => false)
}));

const harness = vi.hoisted(() => ({
    bootstrapArgs: [] as Array<Record<string, unknown>>,
    loopArgs: [] as Array<Record<string, unknown>>,
    loopError: null as Error | null,
    session: {
        onUserMessage: vi.fn(),
        onCancelQueuedMessage: vi.fn(),
        sendSessionEvent: vi.fn(),
        rpcHandlerManager: {
            registerHandler: vi.fn()
        }
    },
    metadata: { sessionId: 'cursor-session-1' }
}));

vi.mock('@/agent/sessionFactory', () => ({
    bootstrapSession: vi.fn(async (options: Record<string, unknown>) => {
        harness.bootstrapArgs.push(options);
        return {
            api: {},
            session: harness.session,
            metadata: harness.metadata
        };
    }),
    bootstrapExistingSession: vi.fn(async (options: Record<string, unknown>) => {
        harness.bootstrapArgs.push(options);
        return {
            api: {},
            session: harness.session,
            metadata: harness.metadata
        };
    })
}));

vi.mock('./loop', () => ({
    loop: vi.fn(async (options: Record<string, unknown>) => {
        harness.loopArgs.push(options);
        if (harness.loopError) {
            throw harness.loopError;
        }
        const onSessionReady = options.onSessionReady as ((session: unknown) => void) | undefined;
        onSessionReady?.(mockCursorSession);
    })
}));

vi.mock('@/claude/registerKillSessionHandler', () => ({
    registerKillSessionHandler: vi.fn()
}));

const lifecycleMock = vi.hoisted(() => ({
    registerProcessHandlers: vi.fn(),
    cleanupAndExit: vi.fn(async () => {}),
    markCrash: vi.fn(),
    setExitCode: vi.fn(),
    setArchiveReason: vi.fn(),
    setSessionEndReason: vi.fn()
}));

vi.mock('@/agent/runnerLifecycle', () => ({
    createModeChangeHandler: vi.fn(() => vi.fn()),
    createRunnerLifecycle: vi.fn(() => lifecycleMock),
    setControlledByUser: vi.fn()
}));

vi.mock('@/agent/localHandoff', () => ({
    registerLocalHandoffHandler: vi.fn()
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn()
    }
}));

vi.mock('@/utils/attachmentFormatter', () => ({
    formatMessageWithAttachments: vi.fn((text: string) => text)
}));

import { runCursor } from './runCursor';

describe('runCursor', () => {
    beforeEach(() => {
        harness.bootstrapArgs.length = 0;
        harness.loopArgs.length = 0;
        harness.loopError = null;
        harness.session.onUserMessage.mockReset();
        harness.session.onCancelQueuedMessage.mockReset();
        harness.session.sendSessionEvent.mockReset();
        harness.session.rpcHandlerManager.registerHandler.mockReset();
        lifecycleMock.registerProcessHandlers.mockClear();
        lifecycleMock.cleanupAndExit.mockClear();
        lifecycleMock.markCrash.mockClear();
        lifecycleMock.setExitCode.mockClear();
        lifecycleMock.setArchiveReason.mockClear();
        lifecycleMock.setSessionEndReason.mockClear();
    });

    it('surfaces loop-level ACP failures to the web UI before archiving', async () => {
        harness.loopError = new Error('WritableIterable is closed');

        await runCursor({ startedBy: 'runner' });

        expect(harness.session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Cursor Agent failed: WritableIterable is closed'
        });
        expect(lifecycleMock.markCrash).toHaveBeenCalledWith(harness.loopError);
        expect(lifecycleMock.setSessionEndReason).not.toHaveBeenCalledWith('completed');
        expect(lifecycleMock.cleanupAndExit).toHaveBeenCalled();
    });
});

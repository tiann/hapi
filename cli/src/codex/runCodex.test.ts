import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockCodexSessionState = {
    model: string | null | undefined;
    modelReasoningEffort: string | null | undefined;
    serviceTier: string | null | undefined;
    permissionMode: string | undefined;
    collaborationMode: string | undefined;
};

const mockCodexSession = vi.hoisted(() => {
    const state: MockCodexSessionState = {
        model: undefined,
        modelReasoningEffort: null,
        serviceTier: undefined,
        permissionMode: undefined,
        collaborationMode: undefined
    };

    return {
        state,
        getModel: vi.fn(() => state.model),
        getModelReasoningEffort: vi.fn(() => state.modelReasoningEffort),
        getServiceTier: vi.fn(() => state.serviceTier),
        getPermissionMode: vi.fn(() => state.permissionMode),
        getCollaborationMode: vi.fn(() => state.collaborationMode),
        setPermissionMode: vi.fn((value: string) => {
            state.permissionMode = value;
        }),
        setModel: vi.fn((value: string | null) => {
            state.model = value;
        }),
        setModelReasoningEffort: vi.fn((value: string | null) => {
            state.modelReasoningEffort = value;
        }),
        setServiceTier: vi.fn((value: string | null) => {
            state.serviceTier = value;
        }),
        setCollaborationMode: vi.fn((value: string) => {
            state.collaborationMode = value;
        }),
        stopKeepAlive: vi.fn()
    };
});

const harness = vi.hoisted(() => ({
    bootstrapArgs: [] as Array<Record<string, unknown>>,
    loopArgs: [] as Array<Record<string, unknown>>,
    session: {
        onUserMessage: vi.fn(),
        rpcHandlerManager: {
            registerHandler: vi.fn()
        }
    }
}));

vi.mock('@/agent/sessionFactory', () => ({
    bootstrapSession: vi.fn(async (options: Record<string, unknown>) => {
        harness.bootstrapArgs.push(options);
        return {
            api: {},
            session: harness.session
        };
    })
}));

vi.mock('./loop', () => ({
    loop: vi.fn(async (options: Record<string, unknown>) => {
        harness.loopArgs.push(options);
        const onSessionReady = options.onSessionReady as ((session: unknown) => void) | undefined;
        onSessionReady?.(mockCodexSession);
    })
}));

vi.mock('@/claude/registerKillSessionHandler', () => ({
    registerKillSessionHandler: vi.fn()
}));

vi.mock('@/agent/runnerLifecycle', () => ({
    createModeChangeHandler: vi.fn(() => vi.fn()),
    createRunnerLifecycle: vi.fn(() => ({
        registerProcessHandlers: vi.fn(),
        cleanupAndExit: vi.fn(async () => {}),
        markCrash: vi.fn(),
        setExitCode: vi.fn(),
        setArchiveReason: vi.fn()
    })),
    setControlledByUser: vi.fn()
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn()
    }
}));

vi.mock('@/utils/attachmentFormatter', () => ({
    formatMessageWithAttachments: vi.fn((text: string) => text)
}));

vi.mock('@/utils/invokedCwd', () => ({
    getInvokedCwd: vi.fn(() => '/tmp/project')
}));

import { runCodex } from './runCodex';

describe('runCodex', () => {
    beforeEach(() => {
        harness.bootstrapArgs.length = 0;
        harness.loopArgs.length = 0;
        harness.session.onUserMessage.mockReset();
        harness.session.rpcHandlerManager.registerHandler.mockReset();
        mockCodexSession.state.model = undefined;
        mockCodexSession.state.modelReasoningEffort = null;
        mockCodexSession.state.serviceTier = undefined;
        mockCodexSession.state.permissionMode = undefined;
        mockCodexSession.state.collaborationMode = undefined;
        mockCodexSession.getModel.mockClear();
        mockCodexSession.getModelReasoningEffort.mockClear();
        mockCodexSession.getServiceTier.mockClear();
        mockCodexSession.getPermissionMode.mockClear();
        mockCodexSession.getCollaborationMode.mockClear();
        mockCodexSession.setPermissionMode.mockClear();
        mockCodexSession.setModel.mockClear();
        mockCodexSession.setModelReasoningEffort.mockClear();
        mockCodexSession.setServiceTier.mockClear();
        mockCodexSession.setCollaborationMode.mockClear();
        mockCodexSession.stopKeepAlive.mockClear();
    });

    it('applies explicit reasoning effort and service tier without reading stale wrapper values', async () => {
        await runCodex({});

        const configHandler = harness.session.rpcHandlerManager.registerHandler.mock.calls.find(
            (call: unknown[]) => call[0] === 'set-session-config'
        );
        expect(configHandler).toBeDefined();

        const handler = configHandler![1] as (payload: unknown) => Promise<unknown>;
        const result = await handler({
            modelReasoningEffort: 'xhigh',
            serviceTier: 'fast'
        }) as Record<string, unknown>;

        expect(result).toEqual({
            applied: {
                permissionMode: 'default',
                model: null,
                modelReasoningEffort: 'xhigh',
                effort: 'xhigh',
                serviceTier: 'fast',
                collaborationMode: 'default'
            }
        });
        expect(mockCodexSession.setModelReasoningEffort).toHaveBeenLastCalledWith('xhigh');
        expect(mockCodexSession.setServiceTier).toHaveBeenLastCalledWith('fast');
    });
});

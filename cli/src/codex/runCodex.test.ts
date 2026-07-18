import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCodexSession = vi.hoisted(() => {
    const state: {
        permissionMode?: string | null;
        model?: string | null;
        modelReasoningEffort?: string | null;
        serviceTier?: string | null;
        collaborationMode?: string | null;
    } = {};

    return {
        state,
        reset() {
            state.permissionMode = undefined;
            state.model = undefined;
            state.modelReasoningEffort = undefined;
            state.serviceTier = undefined;
            state.collaborationMode = undefined;
        },
        getPermissionMode: vi.fn(() => state.permissionMode),
        setPermissionMode: vi.fn((value: string | null) => { state.permissionMode = value; }),
        getModel: vi.fn(() => state.model),
        setModel: vi.fn((value: string | null) => { state.model = value; }),
        getModelReasoningEffort: vi.fn(() => state.modelReasoningEffort),
        setModelReasoningEffort: vi.fn((value: string | null) => { state.modelReasoningEffort = value; }),
        getServiceTier: vi.fn(() => state.serviceTier),
        setServiceTier: vi.fn((value: string | null) => { state.serviceTier = value; }),
        getCollaborationMode: vi.fn(() => state.collaborationMode),
        setCollaborationMode: vi.fn((value: string | null) => { state.collaborationMode = value; }),
        stopKeepAlive: vi.fn()
    };
});

const harness = vi.hoisted(() => ({
    bootstrapArgs: [] as Array<Record<string, unknown>>,
    loopArgs: [] as Array<Record<string, unknown>>,
    startupOrder: [] as string[],
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
            session: harness.session,
            sessionInfo: { id: 'test-codex-session' },
            reportStartedToRunner: vi.fn(async () => { harness.startupOrder.push('reported') })
        };
    })
}));

vi.mock('./loop', () => ({
    loop: vi.fn(async (options: Record<string, unknown>) => {
        harness.loopArgs.push(options);
        const onSessionReady = options.onSessionReady as ((session: unknown) => void) | undefined;
        if (onSessionReady) {
            onSessionReady(mockCodexSession);
        }
    })
}));

vi.mock('@/claude/registerKillSessionHandler', () => ({
    registerKillSessionHandler: vi.fn()
}));

vi.mock('@/agent/runnerLifecycle', () => ({
    createModeChangeHandler: vi.fn(() => vi.fn()),
    createRunnerLifecycle: vi.fn(() => ({
        registerProcessHandlers: vi.fn(() => { harness.startupOrder.push('handlers') }),
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

describe('runCodex service tier config', () => {
    beforeEach(() => {
        harness.bootstrapArgs.length = 0;
        harness.loopArgs.length = 0;
        harness.startupOrder.length = 0;
        harness.session.onUserMessage.mockReset();
        harness.session.rpcHandlerManager.registerHandler.mockReset();
        mockCodexSession.reset();
        mockCodexSession.getPermissionMode.mockClear();
        mockCodexSession.setPermissionMode.mockClear();
        mockCodexSession.getModel.mockClear();
        mockCodexSession.setModel.mockClear();
        mockCodexSession.getModelReasoningEffort.mockClear();
        mockCodexSession.setModelReasoningEffort.mockClear();
        mockCodexSession.getServiceTier.mockClear();
        mockCodexSession.setServiceTier.mockClear();
        mockCodexSession.getCollaborationMode.mockClear();
        mockCodexSession.setCollaborationMode.mockClear();
        mockCodexSession.stopKeepAlive.mockClear();
    });

    it('passes initial service tier through bootstrap and loop', async () => {
        await runCodex({ serviceTier: 'fast' as never });

        expect(harness.bootstrapArgs[0]?.serviceTier).toBe('fast');
        expect(harness.loopArgs[0]?.serviceTier).toBe('fast');
        expect(mockCodexSession.setServiceTier).toHaveBeenLastCalledWith('fast');
    });

    it('does not report a runner session until lifecycle signal handlers are installed', async () => {
        await runCodex({});

        expect(harness.startupOrder).toEqual(['handlers', 'reported']);
    });

    it('applies service tier via set-session-config after session ready', async () => {
        await runCodex({});

        const registerCalls = harness.session.rpcHandlerManager.registerHandler.mock.calls;
        const configHandler = registerCalls.find(
            (call: unknown[]) => call[0] === 'set-session-config'
        );
        expect(configHandler).toBeDefined();

        const handler = configHandler![1] as (payload: unknown) => Promise<unknown>;
        const result = await handler({ serviceTier: 'fast' }) as Record<string, unknown>;
        const applied = result.applied as Record<string, unknown>;

        expect(applied.serviceTier).toBe('fast');
        expect(mockCodexSession.setServiceTier).toHaveBeenLastCalledWith('fast');
    });

    it('applies model and max reasoning effort via set-session-config after session ready', async () => {
        await runCodex({});

        const registerCalls = harness.session.rpcHandlerManager.registerHandler.mock.calls;
        const configHandler = registerCalls.find(
            (call: unknown[]) => call[0] === 'set-session-config'
        );
        expect(configHandler).toBeDefined();

        const handler = configHandler![1] as (payload: unknown) => Promise<unknown>;
        const result = await handler({ model: 'gpt-5.6-sol', modelReasoningEffort: 'max' }) as Record<string, unknown>;
        const applied = result.applied as Record<string, unknown>;

        expect(applied.model).toBe('gpt-5.6-sol');
        expect(applied.modelReasoningEffort).toBe('max');
        expect(mockCodexSession.setModel).toHaveBeenLastCalledWith('gpt-5.6-sol');
        expect(mockCodexSession.setModelReasoningEffort).toHaveBeenLastCalledWith('max');
    });

    it('accepts ultra reasoning effort via set-session-config after session ready', async () => {
        await runCodex({});

        const registerCalls = harness.session.rpcHandlerManager.registerHandler.mock.calls;
        const configHandler = registerCalls.find(
            (call: unknown[]) => call[0] === 'set-session-config'
        );
        const handler = configHandler![1] as (payload: unknown) => Promise<unknown>;
        const result = await handler({ modelReasoningEffort: 'ultra' }) as Record<string, unknown>;
        const applied = result.applied as Record<string, unknown>;

        expect(applied.modelReasoningEffort).toBe('ultra');
        expect(mockCodexSession.setModelReasoningEffort).toHaveBeenLastCalledWith('ultra');
    });

    it('accepts null model as Auto via set-session-config after session ready', async () => {
        await runCodex({ model: 'gpt-5.6-sol' });

        const registerCalls = harness.session.rpcHandlerManager.registerHandler.mock.calls;
        const configHandler = registerCalls.find(
            (call: unknown[]) => call[0] === 'set-session-config'
        );
        const handler = configHandler![1] as (payload: unknown) => Promise<unknown>;
        const result = await handler({ model: null }) as Record<string, unknown>;
        const applied = result.applied as Record<string, unknown>;

        expect(applied.model).toBeNull();
        expect(mockCodexSession.setModel).toHaveBeenLastCalledWith(null);
    });

    it('uses updated service tier for the next user turn', async () => {
        await runCodex({});

        const registerCalls = harness.session.rpcHandlerManager.registerHandler.mock.calls;
        const configHandler = registerCalls.find(
            (call: unknown[]) => call[0] === 'set-session-config'
        );
        const handler = configHandler![1] as (payload: unknown) => Promise<unknown>;
        await handler({ model: 'gpt-5.6-terra', modelReasoningEffort: 'high', serviceTier: 'fast' });

        const userMessageHandler = harness.session.onUserMessage.mock.calls[0]?.[0] as (message: unknown) => void;
        userMessageHandler({
            content: {
                text: 'hello'
            }
        });

        const queue = harness.loopArgs[0]?.messageQueue as { queue: Array<{ mode: Record<string, unknown> }> };
        expect(queue.queue[0]?.mode.model).toBe('gpt-5.6-terra');
        expect(queue.queue[0]?.mode.modelReasoningEffort).toBe('high');
        expect(queue.queue[0]?.mode.serviceTier).toBe('fast');
    });


    it('isolates /compact user messages so they cannot be batched into normal turns', async () => {
        await runCodex({});

        const userMessageHandler = harness.session.onUserMessage.mock.calls[0]?.[0] as (message: unknown) => void;
        userMessageHandler({
            content: {
                text: 'hello'
            }
        });
        userMessageHandler({
            content: {
                text: '  /compact now  ',
                attachments: [{ name: 'ignored.txt' }]
            }
        });

        const queue = harness.loopArgs[0]?.messageQueue as { queue: Array<{ message: string; isolate?: boolean }> };
        expect(queue.queue).toHaveLength(1);
        expect(queue.queue[0]).toMatchObject({
            message: '/compact now',
            isolate: true
        });
    });

    it('isolates /goal user messages so they cannot be batched into normal turns', async () => {
        await runCodex({});

        const userMessageHandler = harness.session.onUserMessage.mock.calls[0]?.[0] as (message: unknown) => void;
        userMessageHandler({
            content: {
                text: 'hello'
            }
        });
        userMessageHandler({
            content: {
                text: '  /goal finish the stable goal support  ',
                attachments: [{ name: 'ignored.txt' }]
            }
        });

        const queue = harness.loopArgs[0]?.messageQueue as { queue: Array<{ message: string; isolate?: boolean }> };
        expect(queue.queue).toHaveLength(1);
        expect(queue.queue[0]).toMatchObject({
            message: '/goal finish the stable goal support',
            isolate: true
        });
    });
});

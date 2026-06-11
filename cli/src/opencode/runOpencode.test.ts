import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockOpencodeSession = vi.hoisted(() => ({
    setModel: vi.fn(),
    setPermissionMode: vi.fn(),
    setModelReasoningEffort: vi.fn(),
    pushKeepAlive: vi.fn(),
    thinking: false,
    stopKeepAlive: vi.fn()
}));

const harness = vi.hoisted(() => ({
    bootstrapArgs: [] as Array<Record<string, unknown>>,
    opencodeLoopArgs: [] as Array<Record<string, unknown>>,
    opencodeLoopError: null as Error | null,
    listSlashCommands: vi.fn(async (..._args: unknown[]) => [] as Array<unknown>),
    session: {
        onUserMessage: vi.fn(),
        onCancelQueuedMessage: vi.fn(),
        sendAgentMessage: vi.fn(),
        emitMessagesConsumed: vi.fn(),
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
    opencodeLoop: vi.fn(async (options: Record<string, unknown>) => {
        harness.opencodeLoopArgs.push(options);
        if (harness.opencodeLoopError) {
            throw harness.opencodeLoopError;
        }
        const onSessionReady = options.onSessionReady as ((session: unknown) => void) | undefined;
        if (onSessionReady) {
            onSessionReady(mockOpencodeSession);
        }
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
    setSessionEndReason: vi.fn(),
    hasExplicitSessionEndReason: vi.fn(() => false)
}));

vi.mock('@/agent/runnerLifecycle', () => ({
    createModeChangeHandler: vi.fn(() => vi.fn()),
    createRunnerLifecycle: vi.fn(() => lifecycleMock),
    setControlledByUser: vi.fn()
}));

vi.mock('./utils/startOpencodeHookServer', () => ({
    startOpencodeHookServer: vi.fn(async () => ({
        port: 4242,
        stop: vi.fn()
    }))
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn()
    }
}));

vi.mock('@/utils/attachmentFormatter', () => ({
    formatMessageWithAttachments: vi.fn((text: string) => text)
}));

vi.mock('@/modules/common/slashCommands', () => ({
    listSlashCommands: (agent: string, projectDir?: string) => harness.listSlashCommands(agent, projectDir)
}));

import { runOpencode } from './runOpencode';

describe('runOpencode set-session-config handler', () => {
    beforeEach(() => {
        harness.bootstrapArgs.length = 0;
        harness.opencodeLoopArgs.length = 0;
        harness.opencodeLoopError = null;
        mockOpencodeSession.setModel.mockReset();
        mockOpencodeSession.setPermissionMode.mockReset();
        mockOpencodeSession.setModelReasoningEffort.mockReset();
        mockOpencodeSession.pushKeepAlive.mockReset();
        harness.session.onUserMessage.mockReset();
        harness.session.onCancelQueuedMessage.mockReset();
        harness.session.sendAgentMessage.mockReset();
        harness.session.emitMessagesConsumed.mockReset();
        harness.session.rpcHandlerManager.registerHandler.mockReset();
        harness.listSlashCommands.mockReset();
        harness.listSlashCommands.mockResolvedValue([]);
        lifecycleMock.registerProcessHandlers.mockClear();
        lifecycleMock.cleanupAndExit.mockClear();
        lifecycleMock.markCrash.mockClear();
        lifecycleMock.setExitCode.mockClear();
        lifecycleMock.setArchiveReason.mockClear();
        lifecycleMock.setSessionEndReason.mockClear();
    });

    function getConfigHandler(): (payload: unknown) => Promise<unknown> {
        const registerCalls = harness.session.rpcHandlerManager.registerHandler.mock.calls;
        const configHandler = registerCalls.find(
            (call: unknown[]) => call[0] === 'set-session-config'
        );
        expect(configHandler).toBeDefined();
        return configHandler![1] as (payload: unknown) => Promise<unknown>;
    }

    it('rejects plan mode for local OpenCode startup', async () => {
        await expect(runOpencode({ permissionMode: 'plan' })).rejects.toThrow(
            'OpenCode plan mode is only supported in remote mode'
        );
        expect(harness.opencodeLoopArgs).toEqual([]);
    });

    it('allows plan mode for remote OpenCode startup', async () => {
        await runOpencode({ permissionMode: 'plan', startingMode: 'remote' });

        expect(harness.opencodeLoopArgs[0]?.permissionMode).toBe('plan');
        expect(harness.opencodeLoopArgs[0]?.startingMode).toBe('remote');
    });

    it('applies model change via set-session-config RPC', async () => {
        await runOpencode({});

        const handler = getConfigHandler();
        const result = await handler({ model: 'ollama/exaone:4.5-33b-q8' }) as Record<string, unknown>;
        const applied = result.applied as Record<string, unknown>;
        expect(applied.model).toBe('ollama/exaone:4.5-33b-q8');
    });

    it('pushes a keepAlive immediately after a config change so the hub UI reflects it', async () => {
        await runOpencode({});

        // Reset to ignore pushKeepAlive fired from initial onSessionReady setup
        mockOpencodeSession.pushKeepAlive.mockClear();

        const handler = getConfigHandler();
        await handler({ model: 'ollama/exaone:4.5-33b-q8' });

        expect(mockOpencodeSession.pushKeepAlive).toHaveBeenCalledTimes(1);
    });

    it('stores the chosen model on the session for keepalive runtime metadata', async () => {
        await runOpencode({});

        const handler = getConfigHandler();
        await handler({ model: 'mlx/qwen3:0.6b' });

        expect(mockOpencodeSession.setModel).toHaveBeenLastCalledWith('mlx/qwen3:0.6b');
    });

    it('accepts null model (Default) and forwards null to the session', async () => {
        await runOpencode({});

        const handler = getConfigHandler();
        const result = await handler({ model: null }) as Record<string, unknown>;
        const applied = result.applied as Record<string, unknown>;

        expect(applied.model).toBeNull();
        expect(mockOpencodeSession.setModel).toHaveBeenLastCalledWith(null);
    });

    it('rejects non-string, non-null model values', async () => {
        await runOpencode({});

        const handler = getConfigHandler();
        await expect(handler({ model: 123 })).rejects.toThrow();
        await expect(handler({ model: '' })).rejects.toThrow();
        await expect(handler({ model: '   ' })).rejects.toThrow();
    });

    it('only includes changed fields in applied response', async () => {
        await runOpencode({});

        const handler = getConfigHandler();
        const result = await handler({ permissionMode: 'default' }) as Record<string, unknown>;
        const applied = result.applied as Record<string, unknown>;
        expect(applied.permissionMode).toBe('default');
        expect(applied).not.toHaveProperty('model');
    });

    it('still applies permissionMode-only payloads (no model field)', async () => {
        await runOpencode({});

        const handler = getConfigHandler();
        const result = await handler({ permissionMode: 'yolo' }) as Record<string, unknown>;
        const applied = result.applied as Record<string, unknown>;
        expect(applied.permissionMode).toBe('yolo');
    });

    it('accepts plan mode via set-session-config RPC', async () => {
        await runOpencode({});

        const handler = getConfigHandler();
        const result = await handler({ permissionMode: 'plan' }) as Record<string, unknown>;
        const applied = result.applied as Record<string, unknown>;

        expect(applied.permissionMode).toBe('plan');
        expect(mockOpencodeSession.setPermissionMode).toHaveBeenLastCalledWith('plan');
    });



    it('accepts model reasoning effort via set-session-config RPC', async () => {
        await runOpencode({});

        const handler = getConfigHandler();
        const result = await handler({ modelReasoningEffort: 'high' }) as Record<string, unknown>;
        const applied = result.applied as Record<string, unknown>;

        expect(applied.modelReasoningEffort).toBe('high');
        expect(mockOpencodeSession.setModelReasoningEffort).toHaveBeenLastCalledWith('high');
    });

    it('passes initial model from opts through to the loop', async () => {
        await runOpencode({ model: 'ollama/exaone:4.5-33b-q8' });

        expect(harness.opencodeLoopArgs[0]?.model).toBe('ollama/exaone:4.5-33b-q8');
    });

    it('opts in to clearQueuedThinkingGrace when acking a handled slash command', async () => {
        await runOpencode({});

        const userMessageHandler = harness.session.onUserMessage.mock.calls[0]?.[0] as
            ((msg: { content: { text: string; attachments?: unknown[] } }, localId?: string) => void)
            | undefined;
        expect(userMessageHandler).toBeDefined();

        userMessageHandler!({ content: { text: '/status' } }, 'local-status');
        // Drain microtasks so the chain runs and acks the slash command.
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(harness.session.emitMessagesConsumed).toHaveBeenCalledWith(
            ['local-status'],
            { clearQueuedThinkingGrace: true }
        );
        // The slash reply should still have gone out as a separate message.
        expect(harness.session.sendAgentMessage).toHaveBeenCalled();
    });

    it('cancels a slash command that is cancelled before listSlashCommands resolves', async () => {
        let releaseListSlashCommands: () => void = () => {};
        const slashCommandsPromise = new Promise<unknown[]>((resolve) => {
            releaseListSlashCommands = () => resolve([]);
        });
        harness.listSlashCommands.mockReset();
        harness.listSlashCommands.mockReturnValue(slashCommandsPromise);

        await runOpencode({});

        const userMessageHandler = harness.session.onUserMessage.mock.calls[0]?.[0] as
            ((msg: { content: { text: string; attachments?: unknown[] } }, localId?: string) => void)
            | undefined;
        const cancelHandler = harness.session.onCancelQueuedMessage.mock.calls[0]?.[0] as
            ((localId: string) => boolean) | undefined;
        expect(userMessageHandler).toBeDefined();
        expect(cancelHandler).toBeDefined();

        userMessageHandler!({ content: { text: '/status' } }, 'local-1');
        // Cancel arrives while listSlashCommands is still pending — the queue
        // is empty, so without the preparing-localIds bookkeeping the cancel
        // would return false and the slash reply would still fire when the
        // chain resumes.
        expect(cancelHandler!('local-1')).toBe(true);
        releaseListSlashCommands();
        // Drain microtasks so the chain runs the cancellation short-circuit.
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(harness.session.sendAgentMessage).not.toHaveBeenCalled();
        expect(harness.session.emitMessagesConsumed).not.toHaveBeenCalled();
    });
});

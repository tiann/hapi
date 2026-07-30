import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockOpencodeSession = vi.hoisted(() => ({
    setModel: vi.fn(),
    setPermissionMode: vi.fn(),
    setModelReasoningEffort: vi.fn(),
    pushKeepAlive: vi.fn(),
    thinking: false,
    stopKeepAlive: vi.fn(),
    onThinkingChange: vi.fn()
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
        sendSessionEvent: vi.fn(),
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
        mockOpencodeSession.onThinkingChange.mockReset();
        harness.session.onUserMessage.mockReset();
        harness.session.onCancelQueuedMessage.mockReset();
        harness.session.sendAgentMessage.mockReset();
        harness.session.sendSessionEvent.mockReset();
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

    it('queues a /compact request (isolated, with operation:"compact") once compact becomes available', async () => {
        await runOpencode({});

        const onCompactAvailabilityChange = harness.opencodeLoopArgs[0]?.onCompactAvailabilityChange as
            ((available: boolean) => void) | undefined;
        expect(onCompactAvailabilityChange).toBeDefined();
        onCompactAvailabilityChange!(true);

        const messageQueue = harness.opencodeLoopArgs[0]?.messageQueue as
            { queue: Array<{ message: string; mode: { operation?: string }; localId?: string; isolate?: boolean }> };

        const userMessageHandler = harness.session.onUserMessage.mock.calls[0]?.[0] as
            ((msg: { content: { text: string; attachments?: unknown[] } }, localId?: string) => void)
            | undefined;
        expect(userMessageHandler).toBeDefined();

        userMessageHandler!({ content: { text: '/compact' } }, 'local-compact');
        // Drain microtasks across the async chain: listSlashCommands -> slash
        // resolve -> messageQueue.pushIsolated(...).
        for (let i = 0; i < 5; i++) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }

        // No `clearQueuedThinkingGrace` here (unlike the synchronous
        // 'handled' branch) — that flag is only for handlers that will never
        // call onThinkingChange(true) afterward, and a queued /compact WILL
        // (once dequeued in opencodeRemoteLauncher.ts, just later than
        // usual), so the hub still needs its normal queued-thinking grace.
        expect(harness.session.emitMessagesConsumed).toHaveBeenCalledWith(['local-compact']);
        // The actual REST call, "Compaction started/completed" status events,
        // and Reasoning-block summary now all happen inside
        // opencodeRemoteLauncher.ts's dequeue loop once this item reaches the
        // front of the queue (covered by opencodeRemoteLauncher.test.ts) —
        // runOpencode.ts's job for a supported /compact is only to queue it
        // in its correct FIFO position, never to run it directly.
        expect(messageQueue.queue).toEqual([
            {
                message: '',
                mode: expect.objectContaining({ operation: 'compact' }),
                modeHash: expect.any(String),
                localId: 'local-compact',
                isolate: true
            }
        ]);
        expect(harness.session.sendSessionEvent).not.toHaveBeenCalled();
        expect(harness.session.sendAgentMessage).not.toHaveBeenCalled();
    });

    it('falls back to a not-yet-supported message for /compact when compact is not available (e.g. local mode)', async () => {
        await runOpencode({});
        // Deliberately do not call onCompactAvailabilityChange(true) — this
        // is the state a local-mode session stays in (loop.ts resets it to
        // false on every local entry and opencodeLocalLauncher never sets it
        // true).

        const userMessageHandler = harness.session.onUserMessage.mock.calls[0]?.[0] as
            ((msg: { content: { text: string; attachments?: unknown[] } }, localId?: string) => void)
            | undefined;
        userMessageHandler!({ content: { text: '/compact' } }, 'local-compact-none');
        for (let i = 0; i < 5; i++) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }

        const messages = harness.session.sendAgentMessage.mock.calls.map((call) => (call[0] as { message: string }).message);
        expect(messages).toEqual(['/compact is not yet supported in HAPI OpenCode sessions.']);

        const messageQueue = harness.opencodeLoopArgs[0]?.messageQueue as { queue: unknown[] };
        expect(messageQueue.queue).toEqual([]);
    });

    it('stops queuing /compact once availability is reset to false (e.g. a remote->local handoff mid-session)', async () => {
        await runOpencode({});

        const onCompactAvailabilityChange = harness.opencodeLoopArgs[0]?.onCompactAvailabilityChange as
            ((available: boolean) => void) | undefined;
        onCompactAvailabilityChange!(true);
        onCompactAvailabilityChange!(false);

        const userMessageHandler = harness.session.onUserMessage.mock.calls[0]?.[0] as
            ((msg: { content: { text: string; attachments?: unknown[] } }, localId?: string) => void)
            | undefined;
        userMessageHandler!({ content: { text: '/compact' } }, 'local-compact-reset');
        for (let i = 0; i < 5; i++) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }

        const messages = harness.session.sendAgentMessage.mock.calls.map((call) => (call[0] as { message: string }).message);
        expect(messages).toEqual(['/compact is not yet supported in HAPI OpenCode sessions.']);

        const messageQueue = harness.opencodeLoopArgs[0]?.messageQueue as { queue: unknown[] };
        expect(messageQueue.queue).toEqual([]);
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

    it('bounds the unmatched-cancel tracking Set so it cannot grow unboundedly over a long session', async () => {
        await runOpencode({});

        const cancelHandler = harness.session.onCancelQueuedMessage.mock.calls[0]?.[0] as
            ((localId: string) => boolean) | undefined;
        const isLocalIdCancelled = harness.opencodeLoopArgs[0]?.isLocalIdCancelled as
            ((localId: string) => boolean) | undefined;
        expect(cancelHandler).toBeDefined();
        expect(isLocalIdCancelled).toBeDefined();

        // None of these localIds are in the queue or in the pre-enqueue
        // preparing window, so every call falls into the fallback branch
        // that records it as a possible dequeued-compact cancel. Simulate
        // far more of these than could ever realistically be in flight at
        // once (see the comment on `cancelledDequeuedLocalIds` in
        // runOpencode.ts for why this branch is only reachable during a
        // brief per-message ack race) to prove the tracking Set evicts its
        // oldest entries instead of growing forever.
        const localIds = Array.from({ length: 200 }, (_, i) => `unmatched-${i}`);
        for (const localId of localIds) {
            cancelHandler!(localId);
        }

        // The earliest entries must have been evicted...
        expect(isLocalIdCancelled!('unmatched-0')).toBe(false);
        // ...while a recent one is still tracked (delete-and-return: true
        // once, then gone).
        const lastLocalId = localIds[localIds.length - 1]!;
        expect(isLocalIdCancelled!(lastLocalId)).toBe(true);
        expect(isLocalIdCancelled!(lastLocalId)).toBe(false);
    });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockOpencodeSession = vi.hoisted(() => ({
    setModel: vi.fn(),
    setPermissionMode: vi.fn(),
    setModelReasoningEffort: vi.fn(),
    pushKeepAlive: vi.fn(),
    thinking: false,
    stopKeepAlive: vi.fn(),
    onThinkingChange: vi.fn(),
    // Mirrors AgentSessionBase's own `mode` field ('local' | 'remote',
    // flipped synchronously by onModeChange before either launcher
    // starts/finishes) — settable per test to simulate a session that
    // started in remote mode and is still initializing (ACP backend not
    // ready yet, so onCompactAvailabilityChange(true) hasn't fired), as
    // opposed to a genuinely local-mode session. This becomes
    // sessionWrapperRef.current in runOpencode.ts via the mocked
    // opencodeLoop's onSessionReady callback below.
    mode: 'local' as 'local' | 'remote'
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
        // Needed for createModeChangeHandler(session) (real, unmocked) to
        // run without throwing when a test invokes the real onModeChange
        // wrapper passed to opencodeLoop.
        updateAgentState: vi.fn(),
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
        mockOpencodeSession.mode = 'local';
        harness.session.onUserMessage.mockReset();
        harness.session.onCancelQueuedMessage.mockReset();
        harness.session.sendAgentMessage.mockReset();
        harness.session.sendSessionEvent.mockReset();
        harness.session.emitMessagesConsumed.mockReset();
        harness.session.updateAgentState.mockReset();
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

        // No manual emitMessagesConsumed call here (unlike the synchronous
        // 'handled' branch) — the ack now happens automatically at dequeue
        // time via MessageQueue2's onBatchConsumed (wired in
        // AgentSessionBase's constructor onto session.queue, same as any
        // regular prompt), not synchronously when queuing. A manual call
        // right here used to exist and fire immediately regardless of FIFO
        // position — that's what let the hub mark a still-queued /compact
        // "invoked" before it was actually dequeued, breaking cancellation
        // of it while queued (see the comment on this branch in
        // runOpencode.ts and opencodeRemoteLauncher.test.ts's "cancelling a
        // /compact operation while it is still queued behind another
        // prompt" test for the fix this enables).
        expect(harness.session.emitMessagesConsumed).not.toHaveBeenCalled();
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

    it('queues /compact like a prompt while a remote-mode session is still initializing (ACP backend not ready yet), instead of rejecting it as not-yet-supported', async () => {
        // Reproduces a hostile-review finding: compactSupported alone
        // conflates "genuinely local mode" with "remote mode, but ACP
        // initialize + session load/new hasn't finished yet" — a regular
        // prompt sent in that exact same startup window queues normally and
        // just waits, but /compact used to get an immediate not-yet-supported
        // reply instead, even though the session is (or is about to be) in
        // remote mode. sessionWrapperRef.current?.mode (mocked here via
        // mockOpencodeSession.mode, delivered through onSessionReady) is what
        // now distinguishes the two — deliberately never call
        // onCompactAvailabilityChange(true) here, since the whole point is
        // that this must queue even while it's still false.
        mockOpencodeSession.mode = 'remote';
        await runOpencode({});

        const messageQueue = harness.opencodeLoopArgs[0]?.messageQueue as
            { queue: Array<{ message: string; mode: { operation?: string }; localId?: string; isolate?: boolean }> };

        const userMessageHandler = harness.session.onUserMessage.mock.calls[0]?.[0] as
            ((msg: { content: { text: string; attachments?: unknown[] } }, localId?: string) => void)
            | undefined;
        expect(userMessageHandler).toBeDefined();

        userMessageHandler!({ content: { text: '/compact' } }, 'local-compact-pending');
        for (let i = 0; i < 5; i++) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }

        // Must not get the not-yet-supported reply.
        expect(harness.session.sendAgentMessage).not.toHaveBeenCalled();
        // Must be queued exactly like the compactSupported===true case above.
        expect(messageQueue.queue).toEqual([
            {
                message: '',
                mode: expect.objectContaining({ operation: 'compact' }),
                modeHash: expect.any(String),
                localId: 'local-compact-pending',
                isolate: true
            }
        ]);
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

        // Faithful to real production timing: session.mode stays 'remote'
        // throughout the whole teardown window (onLeavingRemote firing
        // synchronously as the very first action of requestExit(), long
        // before runMainLoop() actually returns and mode flips back to
        // 'local') — see AgentSessionBase.onModeChange and
        // OpencodeRemoteLauncher.onLeavingRemote's doc comments. A hostile
        // review found that omitting this from the mock let a real
        // regression slip through: the mode-based /compact queuing fix
        // for the *startup* window (mode:'remote' but not yet ready) also
        // accidentally re-opened queuing during *this* teardown window,
        // since both look identical if you only check `mode !== 'remote'`.
        mockOpencodeSession.mode = 'remote';

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

    it('resumes queuing /compact once a torn-down session re-enters remote mode (compactTeardownInProgress resets on the next remote entry)', async () => {
        // Locks in the other half of compactTeardownInProgress's contract:
        // it must not get stuck true forever after one teardown, or every
        // later remote re-entry's startup window (the case the "queues
        // /compact like a prompt while..." test above covers) would
        // incorrectly reject /compact too.
        //
        // Round 2 of the review-cycle that produced this test found the
        // first version didn't actually discriminate the fix: it left
        // `mockOpencodeSession.mode` at 'remote' throughout, so the gate's
        // `mode !== 'remote'` clause was permanently false and the test
        // would have passed identically even if compactTeardownInProgress
        // never reset (or didn't exist at all). Faithfully modeling the
        // real local interlude between the two remote attempts — mode
        // actually flips to 'local' once the first remote launcher's
        // runMainLoop() fully unwinds, per AgentSessionBase.onModeChange —
        // is what makes this test sensitive to the reset specifically.
        mockOpencodeSession.mode = 'remote';

        await runOpencode({});

        const onCompactAvailabilityChange = harness.opencodeLoopArgs[0]?.onCompactAvailabilityChange as
            ((available: boolean) => void) | undefined;
        const onModeChange = harness.opencodeLoopArgs[0]?.onModeChange as
            ((mode: 'local' | 'remote') => void) | undefined;
        expect(onModeChange).toBeDefined();

        const messageQueue = harness.opencodeLoopArgs[0]?.messageQueue as
            { queue: Array<{ message: string; mode: { operation?: string }; localId?: string; isolate?: boolean }> };
        const userMessageHandler = harness.session.onUserMessage.mock.calls[0]?.[0] as
            ((msg: { content: { text: string; attachments?: unknown[] } }, localId?: string) => void)
            | undefined;

        // First remote attempt becomes ready, then tears down.
        onCompactAvailabilityChange!(true);
        onCompactAvailabilityChange!(false);

        // Local interlude — mode genuinely flips to 'local' here in
        // production. Sanity-check /compact is still correctly rejected
        // during it (proves the interlude is real, not cosmetic).
        mockOpencodeSession.mode = 'local';
        userMessageHandler!({ content: { text: '/compact' } }, 'local-compact-interlude');
        for (let i = 0; i < 5; i++) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        expect(harness.session.sendAgentMessage).toHaveBeenCalledTimes(1);
        expect(messageQueue.queue).toEqual([]);

        // The next remote attempt begins: mode flips back to 'remote' and
        // onModeChange fires on that exact transition — this is what
        // compactTeardownInProgress's reset actually depends on.
        mockOpencodeSession.mode = 'remote';
        onModeChange!('remote');

        userMessageHandler!({ content: { text: '/compact' } }, 'local-compact-reentry');
        for (let i = 0; i < 5; i++) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }

        // Still only the one not-yet-supported reply from the interlude
        // above — the re-entry /compact must queue, not get a second reply.
        expect(harness.session.sendAgentMessage).toHaveBeenCalledTimes(1);
        expect(messageQueue.queue).toEqual([
            {
                message: '',
                mode: expect.objectContaining({ operation: 'compact' }),
                modeHash: expect.any(String),
                localId: 'local-compact-reentry',
                isolate: true
            }
        ]);
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

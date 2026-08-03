import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiConversationHistory } from './conversationHistory';
import { PiRpcResolver } from './loop';
import { PiSession } from './session';
import { PiSteerDispatcher } from './steerDispatcher';
import type { PiTransport } from './piTransport';

function createHarness(options: { streaming?: boolean } = {}) {
    const client = {
        keepAlive: vi.fn(),
        emitMessagesConsumed: vi.fn(),
        sendSessionEvent: vi.fn(),
        updateMetadata: vi.fn(),
        emitSessionReady: vi.fn(),
    };
    const session = new PiSession({
        api: {} as never,
        client: client as never,
        path: '/tmp/project',
        logPath: '/tmp/pi.log',
        startedBy: 'terminal',
        startingMode: 'remote',
    });
    session.markNativeReady();
    session.updateThinkingState(options.streaming ?? true);
    session.rpcResolver = new PiRpcResolver();

    const transport = { send: vi.fn() } as unknown as PiTransport;
    const history = {
        registerUserEntry: vi.fn(),
        rejectPendingEntry: vi.fn(),
    } as unknown as PiConversationHistory;
    const enqueuePrompt = vi.fn();
    const onIndeterminateTimeout = vi.fn();
    const onPendingStateChange = vi.fn();
    const dispatcher = new PiSteerDispatcher({
        session,
        transport,
        conversationHistory: history,
        enqueuePrompt,
        onIndeterminateTimeout,
        onPendingStateChange,
    });
    return { client, dispatcher, enqueuePrompt, history, onIndeterminateTimeout, onPendingStateChange, session, transport };
}

function steerCommands(transport: PiTransport): Array<{ id: string; type: 'steer'; message: string; images?: unknown[] }> {
    return (transport.send as ReturnType<typeof vi.fn>).mock.calls
        .map(([command]) => command as { id: string; type: string; message: string; images?: unknown[] })
        .filter((command): command is { id: string; type: 'steer'; message: string; images?: unknown[] } => command.type === 'steer');
}

function resolveSteer(session: PiSession, command: { id: string; type: 'steer' }, success = true, error?: string): void {
    session.rpcResolver!.resolveResponse({
        type: 'response',
        id: command.id,
        command: 'steer',
        success,
        ...(error ? { error } : {}),
    });
}

afterEach(() => vi.useRealTimers());

describe('PiSteerDispatcher', () => {
    it('streams an explicit steer, registers history before send, and consumes it without clearing main thinking', async () => {
        const h = createHarness();
        h.dispatcher.enqueue({
            localId: 'steer-1',
            message: 'change direction',
            images: [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }],
            outboundSequence: 1,
            targetStreamingGeneration: h.session.currentStreamingGeneration,
        });

        await vi.waitFor(() => expect(steerCommands(h.transport)).toHaveLength(1));
        const command = steerCommands(h.transport)[0]!;
        expect(command).toMatchObject({ type: 'steer', message: 'change direction', images: [{ mimeType: 'image/png' }] });
        expect(h.history.registerUserEntry).toHaveBeenCalledBefore(h.transport.send as ReturnType<typeof vi.fn>);
        expect(h.client.emitMessagesConsumed).not.toHaveBeenCalled();

        resolveSteer(h.session, command);
        await vi.waitFor(() => expect(h.client.emitMessagesConsumed).toHaveBeenCalledWith(['steer-1'], undefined));
        expect(h.session.piIsStreaming).toBe(true);
    });

    it('sends steers FIFO by matching responses, not by agent settlement or steering mode', async () => {
        const h = createHarness();
        h.session.currentSteeringMode = 'one-at-a-time';
        h.dispatcher.enqueue({ localId: 'steer-a', message: 'a', images: [], outboundSequence: 1, targetStreamingGeneration: h.session.currentStreamingGeneration });
        h.dispatcher.enqueue({ localId: 'steer-b', message: 'b', images: [], outboundSequence: 2, targetStreamingGeneration: h.session.currentStreamingGeneration });

        await vi.waitFor(() => expect(steerCommands(h.transport)).toHaveLength(1));
        expect(steerCommands(h.transport)[0]).toMatchObject({ message: 'a' });
        resolveSteer(h.session, steerCommands(h.transport)[0]!);
        await vi.waitFor(() => expect(steerCommands(h.transport)).toHaveLength(2));
        expect(steerCommands(h.transport)[1]).toMatchObject({ message: 'b' });
        expect(h.history.registerUserEntry).toHaveBeenNthCalledWith(1, 'steer-a');
        expect(h.history.registerUserEntry).toHaveBeenNthCalledWith(2, 'steer-b');
    });

    it('maps native user entries from prompts and steers through one FIFO history registration', async () => {
        const h = createHarness();
        const history = new PiConversationHistory(h.session, vi.fn());
        const dispatcher = new PiSteerDispatcher({
            session: h.session,
            transport: h.transport,
            conversationHistory: history,
            enqueuePrompt: h.enqueuePrompt,
            onIndeterminateTimeout: h.onIndeterminateTimeout,
        });
        dispatcher.enqueue({ localId: 'steer-first', message: 'same text', images: [], outboundSequence: 1, targetStreamingGeneration: h.session.currentStreamingGeneration });
        dispatcher.enqueue({ localId: 'steer-second', message: 'same text', images: [], outboundSequence: 2, targetStreamingGeneration: h.session.currentStreamingGeneration });

        await vi.waitFor(() => expect(steerCommands(h.transport)).toHaveLength(1));
        resolveSteer(h.session, steerCommands(h.transport)[0]!);
        await vi.waitFor(() => expect(steerCommands(h.transport)).toHaveLength(2));
        resolveSteer(h.session, steerCommands(h.transport)[1]!);
        await vi.waitFor(() => expect(h.client.emitMessagesConsumed).toHaveBeenCalledTimes(2));

        history.observeEntry({ id: 'native-first', type: 'message', message: { role: 'user' } });
        history.observeEntry({ id: 'native-second', type: 'message', message: { role: 'user' } });
        expect(history.getEntryIds()).toEqual({
            'steer-first': 'native-first',
            'steer-second': 'native-second',
        });
    });

    it('rejects an ABA streaming transition behind the shared runtime lock and falls back', async () => {
        const h = createHarness();
        const releaseConfig = await h.session.acquireRuntimeMutation();
        const capturedGeneration = h.session.currentStreamingGeneration;
        h.dispatcher.enqueue({
            localId: 'locked-steer',
            message: 'wait for config',
            images: [],
            outboundSequence: 1,
            targetStreamingGeneration: capturedGeneration,
        });
        await Promise.resolve();
        expect(steerCommands(h.transport)).toHaveLength(0);

        h.session.updateThinkingState(false);
        h.session.updateThinkingState(true);
        expect(h.session.currentStreamingGeneration).not.toBe(capturedGeneration);
        releaseConfig();
        await vi.waitFor(() => expect(h.enqueuePrompt).toHaveBeenCalledWith({
            localId: 'locked-steer', message: 'wait for config', images: [], outboundSequence: 1,
        }));
        expect(steerCommands(h.transport)).toHaveLength(0);
    });

    it('notifies the prompt pump after pending steer work drains', async () => {
        const h = createHarness({ streaming: false });
        h.dispatcher.enqueue({
            localId: 'idle-steer',
            message: 'ordinary turn now',
            images: [],
            outboundSequence: 1,
            targetStreamingGeneration: null,
        });
        h.onPendingStateChange.mockClear();

        await vi.waitFor(() => expect(h.dispatcher.hasPending).toBe(false));

        expect(h.enqueuePrompt).toHaveBeenCalledTimes(1);
        expect(h.onPendingStateChange).toHaveBeenCalled();
    });

    it('falls back to the normal prompt queue when a steer reaches dispatch after Pi is idle', async () => {
        const h = createHarness({ streaming: false });
        h.dispatcher.enqueue({ localId: 'idle-steer', message: 'ordinary turn now', images: [], outboundSequence: 1, targetStreamingGeneration: h.session.currentStreamingGeneration });

        await vi.waitFor(() => expect(h.enqueuePrompt).toHaveBeenCalledWith({
            localId: 'idle-steer', message: 'ordinary turn now', images: [], outboundSequence: 1,
        }));
        expect(steerCommands(h.transport)).toHaveLength(0);
        expect(h.history.registerUserEntry).not.toHaveBeenCalled();
    });

    it('removes failed native steers from history and clears only their queued thinking grace', async () => {
        const h = createHarness();
        h.dispatcher.enqueue({ localId: 'failed-steer', message: 'will fail', images: [], outboundSequence: 1, targetStreamingGeneration: h.session.currentStreamingGeneration });
        await vi.waitFor(() => expect(steerCommands(h.transport)).toHaveLength(1));

        resolveSteer(h.session, steerCommands(h.transport)[0]!, false, 'steer rejected');
        await vi.waitFor(() => expect(h.history.rejectPendingEntry).toHaveBeenCalledWith('failed-steer'));
        expect(h.client.emitMessagesConsumed).toHaveBeenCalledWith(
            ['failed-steer'],
            { clearQueuedThinkingGrace: true },
        );
        expect(h.client.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message', message: 'Pi steer failed: steer rejected',
        });
        expect(h.session.piIsStreaming).toBe(true);
    });

    it('allows cancellation before native send but not after the steer has reached stdin', async () => {
        const h = createHarness();
        let releaseMutation!: () => void;
        const originalRunMutation = h.session.runRuntimeMutation.bind(h.session);
        const runMutationSpy = vi.spyOn(h.session, 'runRuntimeMutation').mockImplementation(async (operation, options) => {
            await new Promise<void>((resolve) => { releaseMutation = resolve; });
            return await originalRunMutation(operation, options);
        });
        h.dispatcher.enqueue({ localId: 'waiting-steer', message: 'waiting', images: [], outboundSequence: 1, targetStreamingGeneration: h.session.currentStreamingGeneration });
        await vi.waitFor(() => expect(h.session.runRuntimeMutation).toHaveBeenCalled());
        expect(h.dispatcher.cancelByLocalId('waiting-steer')).toBe(true);
        expect(h.dispatcher.hasPending).toBe(false);
        releaseMutation();
        await vi.waitFor(() => expect(h.session.runRuntimeMutation).toHaveBeenCalled());
        expect(steerCommands(h.transport)).toHaveLength(0);

        runMutationSpy.mockRestore();
        h.dispatcher.enqueue({ localId: 'sent-steer', message: 'sent', images: [], outboundSequence: 2, targetStreamingGeneration: h.session.currentStreamingGeneration });
        await vi.waitFor(() => expect(steerCommands(h.transport)).toHaveLength(1));
        expect(h.dispatcher.cancelByLocalId('sent-steer')).toBe(false);
        resolveSteer(h.session, steerCommands(h.transport)[0]!);
    });

    it('poisons the shared runtime mutation lease and fails closed when a native steer times out', async () => {
        vi.useFakeTimers();
        const h = createHarness();
        h.dispatcher.enqueue({ localId: 'timeout-steer', message: 'timeout', images: [], outboundSequence: 1, targetStreamingGeneration: h.session.currentStreamingGeneration });
        await vi.advanceTimersByTimeAsync(0);
        expect(steerCommands(h.transport)).toHaveLength(1);
        h.dispatcher.enqueue({ localId: 'after-timeout', message: 'must remain blocked', images: [], outboundSequence: 2, targetStreamingGeneration: h.session.currentStreamingGeneration });

        await vi.advanceTimersByTimeAsync(10_001);
        await vi.waitFor(() => expect(h.onIndeterminateTimeout).toHaveBeenCalledTimes(1));
        expect(h.client.emitMessagesConsumed).toHaveBeenCalledWith(
            ['timeout-steer'],
            { clearQueuedThinkingGrace: true },
        );
        expect(steerCommands(h.transport)).toHaveLength(1);
    });

    it('stops local steers during transport cleanup without falling back to prompts', async () => {
        const h = createHarness();
        h.session.updateThinkingState(false);
        h.dispatcher.stop();
        expect(h.onPendingStateChange).not.toHaveBeenCalled();
        h.dispatcher.enqueue({ localId: 'shutdown-steer', message: 'must not queue', images: [], outboundSequence: 1, targetStreamingGeneration: h.session.currentStreamingGeneration });
        await Promise.resolve();
        expect(h.enqueuePrompt).not.toHaveBeenCalled();
        expect(h.onPendingStateChange).not.toHaveBeenCalled();
        expect(steerCommands(h.transport)).toHaveLength(0);
    });
});

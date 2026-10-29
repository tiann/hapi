import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import type { UserMessage } from '@/api/types';

const { prepare } = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock('../runPi', () => ({ preparePiUserMessage: prepare }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }));
import { PiNativeSessionBridge, type PiNativeState } from './session';

function deferred<T = unknown>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

const nativeState = (extra: Partial<PiNativeState> = {}): PiNativeState => ({
    sessionId: 'native-1', sessionName: 'Native title', model: { id: 'deepseek-chat', provider: 'deepseek' },
    thinkingLevel: 'high', isStreaming: false, streamGeneration: 4, sessionGeneration: 1, branch: [], ...extra
});

const message = (text: string, steer = false): UserMessage => ({
    role: 'user', content: { type: 'text', text }, ...(steer ? { meta: { deliveryMode: 'steer' } } : {})
} as UserMessage);

describe('PiNativeSessionBridge', () => {
    const bridges: PiNativeSessionBridge[] = [];

    beforeEach(() => {
        prepare.mockReset();
        prepare.mockImplementation(async (text: string) => ({ message: text, images: [], imageReadErrors: [] }));
    });

    afterEach(() => {
        for (const bridge of bridges.splice(0)) bridge.deactivate();
        vi.useRealTimers();
    });

    function harness() {
        let metadata: Record<string, unknown> = {};
        let state: Record<string, unknown> = {};
        let onUser!: (message: UserMessage, localId?: string) => void;
        let onCancel!: (localId: string) => boolean;
        const handlers = new Map<string, (payload?: unknown) => Promise<unknown>>();
        const client = {
            sessionId: 'hapi-1',
            getMetadata: vi.fn(() => metadata),
            updateMetadata: vi.fn((update: (value: Record<string, unknown>) => Record<string, unknown>) => { metadata = update(metadata); }),
            updateAgentState: vi.fn((update: (value: Record<string, unknown>) => Record<string, unknown>) => { state = update(state); }),
            onUserMessage: vi.fn((handler: typeof onUser) => { onUser = handler; }),
            onCancelQueuedMessage: vi.fn((handler: typeof onCancel) => { onCancel = handler; }),
            keepAlive: vi.fn(), sendUserMessage: vi.fn(), sendAgentMessage: vi.fn(), sendSessionEvent: vi.fn(),
            emitSessionReady: vi.fn(), emitMessagesConsumed: vi.fn(),
            rpcHandlerManager: { registerHandler: vi.fn((name: string, handler: (payload?: unknown) => Promise<unknown>) => handlers.set(name, handler)) }
        };
        const request = vi.fn(async (command: Record<string, unknown>, _sessionId: string): Promise<unknown> => {
            if (command.type === 'get_state') return nativeState();
            if (command.type === 'get_available_models') return { models: [{ id: 'deepseek-chat', provider: 'deepseek', name: 'DeepSeek' }] };
            if (command.type === 'get_commands') return { commands: [{ name: 'review', source: 'extension' }, { name: 'skill:test', source: 'skill' }] };
            return { submitted: true };
        });
        const bridge = new PiNativeSessionBridge(client as never, 'native-1', request);
        bridges.push(bridge);
        return {
            bridge, client, request, handlers,
            user: (text: string, localId?: string, steer = false) => onUser(message(text, steer), localId),
            cancel: (localId: string) => onCancel(localId),
            calls: (type: string) => request.mock.calls.filter(([command]) => command.type === type),
            metadata: () => metadata,
            rpc: (name: string, payload?: unknown) => handlers.get(name)!(payload)
        };
    }

    it('echoes only interactive input; engine user events never duplicate persisted web rows', async () => {
        const h = harness();
        await h.bridge.initialize(nativeState(), false);
        h.bridge.handleEvent({ type: 'input', source: 'interactive', text: 'terminal text' });
        h.bridge.handleEvent({ type: 'input', source: 'extension', text: 'web text' });
        h.bridge.handleEvent({ type: 'input', source: 'rpc', text: 'rpc text' });
        h.bridge.handleEvent({ type: 'message_start', message: { role: 'user', content: 'web text' } });
        h.bridge.handleEvent({ type: 'message_end', message: { role: 'user', content: 'web text' } });
        expect(h.client.sendUserMessage).toHaveBeenCalledExactlyOnceWith('terminal text', { sentFrom: 'cli' }, expect.any(String));
    });

    it('streams assistant snapshots, tool progress and final results without user-event flushes', async () => {
        vi.useFakeTimers();
        const h = harness();
        await h.bridge.initialize(nativeState(), false);
        h.bridge.handleEvent({ type: 'turn_start' });
        h.bridge.handleEvent({ type: 'message_start', message: { role: 'assistant' } });
        h.bridge.handleEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello' } });
        await vi.advanceTimersByTimeAsync(50);
        h.bridge.handleEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ' world' } });
        const count = h.client.sendAgentMessage.mock.calls.length;
        h.bridge.handleEvent({ type: 'message_end', message: { role: 'user' } });
        expect(h.client.sendAgentMessage).toHaveBeenCalledTimes(count);
        h.bridge.handleEvent({ type: 'message_end', message: { role: 'assistant' } });
        const snapshots = h.client.sendAgentMessage.mock.calls.map(([entry]) => entry).filter(entry => entry.type === 'message');
        expect(snapshots.at(-1)).toMatchObject({ type: 'message', message: 'hello world', streamSnapshot: true });
        expect(new Set(snapshots.map(entry => entry.id)).size).toBe(1);
        h.bridge.handleEvent({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash', args: { command: 'pwd' } });
        h.bridge.handleEvent({ type: 'tool_execution_update', toolCallId: 'call-1', toolName: 'bash', args: {}, partialResult: { text: 'working' } });
        h.bridge.handleEvent({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'bash', result: { content: [{ type: 'text', text: '/work' }] }, isError: false });
        expect(h.client.sendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool-call', callId: 'call-1', status: 'in_progress' }));
        expect(h.client.sendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool-call', callId: 'call-1', progress: { text: 'working' } }));
        expect(h.client.sendAgentMessage).toHaveBeenCalledWith({ type: 'tool-call-result', callId: 'call-1', output: '/work', is_error: false });
    });

    it('replays only supplied current branch with deterministic native entry IDs', async () => {
        const h = harness();
        await h.bridge.initialize(nativeState({ branch: [
            { type: 'message', id: 'user-1', message: { role: 'user', content: [{ type: 'text', text: 'history' }] } },
            { type: 'message', id: 'assistant-1', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }, { type: 'toolCall', id: 'history-call', name: 'read', arguments: { path: 'a' } }] } },
            { type: 'message', id: 'result-1', message: { role: 'toolResult', toolCallId: 'history-call', content: 'contents' } }
        ] }), true);
        expect(h.client.sendUserMessage).toHaveBeenCalledExactlyOnceWith('history', { sentFrom: 'cli' }, 'pi-native-user-1');
        expect(h.client.sendAgentMessage).toHaveBeenCalledWith({ type: 'message', message: 'answer', id: 'pi-native-assistant-1-0' });
        expect(h.client.sendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool-call', callId: 'history-call', status: 'completed' }));
        expect(h.client.sendAgentMessage).toHaveBeenCalledWith({ type: 'tool-call-result', callId: 'history-call', output: 'contents', is_error: false });
    });

    it('buffers web input until native binding and both catalogs finish', async () => {
        const h = harness();
        const bind = deferred();
        const models = deferred();
        const commands = deferred();
        h.request.mockImplementation(async (command) => {
            if (command.type === 'bind_hapi_session') return bind.promise;
            if (command.type === 'get_available_models') return models.promise;
            if (command.type === 'get_commands') return commands.promise;
            return { submitted: true };
        });
        h.user('queued startup', 'startup-1');
        const initialized = h.bridge.initialize(nativeState(), false);
        expect(h.calls('prompt')).toHaveLength(0);
        expect(h.calls('get_commands')).toHaveLength(0);
        bind.resolve({ bound: true });
        await vi.waitFor(() => expect(h.calls('get_commands')).toHaveLength(1));
        models.resolve({ models: [] });
        await Promise.resolve();
        expect(h.calls('prompt')).toHaveLength(0);
        expect(h.client.emitSessionReady).not.toHaveBeenCalled();
        commands.resolve({ commands: [] });
        await initialized;
        await vi.waitFor(() => expect(h.calls('prompt')).toHaveLength(1));
        expect(h.calls('bind_hapi_session')[0]).toEqual([expect.objectContaining({ type: 'bind_hapi_session', hapiSessionId: 'hapi-1', sessionGeneration: 1 }), 'native-1']);
        expect(h.client.emitSessionReady).toHaveBeenCalledOnce();
        await vi.waitFor(() => expect(h.client.emitMessagesConsumed).toHaveBeenCalledWith(['startup-1'], expect.any(Object)));
    });

    it('keeps plain input FIFO until agent_settled rather than agent_end', async () => {
        const h = harness();
        await h.bridge.initialize(nativeState(), false);
        h.user('first', 'first-1');
        h.user('second', 'second-1');
        await vi.waitFor(() => expect(h.calls('prompt')).toHaveLength(1));
        h.bridge.handleEvent({ type: 'agent_start', streamGeneration: 5 });
        h.bridge.handleEvent({ type: 'agent_end', messages: [] });
        await Promise.resolve();
        expect(h.calls('prompt')).toHaveLength(1);
        h.bridge.handleEvent({ type: 'agent_settled' });
        await vi.waitFor(() => expect(h.calls('prompt')).toHaveLength(2));
        expect(h.calls('prompt').map(([command]) => command.message)).toEqual(['first', 'second']);
    });

    it('cancels queued input but cannot cancel a command after dispatch', async () => {
        const h = harness();
        await h.bridge.initialize(nativeState({ isStreaming: true }), false);
        h.user('cancelled', 'cancel-1');
        h.user('keep', 'keep-1');
        expect(h.cancel('cancel-1')).toBe(true);
        h.bridge.handleEvent({ type: 'agent_settled' });
        await vi.waitFor(() => expect(h.calls('prompt')).toHaveLength(1));
        expect(h.calls('prompt')[0][0]).toMatchObject({ message: 'keep' });
        expect(h.cancel('keep-1')).toBe(false);
        expect(h.client.emitMessagesConsumed).not.toHaveBeenCalledWith(['cancel-1'], expect.anything());
    });

    it('promotes steer only after its native RPC acknowledgement, binding the current generation', async () => {
        const h = harness();
        await h.bridge.initialize(nativeState({ isStreaming: true, streamGeneration: 9 }), false);
        const ack = deferred();
        h.request.mockImplementation(async command => command.type === 'steer' ? ack.promise : nativeState({ isStreaming: true, streamGeneration: 9 }));
        h.user('redirect', 'steer-1');
        let resolved = false;
        const promotion = h.rpc(RPC_METHODS.SteerQueuedMessage, { localId: 'steer-1' }).then(result => { resolved = true; return result; });
        await vi.waitFor(() => expect(h.calls('steer')).toHaveLength(1));
        expect(h.calls('steer')[0]).toEqual([expect.objectContaining({ type: 'steer', message: 'redirect', expectedStreamGeneration: 9 }), 'native-1']);
        expect(resolved).toBe(false);
        expect(h.client.emitMessagesConsumed).not.toHaveBeenCalled();
        ack.resolve({ submitted: true });
        await expect(promotion).resolves.toEqual({ steered: true });
        expect(h.client.emitMessagesConsumed).toHaveBeenCalledWith(['steer-1'], { clearQueuedThinkingGrace: true, steered: true });
    });

    it('rejects a steer whose generation changed during attachment preparation', async () => {
        const h = harness();
        await h.bridge.initialize(nativeState({ isStreaming: true, streamGeneration: 10 }), false);
        const preparation = deferred();
        prepare.mockReturnValueOnce(preparation.promise);
        h.user('outdated steer', 'stale-1');
        const promoted = h.rpc(RPC_METHODS.SteerQueuedMessage, { localId: 'stale-1' });
        await vi.waitFor(() => expect(prepare).toHaveBeenCalled());
        h.bridge.handleEvent({ type: 'agent_settled' });
        h.bridge.handleEvent({ type: 'agent_start', streamGeneration: 11 });
        preparation.resolve({ message: 'outdated steer', images: [], imageReadErrors: [] });
        await expect(promoted).resolves.toMatchObject({ steered: false, error: expect.stringContaining('ended') });
        expect(h.calls('steer')).toHaveLength(0);
        expect(h.client.emitMessagesConsumed).toHaveBeenCalledWith(['stale-1'], expect.any(Object));
    });

    it('deactivates old rows while preparation is pending and ignores late events/messages', async () => {
        const h = harness();
        await h.bridge.initialize(nativeState(), false);
        const preparation = deferred();
        prepare.mockReturnValueOnce(preparation.promise);
        h.user('old request', 'old-1');
        await vi.waitFor(() => expect(prepare).toHaveBeenCalled());
        h.bridge.deactivate();
        preparation.resolve({ message: 'old request', images: [], imageReadErrors: [] });
        h.user('later old request', 'old-2');
        h.bridge.handleEvent({ type: 'input', source: 'interactive', text: 'late' });
        await Promise.resolve();
        await expect(h.rpc(RPC_METHODS.Abort)).rejects.toThrow('no longer active');
        expect(h.calls('prompt')).toHaveLength(0);
        expect(h.client.sendUserMessage).not.toHaveBeenCalled();
        expect(h.client.emitMessagesConsumed).not.toHaveBeenCalled();
    });

    it('suspends queued messages and steer waiters until a fresh native initialization', async () => {
        const h = harness();
        await h.bridge.initialize(nativeState({ isStreaming: true }), false);
        const preparation = deferred();
        prepare.mockReturnValueOnce(preparation.promise);
        h.user('old steer', 'old-steer');
        const promotion = h.rpc(RPC_METHODS.SteerQueuedMessage, { localId: 'old-steer' });
        h.bridge.suspend();
        await expect(promotion).resolves.toMatchObject({ steered: false });
        preparation.resolve({ message: 'old steer', images: [], imageReadErrors: [] });
        h.bridge.handleEvent({ type: 'agent_settled' });
        await Promise.resolve();
        expect(h.calls('steer')).toHaveLength(0);
        expect(h.calls('prompt')).toHaveLength(0);
    });

    it('does not reopen a suspended binding when its old initialization completes late', async () => {
        const h = harness();
        const bind = deferred();
        h.request.mockImplementation(async command => command.type === 'bind_hapi_session' ? bind.promise : { models: [], commands: [] });
        h.user('startup old row', 'startup-old');
        const initialized = h.bridge.initialize(nativeState(), false).catch(() => {});
        h.bridge.suspend();
        bind.resolve({ bound: true });
        await initialized;
        h.user('late old row', 'late-old');
        await Promise.resolve();
        expect(h.client.emitSessionReady).not.toHaveBeenCalled();
        expect(h.calls('prompt')).toHaveLength(0);
    });

    it('keeps the binding epoch immutable when a later state belongs to another native branch', async () => {
        const h = harness();
        await h.bridge.initialize(nativeState({ sessionGeneration: 1 }), false);
        expect(() => h.bridge.applyState(nativeState({ sessionGeneration: 2 }))).toThrow();
        await h.rpc(RPC_METHODS.Abort);
        expect(h.calls('abort')[0][0]).toMatchObject({ sessionGeneration: 1 });
    });

    it('retires an uncertain failed submission with an explicit error and never replays it', async () => {
        vi.useFakeTimers();
        const h = harness();
        await h.bridge.initialize(nativeState(), false);
        h.request.mockImplementation(async command => {
            if (command.type === 'prompt') throw new Error('IPC disconnected; outcome unknown');
            return nativeState();
        });
        h.user('one attempt', 'uncertain-1');
        await vi.advanceTimersByTimeAsync(10);
        expect(h.calls('prompt')).toHaveLength(1);
        expect(h.client.emitMessagesConsumed).toHaveBeenCalledExactlyOnceWith(['uncertain-1'], expect.any(Object));
        expect(h.client.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Inspect the terminal before retrying') }));
        await vi.advanceTimersByTimeAsync(10_000);
        h.bridge.handleEvent({ type: 'agent_settled' });
        await vi.advanceTimersByTimeAsync(10);
        expect(h.calls('prompt')).toHaveLength(1);
    });

    it('rejects remote slash commands and advertises empty native command/skill inventories', async () => {
        const h = harness();
        await h.bridge.initialize(nativeState(), false);
        await expect(h.rpc(RPC_METHODS.ListSlashCommands)).resolves.toEqual({ success: true, commands: [] });
        await expect(h.rpc(RPC_METHODS.ListSkills)).resolves.toEqual({ success: true, skills: [] });
        for (const [index, text] of ['/review', '/compact', '/skill:test'].entries()) h.user(text, `slash-${index}`);
        await vi.waitFor(() => expect(h.client.sendSessionEvent).toHaveBeenCalledTimes(3));
        expect(h.calls('prompt')).toHaveLength(0);
        expect(h.calls('steer')).toHaveLength(0);
        expect(h.client.emitMessagesConsumed).toHaveBeenCalledTimes(3);
        expect(h.client.sendSessionEvent.mock.calls.every(([event]) => event.message.includes('Pi terminal'))).toBe(true);
    });

    it('reflects native model/thinking state in metadata and keepalive', async () => {
        const h = harness();
        await h.bridge.initialize(nativeState(), false);
        h.bridge.handleEvent({ type: 'model_select', state: nativeState({ model: { id: 'deepseek-reasoner', provider: 'deepseek' }, thinkingLevel: 'xhigh' }) });
        expect(h.metadata()).toMatchObject({ piSelectedModel: { modelId: 'deepseek-reasoner', provider: 'deepseek' } });
        expect(h.client.keepAlive).toHaveBeenLastCalledWith(false, 'local', { model: 'deepseek-reasoner', effort: 'xhigh' });
        h.bridge.handleEvent({ type: 'thinking_level_select', state: nativeState({ model: { id: 'deepseek-reasoner', provider: 'deepseek' }, thinkingLevel: 'low' }) });
        expect(h.client.keepAlive).toHaveBeenLastCalledWith(false, 'local', { model: 'deepseek-reasoner', effort: 'low' });
    });

    it('uses one state reconciliation for handled input without resubmitting it', async () => {
        vi.useFakeTimers();
        const h = harness();
        await h.bridge.initialize(nativeState(), false);
        h.user('handled by extension', 'handled-1');
        h.user('next', 'next-1');
        await vi.advanceTimersByTimeAsync(10);
        expect(h.calls('prompt')).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(h.calls('get_state')).toHaveLength(1);
        expect(h.calls('prompt').map(([command]) => command.message)).toEqual(['handled by extension', 'next']);
    });
});

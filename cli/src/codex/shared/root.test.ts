import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentState, Metadata } from '@/api/types';
import type { SessionBootstrapResult } from '@/agent/sessionFactory';
import { SharedCodexRoot, type RootHost } from './root';
import { codexPlanProposalId } from './plan';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import { SharedRewindBarrier } from './rewind';

type NativeTurn = { id: string; status: string; items: unknown[] };

vi.mock('../codexAppServerClient', () => ({
    CodexAppServerClient: class {
        initialized = false;
        thread = { id: 'thread', historyMode: 'legacy', turns: [] as NativeTurn[] };
        settings: Record<string, unknown> = { model: 'mock', collaborationMode: { mode: 'default' } };
        queue: Array<{ id: string; clientUserMessageId: unknown; input: unknown }> = [];
        notify?: (method: string, params: unknown) => void;
        abandoned?: () => void;
        serverRequest?: (request: { id: number; method: string; params: unknown }) => void;
        setNotificationHandler(handler: typeof this.notify) { this.notify = handler; }
        setTransportAbandonedHandler(handler: (() => void) | null) { this.abandoned = handler ?? undefined; }
        setServerRequestHandler(handler: typeof this.serverRequest) { this.serverRequest = handler; }
        async connect() {}
        async initialize() { this.initialized = true; }
        isInitialized() { return this.initialized; }
        async disconnect() { this.initialized = false; }
        async supportsMethod() { return true; }
        async request(method: string, params: Record<string, unknown> = {}) {
            if (method === 'thread/read' || method === 'thread/resume') return { ...this.settings, thread: structuredClone(this.thread) };
            if (method === 'thread/list') return { data: [] };
            if (method === 'thread/queue/list') return { data: this.queue };
            if (method === 'thread/goal/get') return { goal: null };
            if (method === 'thread/turns/list') return { data: structuredClone(this.thread.turns) };
            if (method === 'thread/revert') {
                const index = this.thread.turns.findIndex(turn => turn.id === params.beforeTurnId);
                if (index < 0) throw new Error('Invalid boundary');
                this.thread.turns.splice(index);
                this.notify?.('thread/reverted', { threadId: 'thread' });
                return { thread: { ...this.thread, turns: [] } };
            }
            if (method === 'thread/settings/update') {
                this.settings = { ...this.settings, ...params };
                this.notify?.('thread/settings/updated', { threadId: 'thread', threadSettings: this.settings });
                return {};
            }
            if (method === 'thread/queue/add') {
                const entry = { id: `queued-${this.queue.length}`, clientUserMessageId: params.clientUserMessageId, input: params.input };
                this.queue.push(entry);
                return { queuedSubmission: entry };
            }
            throw new Error(`Unexpected request: ${method}`);
        }
    },
    isIndeterminateError: () => false
}));
vi.mock('../utils/buildHapiMcpBridge', () => ({ buildHapiMcpBridge: async () => ({
    mcpServers: {}, server: { stop() {} }
}) }));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
    try { for (const cleanup of cleanups.splice(0)) await cleanup(); }
    finally { vi.useRealTimers(); }
});

async function fixture(opts?: { hubArchived?: boolean; end?: RootHost['end'] }) {
    const directory = await mkdtemp('/tmp/hapi-shared-root-');
    let state: AgentState = { steeringActive: true };
    let metadata: Metadata = { path: directory, host: 'test', flavor: 'codex' };
    let reconnect: (() => void) | null = null;
    const updateState = vi.fn((fn: (value: AgentState) => AgentState) => { state = fn(state); });
    const rpc = new Map<string, (raw: unknown) => Promise<unknown>>();
    const send = vi.fn();
    const hubArchivedListeners: Array<() => void> = [];
    const session = {
        sessionId: 'sid', getMetadata: () => metadata,
        hubArchived: opts?.hubArchived ?? false,
        updateMetadata: (fn: (value: Metadata) => Metadata) => { metadata = fn(metadata); },
        updateAgentState: updateState, keepAlive() {},
        onUserMessage() {}, onCancelQueuedMessage() {}, onRetryQueuedMessage() {},
        onReconnect: (fn: (() => void) | null) => { reconnect = fn; },
        on(event: string, listener: () => void) {
            if (event === 'hub-archived') hubArchivedListeners.push(listener);
        },
        rpcHandlerManager: { registerHandler: (name: string, handler: (raw: unknown) => Promise<unknown>) => rpc.set(name, handler) },
        sendSessionEvent() {}, sendAgentMessage: send, emitSessionReady() {},
        sendUserMessage() {}, emitMessagesConsumed() {}, emitSteerIndeterminate() {}, syncNativeQueuedMessage() {},
        sendSessionDeath() {}, async flush() {}, close() {}
    } as unknown as ApiSessionClient;
    const end = opts?.end ?? (async () => { throw new Error('Unexpected root archive'); });
    const root = new SharedCodexRoot({ session, workingDirectory: directory } as SessionBootstrapResult, {
        directory, generation: 'test', endpoint: 'mock', settingsFor: () => undefined,
        create: async () => { throw new Error('Unexpected root creation'); },
        end
    } satisfies RootHost);
    cleanups.push(async () => { await root.close(false); await rm(directory, { recursive: true, force: true }); });
    await root.prepare();
    await root.bind('thread', { model: 'mock', thread: { turns: [] } }, false);
    const native = root.client as unknown as {
        initialized: boolean;
        thread: { id: string; historyMode: string; turns: NativeTurn[] };
        queue: Array<{ id: string; clientUserMessageId: string; input: unknown }>;
        notify(method: string, params: unknown): void;
        abandoned(): void;
        serverRequest(request: { id: number; method: string; params: unknown }): void;
    };
    return {
        root, native, rpc, send, metadata: () => metadata, state: () => state, updateState,
        reconnect: () => reconnect?.(),
        emitHubArchived: () => { for (const listener of hubArchivedListeners) listener(); },
        hubArchivedListenerCount: () => hubArchivedListeners.length,
        end,
    };
}

async function completePlan(f: Awaited<ReturnType<typeof fixture>>, status = 'completed') {
    await f.root.applySettings({ collaborationMode: 'plan' });
    const turn = { id: 'plan-turn', status: 'inProgress', items: [{ id: 'plan-item', type: 'plan', text: '# Implement me' }] };
    f.native.thread.turns.push(turn);
    f.native.notify('turn/started', { threadId: 'thread', turn: { id: turn.id } });
    f.native.notify('item/completed', { threadId: 'thread', turnId: turn.id, item: turn.items[0] });
    expect(f.state().codexPlanProposalId).toBeNull();
    turn.status = status;
    f.native.notify('turn/completed', { threadId: 'thread', turn: { id: turn.id, status } });
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ name: 'ExitPlanMode' }), expect.any(String)));
    return codexPlanProposalId('thread', turn.id, 'plan-item');
}

describe('shared conversation rewind', () => {
    async function history() {
        const f = await fixture();
        f.native.thread.historyMode = 'paginated';
        f.native.thread.turns = ['one', 'two', 'three'].map(id => ({ id, status: 'completed', items: [
            { id: `item-${id}`, type: 'userMessage', clientId: id, content: [{ type: 'inputText', text: id }] }
        ] }));
        await f.root.refresh();
        await f.root.activate();
        return f;
    }

    it('reverts the exact native boundary and holds writes until the hub commits', async () => {
        const f = await history();
        expect(f.metadata().capabilities?.conversationHistory?.rewindToMessage).toBe(true);
        const result = await f.rpc.get(RPC_METHODS.RewindConversation)!({ messageLocalId: 'two' }) as {
            success: boolean; rewindToken: string; truncateFromLocalId: string;
        };
        expect(result).toMatchObject({ success: true, truncateFromLocalId: 'two', rewindToken: expect.any(String) });
        expect(f.native.thread.turns.map(t => t.id)).toEqual(['one']);
        await expect(f.rpc.get(RPC_METHODS.SetSessionConfig)!({ model: 'other' })).rejects.toThrow(/rewind/i);
        await expect(f.rpc.get('complete-conversation-rewind')!({ rewindToken: 'wrong' })).rejects.toThrow();
        await f.rpc.get('complete-conversation-rewind')!({ rewindToken: result.rewindToken });
        expect(f.metadata().conversationHistoryTurns).toEqual({ one: 'one' });
        await expect(f.rpc.get(RPC_METHODS.SetSessionConfig)!({ model: 'other' })).resolves.toBeDefined();
    });

    it('rejects queued native input without changing history', async () => {
        const f = await history();
        f.native.queue.push({ id: 'q', clientUserMessageId: 'queued', input: [] });
        await expect(f.rpc.get(RPC_METHODS.RewindConversation)!({ messageLocalId: 'two' })).resolves.toMatchObject({
            success: false, outcome: 'rejected'
        });
        expect(f.native.thread.turns).toHaveLength(3);
    });

    it('rejects a cut inside a steered turn without changing history', async () => {
        const f = await history();
        f.native.thread.turns[1]!.items.push({ id: 'steer', type: 'userMessage', clientId: 'steer', content: [] });
        await f.root.refresh();
        await expect(f.rpc.get(RPC_METHODS.RewindConversation)!({ messageLocalId: 'steer' })).resolves.toMatchObject({
            success: false, outcome: 'rejected'
        });
        expect(f.native.thread.turns).toHaveLength(3);
    });

    it('allows the first user message of a steered turn as an exact native boundary', async () => {
        const f = await history();
        f.native.thread.turns[1]!.items.push({ id: 'steer', type: 'userMessage', clientId: 'steer', content: [] });
        await f.root.refresh();
        expect(await f.rpc.get(RPC_METHODS.RewindConversation)!({ messageLocalId: 'two' })).toMatchObject({ success: true });
        expect(f.native.thread.turns.map(t => t.id)).toEqual(['one']);
    });

    it.each(['legacy', 'missing', 'busy', 'inflight'])('rejects %s preconditions before dispatch', async reason => {
        const f = await history();
        if (reason === 'legacy') f.native.thread.historyMode = 'legacy';
        if (reason === 'busy') f.native.thread.turns[2]!.status = 'inProgress';
        const release = reason === 'inflight' ? f.root.nativeAdmission('turn/start') : () => {};
        expect(await f.rpc.get(RPC_METHODS.RewindConversation)!({ messageLocalId: reason === 'missing' ? 'missing' : 'two' }))
            .toMatchObject({ success: false, outcome: 'rejected' });
        release();
        expect(f.native.thread.turns).toHaveLength(3);
        if (reason === 'busy') expect(f.state().steeringActive).toBe(true);
    });

    it('quarantines a failed or unverifiable native mutation and ignores late projection', async () => {
        const f = await history();
        const request = f.root.client.request.bind(f.root.client);
        vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
            if (method === 'thread/revert') throw new Error('Lost native response');
            return request(method, params);
        });
        await expect(f.rpc.get(RPC_METHODS.RewindConversation)!({ messageLocalId: 'two' })).rejects.toThrow('Lost native');
        expect(f.metadata().conversationHistoryDiverged).toBe(true);
        expect(() => f.root.nativeAdmission('turn/start')).toThrow('rewind');
        f.send.mockClear();
        f.native.notify('item/completed', { threadId: 'thread', turnId: 'three', item: {
            id: 'late', type: 'agentMessage', text: 'stale response'
        } });
        await f.root.refresh();
        expect(f.send).not.toHaveBeenCalled();
    });

    it('supports repeated rewinds, including removing the first turn', async () => {
        const f = await history();
        for (const id of ['three', 'two', 'one']) {
            const result = await f.rpc.get(RPC_METHODS.RewindConversation)!({ messageLocalId: id }) as { rewindToken: string };
            await f.rpc.get('complete-conversation-rewind')!({ rewindToken: result.rewindToken });
        }
        expect(f.native.thread.turns).toEqual([]);
        expect(f.metadata().conversationHistoryTurns).toEqual({});
        expect(f.metadata().conversationHistoryPoints).toEqual({});
    });

    it('rejects active goals and unconfirmed retained history', async () => {
        const f = await history();
        const request = f.root.client.request.bind(f.root.client);
        const spy = vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
            if (method === 'thread/goal/get') return { goal: { status: 'active' } };
            return request(method, params);
        });
        expect(await f.rpc.get(RPC_METHODS.RewindConversation)!({ messageLocalId: 'two' })).toMatchObject({ success: false });
        expect(f.native.thread.turns).toHaveLength(3);
        spy.mockImplementation(async (method, params) => method === 'thread/revert' ? {} : request(method, params));
        await expect(f.rpc.get(RPC_METHODS.RewindConversation)!({ messageLocalId: 'two' })).rejects.toThrow('reconciliation');
        expect(() => f.root.nativeAdmission('turn/start')).toThrow();
    });

    it('reconnects after transport loss during rejected read-only rewind preflight', async () => {
        const f = await history();
        const planId = await completePlan(f);
        const request = f.root.client.request.bind(f.root.client);
        const spy = vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
            if (method === 'thread/goal/get') {
                f.native.initialized = false; f.native.abandoned();
                throw new Error('Lost preflight connection');
            }
            return request(method, params);
        });
        expect(await f.rpc.get(RPC_METHODS.RewindConversation)!({ messageLocalId: 'two' }))
            .toMatchObject({ success: false, outcome: 'rejected' });
        await vi.waitFor(() => expect(f.native.initialized).toBe(true));
        expect(spy.mock.calls.some(([method]) => method === 'thread/resume')).toBe(true);
        expect(f.native.thread.turns).toHaveLength(4);
        spy.mockImplementation(request);
        // Native initialization precedes queue/history recovery. Wait for the
        // final UI control publication before exercising the recovered root.
        await vi.waitFor(() => expect(f.state().codexPlanProposalId).toBe(planId));
        await expect(f.rpc.get(RPC_METHODS.SetSessionConfig)!({ model: 'reconnected' })).resolves.toBeDefined();
    });

    it('retires native approval resolutions arriving while the rewind marker is being written', async () => {
        const f = await history();
        f.native.thread.turns[2]!.status = 'inProgress';
        f.native.serverRequest({ id: 77, method: 'item/tool/requestUserInput', params: {
            threadId: 'thread', turnId: 'three', itemId: 'question', questions: [
                { id: 'q', header: 'Choice', question: 'Choose?', options: [{ label: 'A', description: 'A' }] }
            ]
        } });
        await vi.waitFor(() => expect(Object.keys(f.state().requests ?? {})).toHaveLength(1));
        const id = Object.keys(f.state().requests!)[0]!;
        const begin = SharedRewindBarrier.prototype.begin;
        const spy = vi.spyOn(SharedRewindBarrier.prototype, 'begin').mockImplementation(function(this: SharedRewindBarrier) {
            const writing = begin.call(this);
            // begin synchronously closes admission, then awaits its marker write.
            f.native.notify('serverRequest/resolved', { threadId: 'thread', requestId: 77 });
            return writing;
        });
        try {
            expect(await f.rpc.get(RPC_METHODS.RewindConversation)!({ messageLocalId: 'two' }))
                .toMatchObject({ success: false, outcome: 'rejected' });
        } finally { spy.mockRestore(); }
        expect(f.state().requests).toEqual({});
        expect(f.state().completedRequests?.[id]?.status).toBe('resolved');
        f.native.thread.turns[2]!.status = 'completed';
        await f.root.refresh();
        expect(await f.rpc.get(RPC_METHODS.RewindConversation)!({ messageLocalId: 'two' }))
            .toMatchObject({ success: true });
    });

    it.each([false, true])('recovers new requests received during rejected preflight without reviving resolved ones (%s)', async resolved => {
        const f = await history();
        f.native.thread.turns[2]!.status = 'inProgress';
        const begin = SharedRewindBarrier.prototype.begin;
        const spy = vi.spyOn(SharedRewindBarrier.prototype, 'begin').mockImplementation(function(this: SharedRewindBarrier) {
            const writing = begin.call(this);
            f.native.serverRequest({ id: 88, method: 'item/tool/requestUserInput', params: {
                threadId: 'thread', turnId: 'three', itemId: 'new-question', questions: [
                    { id: 'new-q', header: 'Choice', question: 'New choice?', options: [{ label: 'A', description: 'A' }] }
                ]
            } });
            if (resolved) f.native.notify('serverRequest/resolved', { threadId: 'thread', requestId: 88 });
            return writing;
        });
        try {
            expect(await f.rpc.get(RPC_METHODS.RewindConversation)!({ messageLocalId: 'two' }))
                .toMatchObject({ success: false, outcome: 'rejected' });
        } finally { spy.mockRestore(); }
        expect(Object.values(f.state().requests ?? {})).toHaveLength(resolved ? 0 : 1);
        if (!resolved) {
            expect(Object.values(f.state().requests!)[0]?.toolCallId).toBe('new-question');
            f.native.notify('serverRequest/resolved', { threadId: 'thread', requestId: 88 });
        }
        f.native.thread.turns[2]!.status = 'completed';
        await f.root.refresh();
        expect(await f.rpc.get(RPC_METHODS.RewindConversation)!({ messageLocalId: 'two' }))
            .toMatchObject({ success: true });
    });

    it('refuses cold recovery before connecting a native client after an interrupted rewind', async () => {
        const f = await history();
        await f.rpc.get(RPC_METHODS.RewindConversation)!({ messageLocalId: 'two' });
        await f.root.close(false);
        const replacement = new SharedCodexRoot(f.root.bootstrap, {
            directory: f.root.bootstrap.workingDirectory, generation: 'replacement', endpoint: 'mock',
            settingsFor: () => undefined, create: async () => { throw new Error('Unexpected create'); }, end: async () => {}
        });
        await expect(replacement.prepare()).rejects.toThrow('reconciliation');
        expect(replacement.client.isInitialized()).toBe(false);
    });
});

describe('shared plan actions', () => {
    it('applies remote change_title as metadata.name then lets native terminal rename win', async () => {
        const f = await fixture();
        const item = { id: 'title', type: 'mcpToolCall', server: 'hapi', tool: 'change_title',
            arguments: { title: 'Remote title' }, status: 'completed', result: { content: [], isError: false } };
        f.native.notify('item/completed', { threadId: 'thread', turnId: 'turn', item });
        await vi.waitFor(() => expect(f.metadata().name).toBe('Remote title'));
        f.native.notify('thread/name/updated', { threadId: 'thread', threadName: 'Terminal title' });
        await vi.waitFor(() => expect(f.metadata().name).toBe('Terminal title'));
        await f.root.refresh();
        expect(f.metadata().name).toBe('Terminal title');
    });

    it('preserves content while native turns, mode changes and disconnects withdraw controls', async () => {
        const f = await fixture();
        const id = await completePlan(f);
        expect(f.state().codexPlanProposalId).toBe(id);
        expect(f.state().requests).toEqual({});
        await f.root.applySettings({ collaborationMode: 'default' });
        expect(f.state().codexPlanProposalId).toBeNull();
        await f.root.applySettings({ collaborationMode: 'plan' });
        expect(f.state().codexPlanProposalId).toBe(id);
        f.native.initialized = false; f.native.abandoned();
        expect(f.state().codexPlanProposalId).toBeNull();
        await vi.waitFor(() => expect(f.state().codexPlanProposalId).toBe(id));
        f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'new' } });
        f.native.notify('turn/completed', { threadId: 'thread', turn: { id: 'plan-turn', status: 'completed' } });
        expect(f.state().codexPlanProposalId).toBeNull();
        expect(f.send.mock.calls.some(([message]) => message.input?.plan === '# Implement me')).toBe(true);
    });

    it.each(['failed', 'interrupted'])('does not offer a proposal from a %s turn', async status => {
        const f = await fixture();
        await completePlan(f, status);
        await f.root.refresh();
        expect(f.state().codexPlanProposalId).toBeNull();
    });

    it('uses only the latest root turn when replaying history', async () => {
        const f = await fixture();
        const id = await completePlan(f);
        f.reconnect();
        await f.root.refresh();
        await vi.waitFor(() => expect(f.state().codexPlanProposalId).toBe(id));
        f.native.thread.turns.push({ id: 'new', status: 'completed', items: [] });
        await f.root.refresh();
        expect(f.state().codexPlanProposalId).toBeNull();
        f.native.notify('item/completed', { threadId: 'child', turnId: 'child-turn', item: { id: 'p', type: 'plan', text: 'child' } });
        expect(f.state().codexPlanProposalId).toBeNull();
    });

    it('switches mode and submits once across repeated Web actions and lost replies', async () => {
        const f = await fixture();
        await f.root.activate();
        const id = await completePlan(f);
        const action = () => f.rpc.get(RPC_METHODS.ImplementCodexPlan)!({ planId: id });
        const request = vi.spyOn(f.root.client, 'request');
        expect(await Promise.all([action(), action()])).toEqual([{ ok: true }, { ok: true }]);
        f.reconnect();
        expect(await action()).toEqual({ ok: true });
        expect(request.mock.calls.filter(([method]) => method === 'thread/queue/add')).toHaveLength(1);
        const settingsIndex = request.mock.calls.findIndex(([method]) => method === 'thread/settings/update');
        const queueIndex = request.mock.calls.findIndex(([method]) => method === 'thread/queue/add');
        expect(settingsIndex).toBeLessThan(queueIndex);
        expect(request.mock.calls[settingsIndex][1]).toMatchObject({ collaborationMode: { mode: 'default' } });
        expect(f.native.queue[0]).toMatchObject({ input: [{ type: 'text', text: 'Implement the plan.' }] });
        expect(f.state().codexPlanProposalId).toBeNull();
    });

    it('does not let a slow history snapshot resurrect a plan after native continuation', async () => {
        const f = await fixture();
        await completePlan(f);
        const request = f.root.client.request.bind(f.root.client);
        let release!: () => void;
        const blocked = new Promise<void>(resolve => { release = resolve; });
        let reading!: () => void;
        const started = new Promise<void>(resolve => { reading = resolve; });
        vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
            const result = await request(method, params);
            if (method === 'thread/read' && (params as { includeTurns?: boolean }).includeTurns) {
                reading(); await blocked;
            }
            return result;
        });
        const refresh = f.root.refresh();
        await started;
        f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'terminal-continued' } });
        release(); await refresh;
        expect(f.state().codexPlanProposalId).toBeNull();
    });

    it('does not change mode when native input appears during the action preflight', async () => {
        const f = await fixture();
        await f.root.activate();
        const id = await completePlan(f);
        const request = f.root.client.request.bind(f.root.client);
        const spy = vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
            const result = await request(method, params);
            if (method === 'thread/queue/list') f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'terminal' } });
            return result;
        });
        expect(await f.rpc.get(RPC_METHODS.ImplementCodexPlan)!({ planId: id })).toMatchObject({ ok: false, code: 'stale_plan' });
        expect(spy.mock.calls.some(([method]) => method === 'thread/settings/update')).toBe(false);
        expect(f.native.queue).toHaveLength(0);
    });

    it('rejects stale proposals and native activity arriving during the mode switch', async () => {
        const f = await fixture();
        await f.root.activate();
        const id = await completePlan(f);
        const action = (planId = id) => f.rpc.get(RPC_METHODS.ImplementCodexPlan)!({ planId });
        expect(await action('old')).toMatchObject({ ok: false, code: 'stale_plan' });
        const request = f.root.client.request.bind(f.root.client);
        vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
            const result = await request(method, params);
            if (method === 'thread/settings/update') f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'terminal' } });
            return result;
        });
        expect(await action()).toMatchObject({ ok: false, code: 'stale_plan' });
        expect(f.native.queue).toHaveLength(0);
    });

    it('does not resend an implementation with an unknown queue outcome', async () => {
        const f = await fixture();
        await f.root.activate();
        const id = await completePlan(f);
        const request = f.root.client.request.bind(f.root.client);
        const spy = vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
            const result = await request(method, params);
            // An invalid response schema leaves delivery indeterminate even after acceptance.
            return method === 'thread/queue/add' ? {} : result;
        });
        const action = () => f.rpc.get(RPC_METHODS.ImplementCodexPlan)!({ planId: id });
        expect(await action()).toMatchObject({ ok: false, code: 'indeterminate' });
        f.native.queue = []; // Absence is not proof of cancellation or delivery.
        expect(await action()).toMatchObject({ ok: false, code: 'indeterminate' });
        expect(spy.mock.calls.filter(([method]) => method === 'thread/queue/add')).toHaveLength(1);
    });
});

describe('shared steering availability', () => {
    it('keeps idle sessions online without polling usage or publishing agent-state updates', async () => {
        const f = await fixture();
        const requests = vi.spyOn(f.root.client, 'request');
        const heartbeat = vi.spyOn(f.root.session, 'keepAlive');
        const updates = f.updateState.mock.calls.length;
        vi.useFakeTimers();

        await f.root.activate();
        await vi.advanceTimersByTimeAsync(5 * 60_000);

        expect(heartbeat).toHaveBeenCalled();
        expect(requests).not.toHaveBeenCalled();
        expect(f.updateState).toHaveBeenCalledTimes(updates);
    });

    it('publishes root turn transitions, ignores child turns, and clears on shutdown', async () => {
        const f = await fixture();
        expect(f.state().steeringActive).toBe(false);
        f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'turn' } });
        expect(f.state().steeringActive).toBe(true);
        f.native.notify('turn/completed', { threadId: 'thread', turn: { id: 'old-turn' } });
        expect(f.state().steeringActive).toBe(true);
        f.native.notify('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } });
        expect(f.state().steeringActive).toBe(false);
        f.native.notify('turn/started', { threadId: 'child', turn: { id: 'child-turn' } });
        expect(f.state().steeringActive).toBe(false);
        f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'next' } });
        f.root.stopAccepting();
        expect(f.state().steeringActive).toBe(false);
    });

    it('reconciles native and Hub reconnects without publishing on every refresh', async () => {
        const f = await fixture();
        const updates = f.updateState.mock.calls.length;
        await f.root.refresh(); await f.root.refresh();
        expect(f.updateState).toHaveBeenCalledTimes(updates);
        f.native.thread.turns = [{ id: 'busy', status: 'inProgress', items: [] }];
        f.reconnect();
        await vi.waitFor(() => expect(f.state().steeringActive).toBe(true));
        f.native.initialized = false; f.native.abandoned();
        expect(f.state().steeringActive).toBe(false);
        await vi.waitFor(() => expect(f.state().steeringActive).toBe(true));
        f.native.thread.turns = [{ id: 'busy', status: 'completed', items: [] }];
        f.reconnect();
        await vi.waitFor(() => expect(f.state().steeringActive).toBe(false));
    });

    it('ends the shared root on hub-archived metadata (#1911 C2 / AC6)', async () => {
        const end = vi.fn<RootHost['end']>(async () => {});
        const f = await fixture({ end });
        await f.root.activate();
        expect(f.hubArchivedListenerCount()).toBe(1);
        f.emitHubArchived();
        await vi.waitFor(() => expect(end).toHaveBeenCalledTimes(1));
        expect(end.mock.calls[0]?.[0]).toBe(f.root);
    });

    it('ends when hubArchived was latched before activate (production order, #1911 AC6)', async () => {
        // Bootstrap may refuse CAS / noteHubArchived before Codex bind+activate
        // registers controls — same late-listener miss as other flavors.
        const end = vi.fn<RootHost['end']>(async () => {});
        const f = await fixture({ hubArchived: true, end });
        await f.root.activate();
        await vi.waitFor(() => expect(end).toHaveBeenCalledTimes(1));
    });
});

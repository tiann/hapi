import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentState, Metadata } from '@/api/types';
import type { SessionBootstrapResult } from '@/agent/sessionFactory';
import { SharedCodexRoot, type RootHost } from './root';
import { codexPlanProposalId } from './plan';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';

type NativeTurn = { id: string; status: string; items: unknown[] };

vi.mock('../codexAppServerClient', () => ({
    CodexAppServerClient: class {
        initialized = false;
        usage: unknown = { accountId: 'account', ordinaryUsageAllowed: true, rateLimits: { limitId: 'codex' } };
        async listModels() { return { data: [
            { id: 'mock', model: 'mock', displayName: 'Mock', isDefault: true },
            { id: 'gpt-reserve', model: 'gpt-reserve', hidden: true, defaultReasoningEffort: 'medium',
                supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] }
        ] }; }
        thread = { id: 'thread', turns: [] as NativeTurn[] };
        settings: Record<string, unknown> = { model: 'mock', collaborationMode: { mode: 'default' } };
        queue: Array<{ id: string; clientUserMessageId: unknown; input: unknown }> = [];
        notify?: (method: string, params: unknown) => void;
        abandoned?: () => void;
        setNotificationHandler(handler: typeof this.notify) { this.notify = handler; }
        setTransportAbandonedHandler(handler: (() => void) | null) { this.abandoned = handler ?? undefined; }
        setServerRequestHandler() {}
        async connect() {}
        async initialize() { this.initialized = true; }
        isInitialized() { return this.initialized; }
        async disconnect() { this.initialized = false; }
        async request(method: string, params: Record<string, unknown> = {}) {
            if (method === 'account/rateLimits/read') return this.usage;
            if (method === 'thread/read' || method === 'thread/resume') return { ...this.settings, thread: structuredClone(this.thread) };
            if (method === 'thread/list') return { data: [] };
            if (method === 'thread/queue/list') return { data: this.queue };
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

async function fixture() {
    const directory = await mkdtemp('/tmp/hapi-shared-root-');
    let state: AgentState = { steeringActive: true };
    let metadata: Metadata = { path: directory, host: 'test', flavor: 'codex' };
    let reconnect: (() => void) | null = null;
    const updateState = vi.fn((fn: (value: AgentState) => AgentState) => { state = fn(state); });
    const rpc = new Map<string, (raw: unknown) => Promise<unknown>>();
    const send = vi.fn();
    const session = {
        sessionId: 'sid', getMetadata: () => metadata,
        updateMetadata: (fn: (value: Metadata) => Metadata) => { metadata = fn(metadata); },
        updateAgentState: updateState, keepAlive() {},
        onUserMessage() {}, onCancelQueuedMessage() {}, onRetryQueuedMessage() {},
        onReconnect: (fn: (() => void) | null) => { reconnect = fn; },
        rpcHandlerManager: { registerHandler: (name: string, handler: (raw: unknown) => Promise<unknown>) => rpc.set(name, handler) },
        sendSessionEvent() {}, sendAgentMessage: send, emitSessionReady() {},
        sendUserMessage() {}, emitMessagesConsumed() {}, emitSteerIndeterminate() {}, syncNativeQueuedMessage() {},
        sendSessionDeath() {}, async flush() {}, close() {}
    } as unknown as ApiSessionClient;
    const root = new SharedCodexRoot({ session, workingDirectory: directory } as SessionBootstrapResult, {
        directory, generation: 'test', endpoint: 'mock', settingsFor: () => undefined,
        create: async () => { throw new Error('Unexpected root creation'); },
        end: async () => { throw new Error('Unexpected root archive'); }
    } satisfies RootHost);
    cleanups.push(async () => { await root.close(false); await rm(directory, { recursive: true, force: true }); });
    await root.prepare();
    await root.bind('thread', { model: 'mock', thread: { turns: [] } }, false);
    const native = root.client as unknown as {
        usage: unknown;
        initialized: boolean;
        thread: { id: string; turns: NativeTurn[] };
        queue: Array<{ id: string; clientUserMessageId: string; input: unknown }>;
        notify(method: string, params: unknown): void;
        abandoned(): void;
    };
    return { root, native, rpc, send, metadata: () => metadata, state: () => state, updateState, reconnect: () => reconnect?.() };
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

describe('shared plan actions', () => {
    it('persists remote title tools while retaining native terminal rename events', async () => {
        const f = await fixture();
        const item = { id: 'title', type: 'mcpToolCall', server: 'hapi', tool: 'change_title',
            arguments: { title: 'Remote title' }, status: 'completed', result: { content: [], isError: false } };
        f.native.notify('item/completed', { threadId: 'thread', turnId: 'turn', item });
        await vi.waitFor(() => expect(f.metadata().summary?.text).toBe('Remote title'));
        f.native.notify('thread/name/updated', { threadId: 'thread', threadName: 'Terminal title' });
        await vi.waitFor(() => expect(f.metadata().name).toBe('Terminal title'));
        await f.root.refresh();
        expect(f.metadata().summary?.text).toBe('Remote title');
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
});

describe('manual Luna Reserve', () => {
    const eligible = {
        accountId: 'account', ordinaryUsageAllowed: false,
        rateLimits: { limitId: 'codex', primary: { usedPercent: 100 } },
        rateLimitUpsell: { banner_type: 'luna_reserve', blocked_model_slug: 'mock' },
        rateLimitsByLimitId: { reserve_bucket: { limitName: 'gpt-reserve', secondary: { usedPercent: 73 } } }
    };

    it('offers Reserve only when authorized; reads never change settings, turns, or agent state', async () => {
        const f = await fixture();
        const requests = vi.spyOn(f.root.client, 'request');
        const updates = f.updateState.mock.calls.length;
        expect((await f.root.listModels()).models?.map(model => model.id)).toEqual(['mock']);
        f.native.usage = eligible;
        const result = await f.root.listModels();
        expect(result.models?.map(model => model.id)).toEqual(['mock', 'gpt-reserve']);
        expect(result.usage).toMatchObject({ reserveAvailable: true, reserve: null });
        expect(requests.mock.calls.every(([method]) => method === 'account/rateLimits/read')).toBe(true);
        expect(f.updateState).toHaveBeenCalledTimes(updates);
        f.native.usage = { ...eligible, ordinaryUsageAllowed: true };
        await expect(f.root.applySettings({ model: 'gpt-reserve' })).rejects.toThrow('not available');
        expect(requests.mock.calls.every(([method]) => method === 'account/rateLimits/read')).toBe(true);
    });

    it('waits for native confirmation, retains Reserve after recovery, and never replays input', async () => {
        const f = await fixture();
        f.native.usage = eligible;
        const request = f.root.client.request.bind(f.root.client);
        const requests = vi.spyOn(f.root.client, 'request').mockImplementation((method, params) =>
            method === 'thread/settings/update' ? Promise.resolve({}) : request(method, params));
        let settled = false;
        const switching = f.root.applySettings({ model: 'gpt-reserve' }).then(value => { settled = true; return value; });
        await vi.waitFor(() => expect(requests).toHaveBeenCalledWith('thread/settings/update', expect.objectContaining({ model: 'gpt-reserve' })));
        expect(settled).toBe(false);
        f.native.notify('thread/settings/updated', { threadId: 'thread', threadSettings: {
            model: 'gpt-reserve', effort: 'medium', serviceTier: null,
            collaborationMode: { mode: 'default', settings: { model: 'gpt-reserve', reasoning_effort: 'medium', developer_instructions: null } }
        } });
        expect((await switching).applied.model).toBe('gpt-reserve');
        expect((await f.root.listModels()).usage?.reserve?.secondary?.remainingPercent).toBe(27);
        f.native.usage = { ...eligible, ordinaryUsageAllowed: true, rateLimitUpsell: null };
        expect((await f.root.listModels()).models?.map(model => model.id)).toContain('gpt-reserve');
        expect(requests.mock.calls.filter(([method]) => method === 'thread/settings/update')).toHaveLength(1);
        expect(requests.mock.calls.some(([method]) => method.startsWith('turn/') || method.startsWith('thread/queue/'))).toBe(false);
    });

    it('does not publish rejected settings or let stale eligibility override a native model change', async () => {
        const f = await fixture();
        f.native.usage = eligible;
        const original = f.root.client.request.bind(f.root.client);
        vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
            if (method === 'thread/settings/update') throw new Error('Settings rejected');
            return original(method, params);
        });
        await expect(f.root.applySettings({ model: 'gpt-reserve' })).rejects.toThrow('Settings rejected');
        expect((await f.root.applySettings({})).applied.model).toBe('mock');
        const listing = f.root.listModels();
        f.root.acceptSettings({ model: 'other' });
        expect((await listing).usage).toBeNull();
        expect((await f.root.applySettings({})).applied.model).toBe('other');
    });

    it('expires delayed and queued selections without dispatching a late mutation', async () => {
        const f = await fixture();
        f.native.usage = eligible;
        let release!: () => void;
        const delay = new Promise<void>(resolve => { release = resolve; });
        const original = f.root.client.request.bind(f.root.client);
        const requests = vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
            if (method === 'account/rateLimits/read') await delay;
            return original(method, params);
        });
        vi.useFakeTimers();
        const first = expect(f.root.applySettings({ model: 'gpt-reserve' })).rejects.toThrow('expired');
        const queued = expect(f.root.applySettings({ model: 'other' })).rejects.toThrow('expired');
        await vi.advanceTimersByTimeAsync(28_000);
        await first; await queued;
        await vi.advanceTimersByTimeAsync(5_000);
        release();
        await vi.advanceTimersByTimeAsync(0);
        expect(requests.mock.calls.some(([method]) => method === 'thread/settings/update')).toBe(false);
        expect((await f.root.applySettings({})).applied.model).toBe('mock');
    });

    it('preserves custom plan instructions when selecting Reserve', async () => {
        const f = await fixture();
        f.native.usage = eligible;
        f.root.acceptSettings({ model: 'mock', effort: 'high', collaborationMode: {
            mode: 'plan', settings: { model: 'mock', reasoning_effort: 'high', developer_instructions: 'Custom planning rules' }
        } });
        const requests = vi.spyOn(f.root.client, 'request');
        const switching = f.root.applySettings({ model: 'gpt-reserve' });
        const settings = { model: 'gpt-reserve', effort: 'high', serviceTier: null, collaborationMode: {
            mode: 'plan', settings: { model: 'gpt-reserve', reasoning_effort: 'high', developer_instructions: 'Custom planning rules' }
        } };
        await vi.waitFor(() => expect(requests).toHaveBeenCalledWith('thread/settings/update', { threadId: 'thread', ...settings }));
        f.native.notify('thread/settings/updated', { threadId: 'thread', threadSettings: settings });
        expect((await switching).applied.collaborationMode).toBe('plan');
    });

    it('never offers ChatGPT Reserve to a custom-provider thread', async () => {
        const f = await fixture();
        f.native.usage = eligible;
        f.root.acceptSettings({ model: 'mock', modelProvider: 'custom' });
        const requests = vi.spyOn(f.root.client, 'request');
        expect((await f.root.listModels()).models?.map(model => model.id)).toEqual(['mock']);
        expect(requests).not.toHaveBeenCalled();
        await expect(f.root.applySettings({ model: 'gpt-reserve' })).rejects.toThrow('not available');
    });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentState, Metadata } from '@/api/types';
import type { SessionBootstrapResult } from '@/agent/sessionFactory';
import { SharedCodexRoot, type RootHost } from './root';

vi.mock('../codexAppServerClient', () => ({
    CodexAppServerClient: class {
        initialized = false;
        usage: unknown = { accountId: 'account', ordinaryUsageAllowed: true, rateLimits: { limitId: 'codex' } };
        async listModels() { return { data: [
            { id: 'mock', model: 'mock', displayName: 'Mock', isDefault: true },
            { id: 'gpt-reserve', model: 'gpt-reserve', hidden: true, defaultReasoningEffort: 'medium',
                supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] }
        ] }; }
        thread = { id: 'thread', turns: [] as Array<{ id: string; status: string; items: unknown[] }> };
        notify?: (method: string, params: unknown) => void;
        abandoned?: () => void;
        setNotificationHandler(handler: typeof this.notify) { this.notify = handler; }
        setTransportAbandonedHandler(handler: (() => void) | null) { this.abandoned = handler ?? undefined; }
        setServerRequestHandler() {}
        async connect() {}
        async initialize() { this.initialized = true; }
        isInitialized() { return this.initialized; }
        async disconnect() { this.initialized = false; }
        async request(method: string) {
            if (method === 'account/rateLimits/read') return this.usage;
            if (method === 'thread/settings/update') return {};
            if (method === 'thread/read' || method === 'thread/resume') return { model: 'mock', thread: this.thread };
            if (method === 'thread/list' || method === 'thread/queue/list') return { data: [] };
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
    const session = {
        sessionId: 'sid', getMetadata: () => metadata,
        updateMetadata: (fn: (value: Metadata) => Metadata) => { metadata = fn(metadata); },
        updateAgentState: updateState, keepAlive() {},
        onUserMessage() {}, onCancelQueuedMessage() {}, onRetryQueuedMessage() {},
        onReconnect: (fn: (() => void) | null) => { reconnect = fn; },
        rpcHandlerManager: { registerHandler() {} }, sendSessionEvent() {}, sendAgentMessage() {}, emitSessionReady() {},
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
        thread: { id: string; turns: Array<{ id: string; status: string; items: unknown[] }> };
        notify(method: string, params: unknown): void;
        abandoned(): void;
    };
    return { root, native, state: () => state, updateState, reconnect: () => reconnect?.() };
}

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
        const requests = vi.spyOn(f.root.client, 'request');
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

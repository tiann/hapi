import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentState, Metadata } from '@/api/types';
import type { SessionBootstrapResult } from '@/agent/sessionFactory';
import { SharedCodexRoot, latestCompletedForkCutoff, type RootHost } from './root';
import { codexPlanProposalId } from './plan';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import { asyncQuestionsForItem } from './asyncQuestions';
import { CodexAppServerClient } from '../codexAppServerClient';
import { buildHapiMcpBridge } from '../utils/buildHapiMcpBridge';
import { inheritedResumeTier } from '../utils/serviceTier';

type NativeTurn = { id: string; status: string; items: unknown[] };
type NativeRequest = { id: string | number; method: string; params: unknown };

vi.mock('../codexAppServerClient', () => ({
    CodexAppServerClient: class {
        initialized = false;
        thread = { id: 'thread', turns: [] as NativeTurn[] };
        settings: Record<string, unknown> = { model: 'mock', collaborationMode: { mode: 'default' } };
        queue: Array<{ id: string; clientUserMessageId: unknown; input: unknown }> = [];
        notify?: (method: string, params: unknown) => void;
        abandoned?: () => void;
        serverRequest?: (request: NativeRequest) => void;
        responses: Array<{ id: string | number; result: unknown }> = [];
        setNotificationHandler(handler: typeof this.notify) { this.notify = handler; }
        setTransportAbandonedHandler(handler: (() => void) | null) { this.abandoned = handler ?? undefined; }
        setServerRequestHandler(handler: (request: NativeRequest) => void) { this.serverRequest = handler; }
        respond(id: string | number, result: unknown) { this.responses.push({ id, result }); }
        async connect() {}
        async initialize() { this.initialized = true; }
        isInitialized() { return this.initialized; }
        async disconnect() { this.initialized = false; }
        supportsProviderScopedModels() { return false; }
        supportsEffectiveUltrafastLaunch() { return true; }
        async readConfig() { return { config: { model_provider: 'openai' } }; }
        async listModels() { return { data: [{ id: 'mock', isDefault: true, serviceTiers: [{ id: 'ultrafast' }] }, { id: 'standard-only' }] }; }
        async request(method: string, params: Record<string, unknown> = {}) {
            if (method === 'experimentalFeature/list') return { data: [{ name: 'ultrafast_mode', enabled: true }] };
            if (method === 'thread/read' || method === 'thread/resume') return { ...this.settings, thread: structuredClone(this.thread) };
            if (method === 'thread/list') return { data: [] };
            if (method === 'thread/queue/list') return { data: this.queue };
            if (method === 'thread/settings/update') {
                this.settings = { ...this.settings, ...params,
                    ...('serviceTier' in params && params.serviceTier === null ? { serviceTier: 'default' } : {}) };
                this.notify?.('thread/settings/updated', { threadId: 'thread', threadSettings: this.settings });
                return {};
            }
            if (method === 'thread/queue/update') {
                const entry = this.queue.find(item => item.id === params.queuedSubmissionId);
                if (!entry) throw new Error('queued submission not found');
                entry.input = params.input;
                return { queuedSubmission: entry };
            }
            if (method === 'thread/queue/delete') {
                const index = this.queue.findIndex(item => item.id === params.queuedSubmissionId);
                if (index === -1) return { deleted: false };
                this.queue.splice(index, 1);
                return { deleted: true };
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
vi.mock('../utils/buildHapiMcpBridge', () => ({ buildHapiMcpBridge: vi.fn(async () => ({
    mcpServers: {}, server: { stop() {} }
})) }));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
    try { for (const cleanup of cleanups.splice(0)) await cleanup(); }
    finally { vi.useRealTimers(); }
});

it('does not re-pause confirmed Standard while the Hub acknowledgment still contains the old pending flag', async () => {
    const f = await fixture({ initialTierPending: true, holdTierMetadata: true, bindTier: 'default' });
    expect(f.metadata().codexTierConfirmationPending).toBe(true);
    await f.root.activate();
    expect(f.root.needsTierConfirmation).toBe(false);
    expect(f.sessionReady).toHaveBeenCalled();
    f.submit('confirmed resume input', 'confirmed-resume');
    await vi.waitFor(() => expect(f.native.queue).toHaveLength(1));
});

it.each([false, true])('observes effective attached desktop Ultrafast without overwriting a newer selection (%s)', async superseded => {
    const f = await fixture({ attached: true }); await f.root.activate();
    f.root.acceptSettings({ model: 'mock', serviceTier: 'default' }, true);
    const original = f.root.client.request.bind(f.root.client);
    let entered!: () => void, release!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(f.root.client, 'request').mockImplementationOnce(async (method, params) => {
        if (method === 'thread/resume') { entered(); await held; return { model: 'mock', serviceTier: 'ultrafast' } as never; }
        return original(method, params);
    });
    const keepAlive = vi.spyOn(f.session, 'keepAlive');
    f.native.notify('thread/settings/updated', { threadId: 'thread', threadSettings: { model: 'mock', serviceTier: 'ultrafast' } });
    await reading;
    if (superseded) {
        f.native.settings.serviceTier = 'priority';
        f.native.notify('thread/settings/updated', { threadId: 'thread', threadSettings: f.native.settings });
    }
    release(); await f.drain();
    await vi.waitFor(() => expect((f.root as unknown as { attachedTierObservation?: Promise<void> }).attachedTierObservation).toBeUndefined());
    expect(keepAlive.mock.lastCall?.[2]?.serviceTier).toBe(superseded ? 'fast' : 'ultrafast');
});

it('rejects an early native queue request when activation pauses for confirmation', async () => {
    const f = await fixture();
    const queued = f.root.nativeQueueMutation('thread/queue/start', { threadId: 'thread' });
    const rejected = expect(queued).rejects.toThrow('tier confirmation');
    await f.root.activate({}, false, true);
    await rejected;
    await f.rpc.get(RPC_METHODS.SetSessionConfig)!({ serviceTier: 'standard' });
    expect(f.root.needsTierConfirmation).toBe(false);
});

it('allows cancellation while tier confirmation keeps queued input paused', async () => {
    const f = await fixture();
    await f.root.activate({}, false, true);
    f.native.queue.push({ id: 'cancel-paused', clientUserMessageId: 'cancel-paused', input: [] });
    const request = f.root.client.request.bind(f.root.client);
    vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
        if (method === 'thread/queue/delete') {
            f.native.queue = [];
            return { deleted: true } as never;
        }
        return request(method, params);
    });
    await f.root.nativeQueueMutation('thread/queue/delete', { threadId: 'thread', queuedSubmissionId: 'cancel-paused' });
    expect(f.native.queue).toHaveLength(0);
    expect(f.root.needsTierConfirmation).toBe(true);
    await expect(f.root.nativeQueueMutation('thread/queue/start', { threadId: 'thread' })).rejects.toThrow('tier confirmation');
});

it('rejects a native reorder that waited behind another queue operation before tier recovery', async () => {
    const f = await fixture(); await f.root.activate();
    const original = f.root.client.request.bind(f.root.client);
    let entered!: () => void;
    let release!: () => void;
    const stalledDelete = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const request = vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
        if (method === 'thread/queue/delete') { entered(); await gate; }
        return original(method, params);
    });
    const queue = (f.root as unknown as { queue: { nativeMutation(method: string, params: unknown): Promise<unknown> } }).queue;
    const admitted = vi.spyOn(queue, 'nativeMutation');
    const deletion = f.root.nativeQueueMutation('thread/queue/delete', { threadId: 'thread', queuedSubmissionId: 'absent' });
    await stalledDelete;
    const reorder = f.root.nativeQueueMutation('thread/queue/reorder', { threadId: 'thread', queuedSubmissionIds: ['a', 'b'] });
    const rejected = expect(reorder).rejects.toThrow('tier confirmation');
    await vi.waitFor(() => expect(admitted).toHaveBeenCalledWith('thread/queue/reorder', expect.anything()));
    f.root.beginTierConfirmation();
    release();
    await deletion;
    await rejected;
    expect(request.mock.calls.some(([method]) => method === 'thread/queue/reorder')).toBe(false);
});

it('delivers the original held message when its cancellation cannot be saved', async () => {
    const f = await fixture(); await f.root.activate({}, false, true);
    const queue = (f.root as unknown as { queue: { save(): Promise<void> } }).queue;
    let entered!: () => void;
    let fail!: (error: Error) => void;
    const writing = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>((_, reject) => { fail = reject; });
    vi.spyOn(queue, 'save').mockImplementationOnce(() => { entered(); return blocked; });

    f.submit('original held input', 'held-write-failure');
    const cancellation = f.cancel('held-write-failure');
    await writing;
    try {
        await f.root.applySettings({ serviceTier: 'standard' });
        expect(f.native.queue).toHaveLength(0);
        f.submit('duplicate redelivery', 'held-write-failure');
    } finally { fail(new Error('fixture ledger write failed')); }
    await expect(cancellation).resolves.toBe('indeterminate');
    await vi.waitFor(() => expect(f.native.queue).toHaveLength(1));
    expect(f.native.queue[0].input).toMatchObject([{ text: 'original held input' }]);
});

it('dispatches the explicit retry of a held message after tier recovery without replaying its stale delivery', async () => {
    const f = await fixture();
    await f.root.activate({}, false, true);
    f.submit('cancel this message', 'held-canceled');
    f.submit('keep this message', 'held-kept');
    await expect(f.cancel('held-canceled')).resolves.toBe(true);
    expect((await f.ledger()).entries['held-canceled']).toMatchObject({ state: 'canceled', canceledBeforeAdmission: true });
    await expect(f.cancel('held-canceled')).resolves.toBe(true);
    f.submit('redelivery after the first acknowledgement was lost', 'held-canceled');
    expect(f.native.queue).toHaveLength(0);
    await expect(f.retry('held-canceled', true)).resolves.toBe(true);
    expect((await f.ledger()).entries['held-canceled']).toBeUndefined();
    f.submit('explicit retry text', 'held-canceled');
    await f.root.applySettings({ serviceTier: 'standard' });
    await vi.waitFor(() => expect(f.native.queue.flatMap(entry => entry.input)).toEqual([
        { type: 'text', text: 'keep this message' },
        { type: 'text', text: 'explicit retry text' },
    ]));
});

it('does not publish cold-resume readiness before startup controls are registered', async () => {
    const f = await fixture({ initialTierPending: true, bindTier: 'ultrafast' });
    await f.root.confirmUltrafastLaunch();
    expect(f.sessionReady).not.toHaveBeenCalled();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(f.root, 'initialSettings').mockImplementationOnce(() => held);
    const activating = f.root.activate({ collaborationMode: 'plan' });
    await Promise.resolve();
    expect(f.rpc.has(RPC_METHODS.SetSessionConfig)).toBe(false);
    expect(f.sessionReady).not.toHaveBeenCalled();
    release(); await activating;
    expect(f.rpc.has(RPC_METHODS.SetSessionConfig)).toBe(true);
    expect(f.sessionReady).toHaveBeenCalledTimes(1);
});

it('confirms Standard over a concurrent Fast selection without pinning inherited intent', async () => {
    const f = await fixture({ bindTier: 'priority' });
    f.native.settings.serviceTier = 'priority'; f.root.beginTierConfirmation();
    await f.root.confirmStandardLaunch(false);
    expect(f.root.hasConfirmedStandardTier).toBe(true);
    expect(f.native.settings.serviceTier).toBe('default');
    expect(f.metadata().codexServiceTierExplicit).toBe(false);
    expect(f.sessionReady).not.toHaveBeenCalled();
    await f.root.activate({}, false);
    expect(f.sessionReady).toHaveBeenCalledTimes(1);
});

it('keeps a reconnect snapshot authoritative over the stale control tier', async () => {
    const f = await fixture({ settingsFor: () => ({ model: 'mock', serviceTier: 'priority', collaborationMode: { mode: 'plan' } }) });
    await f.root.activate();
    f.native.settings.serviceTier = 'ultrafast';
    await (f.root as unknown as { reconnect(): Promise<void> }).reconnect();
    expect(f.root.hasUltrafastTier).toBe(true);
});

it('keeps a fresh resume tier authoritative over cached selected settings', async () => {
    const f = await fixture({ bindTier: 'ultrafast', settingsFor: () => ({ model: 'mock', serviceTier: 'priority', collaborationMode: { mode: 'plan' } }) });
    expect(f.root.hasUltrafastTier).toBe(true);
    const request = vi.spyOn(f.root.client, 'request');
    await f.root.confirmUltrafastLaunch();
    expect(request).not.toHaveBeenCalledWith('thread/settings/update', expect.anything());
});

it('projects attached chat updates while a coalesced tier snapshot is stalled', async () => {
    const f = await fixture({ attached: true }); await f.root.activate();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const original = f.root.client.request.bind(f.root.client);
    let reads = 0;
    vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
        if (method === 'thread/resume') { reads++; await held; return { model: 'mock', serviceTier: 'ultrafast' } as never; }
        return original(method, params);
    });
    try {
        for (let i = 0; i < 3; i++) f.native.notify('thread/settings/updated', { threadId: 'thread', threadSettings: { model: 'mock', serviceTier: 'ultrafast' } });
        f.native.notify('thread/name/updated', { threadId: 'thread', threadName: 'Live desktop title' });
        await f.drain();
        expect(f.metadata().name).toBe('Live desktop title');
        expect(reads).toBe(1);
    } finally { release(); }
    await vi.waitFor(() => expect((f.root as unknown as { attachedTierObservation?: Promise<void> }).attachedTierObservation).toBeUndefined());
    expect(reads).toBe(2);
});

it('registers recovery controls when initial Plan confirmation times out after a confirmed Ultrafast launch', async () => {
    const f = await fixture();
    f.root.acceptSettings({ model: 'mock', serviceTier: 'ultrafast' }, true);
    f.native.settings.serviceTier = 'ultrafast';
    const original = f.root.client.request.bind(f.root.client);
    const request = vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
        if (method === 'thread/settings/update') return await new Promise<never>(() => {});
        return original(method, params);
    });
    vi.useFakeTimers();
    try {
        const activating = f.root.activate({ collaborationMode: 'plan' });
        await vi.advanceTimersByTimeAsync(25_000); await activating;
        expect(f.root.needsTierConfirmation).toBe(true);
        expect(f.rpc.has(RPC_METHODS.SetSessionConfig)).toBe(true);
        request.mockRestore();
        await f.rpc.get(RPC_METHODS.SetSessionConfig)!({ serviceTier: 'standard' });
        expect(f.root.needsTierConfirmation).toBe(false);
        expect(f.native.settings.collaborationMode).toMatchObject({ mode: 'plan' });
    } finally { vi.useRealTimers(); }
});

it('keeps an async question answer retryable while tier admission is paused', async () => {
    const f = await fixture(); await f.root.activate();
    f.root.beginTierConfirmation();
    const request = vi.spyOn(f.root.client, 'request');
    await expect((f.root as unknown as { submitQuestionAnswer(thread: string, text: string, id: string): Promise<void> })
        .submitQuestionAnswer('thread', 'answer', 'answer-id')).rejects.toThrow('Retry this answer after recovery');
    expect(request.mock.calls.some(([method]) => method === 'turn/start' || method === 'turn/steer')).toBe(false);
});

it('publishes Ultrafast only after an effective snapshot, not a selected-settings notification', async () => {
    const f = await fixture(); await f.root.activate();
    f.root.acceptSettings({ model: 'mock', serviceTier: 'default' }, true);
    const keepAlive = vi.spyOn(f.session, 'keepAlive');
    f.native.notify('thread/settings/updated', { threadId: 'thread', threadSettings: { model: 'mock', serviceTier: 'ultrafast' } });
    await f.drain();
    (f.root as unknown as { alive(): void }).alive();
    expect(keepAlive.mock.lastCall?.[2]?.serviceTier).toBe('standard');
    expect(f.root.hasUltrafastTier).toBe(true);
    f.root.acceptSettings({ model: 'mock', serviceTier: 'ultrafast' }, true);
    (f.root as unknown as { alive(): void }).alive();
    expect(keepAlive.mock.lastCall?.[2]?.serviceTier).toBe('ultrafast');
});

it.each(['web', 'native'])('does not restore deferred Plan after an explicit Default change through %s', async origin => {
    const f = await fixture(); await f.root.activate({ collaborationMode: 'plan' }, true, true);
    if (origin === 'web') await f.root.applySettings({ collaborationMode: 'default' });
    else await f.root.applyNativeSettings({ collaborationMode: { mode: 'default', settings: { model: 'mock', reasoning_effort: null, developer_instructions: null } } });
    expect(f.root.needsTierConfirmation).toBe(true);
    await f.root.applySettings({ serviceTier: 'standard' });
    expect(f.native.settings.collaborationMode).toMatchObject({ mode: 'default' });
    expect(f.root.needsTierConfirmation).toBe(false);
});

it.each([false, true])('holds input paused during queue preflight and submits it once after recovery (existing batch %s)', async batch => {
    const f = await fixture(); await f.root.activate();
    await f.root.applySettings({ serviceTier: 'standard' });
    if (batch) { f.submit('already queued', 'first'); await vi.waitFor(() => expect(f.native.queue).toHaveLength(1)); }
    const original = f.root.client.request.bind(f.root.client);
    let paused = false;
    const request = vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
        const result = await original(method, params);
        if (!paused && method === 'thread/queue/list') {
            paused = true;
            const root = f.root as unknown as { pauseTierConfirmation: (operationId: number) => void; tierOperationCounter: number };
            root.pauseTierConfirmation(++root.tierOperationCounter);
        }
        return result;
    });
    f.submit('held during preflight', 'blocked');
    await vi.waitFor(async () => {
        expect(f.root.needsTierConfirmation).toBe(true);
        expect((await f.ledger()).entries.blocked).toBeUndefined();
    });
    expect(f.native.queue).toHaveLength(batch ? 1 : 0);
    if (batch) expect(f.native.queue[0].input).toEqual([{ type: 'text', text: 'already queued' }]);
    await f.root.applySettings({ serviceTier: 'standard' });
    const expectedInput = (batch ? ['already queued', 'held during preflight'] : ['held during preflight'])
        .map(text => ({ type: 'text', text }));
    await vi.waitFor(() => expect(f.native.queue.flatMap(entry => entry.input)).toEqual(expectedInput));
    expect(request.mock.calls.filter(([method]) => method === 'thread/queue/add' || method === 'thread/queue/update')).toHaveLength(1);
    expect(request.mock.calls.some(([method]) => method === (batch ? 'thread/queue/update' : 'thread/queue/add'))).toBe(true);
});

it.each(['/new', '/clear'])('defers %s when tier confirmation pauses during the command ledger write', async command => {
    const create = vi.fn(async () => ({ session: { sessionId: 'child' } }) as unknown as SharedCodexRoot);
    const f = await fixture({ create });
    await f.root.activate();
    const root = f.root as unknown as { queue: { save(): Promise<void> }; pauseTierConfirmation(id: number): void; tierOperationCounter: number };
    const save = root.queue.save.bind(root.queue);
    vi.spyOn(root.queue, 'save').mockImplementationOnce(async () => {
        await save();
        root.pauseTierConfirmation(++root.tierOperationCounter);
    });
    f.submit(command, 'command');
    await vi.waitFor(async () => {
        expect(f.root.needsTierConfirmation).toBe(true);
        expect((await f.ledger()).entries.command).toBeUndefined();
    });
    expect(create).not.toHaveBeenCalled();
    expect(f.uncertain).not.toHaveBeenCalled();
    await f.root.applySettings({ serviceTier: 'standard' });
    await vi.waitFor(async () => expect((await f.ledger()).entries.command?.state).toBe('consumed'));
    expect(create).toHaveBeenCalledTimes(1);
});

it.each([false, true])('starts admitted input after tier recovery without re-enqueueing (disconnect %s)', async disconnect => {
    const f = await fixture();
    f.native.thread.turns = [{ id: 'interrupted', status: 'interrupted', items: [] }];
    await f.root.refresh();
    await f.root.activate();
    const original = f.root.client.request.bind(f.root.client);
    let starts = 0;
    const request = vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
        if (method === 'thread/queue/start') {
            if (++starts === 1 && disconnect) {
                f.native.initialized = false;
                f.native.abandoned();
                throw new Error('fixture Codex connection closed before queue start');
            }
            return {};
        }
        const response = await original(method, params);
        if (method === 'thread/queue/add') {
            const root = f.root as unknown as { pauseTierConfirmation: (operationId: number) => void; tierOperationCounter: number };
            root.pauseTierConfirmation(++root.tierOperationCounter);
        }
        return response;
    });
    f.submit('resume accepted input', 'accepted');
    await vi.waitFor(async () => {
        expect(f.root.needsTierConfirmation).toBe(true);
        expect((await f.ledger()).entries.accepted.state).toBe('queued');
    });
    expect(request.mock.calls.some(([method]) => method === 'thread/queue/start')).toBe(false);
    await f.root.applySettings({ serviceTier: 'standard' });
    await vi.waitFor(() => expect(starts).toBe(disconnect ? 2 : 1));
    if (disconnect) expect(request).toHaveBeenCalledWith('thread/read', expect.objectContaining({ threadId: 'thread' }));
    expect(request.mock.calls.filter(([method]) => method === 'thread/queue/add')).toHaveLength(1);
});

it('keeps imported tier intent unset until a tier is chosen', async () => {
    const f = await fixture({ nativeImport: true, bindTier: 'priority' });
    await f.root.activate();
    expect(f.metadata().codexServiceTierExplicit).toBeUndefined();
    await f.root.applySettings({ serviceTier: 'standard' });
    expect(f.metadata().codexServiceTierExplicit).toBe(true);
});

it.each(['priority', null])('activates a cold deferred Fast choice only when the effective tier confirms it (%s)', async bindTier => {
    const f = await fixture({ initialFast: 'deferred', bindTier, expectedResumeTier: 'priority' });
    await f.root.activate({}, true);
    expect(f.root.needsTierConfirmation).toBe(bindTier === null);
    if (bindTier === null) {
        expect(f.metadata()).toMatchObject({ codexPendingServiceTier: 'fast', codexTierConfirmationPending: true });
        expect(f.sessionReady).not.toHaveBeenCalled();
        expect(f.events).toHaveBeenCalledWith({ type: 'message', message: expect.stringContaining('could not confirm the requested Fast tier') });
        await f.root.applySettings({ serviceTier: 'standard' });
        expect(f.metadata().codexConfirmedServiceTier).toBe('standard');
    } else {
        expect(f.metadata().codexConfirmedServiceTier).toBe('fast');
    }
    expect(f.sessionReady).toHaveBeenCalledTimes(1);
    expect(f.metadata().codexPendingServiceTier).toBeUndefined();
});

it('keeps a confirmed Fast choice pending if Codex filters it on cold resume', async () => {
    const f = await fixture({ initialFast: 'confirmed', bindTier: null, expectedResumeTier: 'priority' });
    await f.root.activate();
    expect(f.root.needsTierConfirmation).toBe(true);
    expect(f.metadata()).toMatchObject({
        codexConfirmedServiceTier: 'fast', codexPendingServiceTier: 'fast', codexTierConfirmationPending: true
    });
    expect(f.sessionReady).not.toHaveBeenCalled();
});

it.each(['current', 'latest', 'clear'])('passes Plan into activation and returns the recoverable %s child without a second settings write', async kind => {
    const initialSettings = vi.fn(async () => { throw new Error('second settings write would archive or orphan the recoverable child'); });
    const end = vi.fn(async () => {});
    const create = vi.fn<RootHost['create']>(async () => ({ threadId: 'child', session: { sessionId: 'recoverable-child' }, initialSettings,
        readThread: async () => ({ turns: [{ id: 'completed', status: 'completed', items: [] }] }) } as unknown as SharedCodexRoot));
    const f = await fixture({ create, end });
    f.native.thread.turns = [{ id: 'completed', status: 'completed', items: [] }];
    await f.root.refresh(); await f.root.activate({ collaborationMode: 'plan' });
    const result = kind === 'clear' ? await f.rpc.get(RPC_METHODS.ClearConversation)!({})
        : await f.rpc.get(RPC_METHODS.ForkConversation)!(kind === 'latest' ? { latestCompleted: true } : {});
    expect(result).toMatchObject({ sessionId: 'recoverable-child' });
    expect(create.mock.calls[0][3]).toEqual({ collaborationMode: 'plan' });
    expect(initialSettings).not.toHaveBeenCalled(); expect(end).not.toHaveBeenCalled();
});

async function fixture(opts?: { hubArchived?: boolean; end?: RootHost['end']; create?: RootHost['create'];
    initialTierPending?: boolean; initialFast?: 'deferred' | 'confirmed'; holdTierMetadata?: boolean; bindTier?: string | null; expectedResumeTier?: string;
    startupCatalogConfig?: unknown; nativeImport?: boolean;
    attached?: boolean; settingsFor?: RootHost['settingsFor']; beforeSubscribe?: RootHost['beforeSubscribe']; validateHistory?: RootHost['validateHistory']; initialState?: AgentState }) {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-shared-root-'));
    let state: AgentState = opts?.initialState ?? { steeringActive: true };
    let metadata: Metadata = { path: directory, host: 'test', flavor: 'codex',
        ...(opts?.nativeImport ? {} : { codexServiceTierExplicit: false }),
        ...(opts?.initialTierPending ? { codexTierConfirmationPending: true } : {}),
        ...(opts?.initialFast === 'deferred' ? { codexPendingServiceTier: 'fast' } : {}),
        ...(opts?.initialFast === 'confirmed' ? { codexServiceTierExplicit: true, codexConfirmedServiceTier: 'fast' } : {}) };
    if (opts?.attached) metadata.codexRuntime = { kind: 'attached', bindingId: '11111111-1111-4111-8111-111111111111', state: 'attached' };
    let reconnect: (() => void) | null = null;
    let userMessage: Parameters<ApiSessionClient['onUserMessage']>[0] | undefined;
    let retryMessage: Parameters<ApiSessionClient['onRetryQueuedMessage']>[0] | undefined;
    let cancelMessage: Parameters<ApiSessionClient['onCancelQueuedMessage']>[0] | undefined;
    const updateState = vi.fn((fn: (value: AgentState) => AgentState) => { state = fn(state); });
    const rpc = new Map<string, (raw: unknown) => Promise<unknown>>();
    const send = vi.fn();
    const events = vi.fn();
    const consumed = vi.fn();
    const uncertain = vi.fn();
    const sessionReady = vi.fn();
    const hubArchivedListeners: Array<() => void> = [];
    const session = {
        sessionId: 'sid', getMetadata: () => metadata,
        hubArchived: opts?.hubArchived ?? false,
        updateMetadata: (fn: (value: Metadata) => Metadata) => { const next = fn(metadata); metadata = opts?.holdTierMetadata ? { ...next, codexTierConfirmationPending: metadata.codexTierConfirmationPending } : next; },
        updateAgentState: updateState, keepAlive() {},
        onUserMessage: (callback: Parameters<ApiSessionClient['onUserMessage']>[0]) => { userMessage = callback; },
        onCancelQueuedMessage: (callback: Parameters<ApiSessionClient['onCancelQueuedMessage']>[0]) => { cancelMessage = callback; },
        onRetryQueuedMessage: (callback: Parameters<ApiSessionClient['onRetryQueuedMessage']>[0]) => { retryMessage = callback; },
        onReconnect: (fn: (() => void) | null) => { reconnect = fn; },
        on(event: string, listener: () => void) {
            if (event === 'hub-archived') hubArchivedListeners.push(listener);
        },
        rpcHandlerManager: { registerHandler: (name: string, handler: (raw: unknown) => Promise<unknown>) => rpc.set(name, handler) },
        sendSessionEvent: events, sendAgentMessage: send, emitSessionReady: sessionReady, setSteerDeliveryState: vi.fn(async () => true),
        sendUserMessage() {}, emitMessagesConsumed: consumed, emitSteerIndeterminate: uncertain, syncNativeQueuedMessage() {},
        sendSessionDeath() {}, async flush() {}, async flushMetadata() { return true; }, close() {}
    } as unknown as ApiSessionClient;
    const end = opts?.end ?? (async () => { throw new Error('Unexpected root archive'); });
    const root = new SharedCodexRoot({ session, sessionInfo: { agentState: state }, workingDirectory: directory } as SessionBootstrapResult, {
        directory, generation: 'test', endpoint: 'mock', catalogProvider: opts?.attached ? undefined : 'openai', settingsFor: opts?.settingsFor ?? (() => undefined),
        create: opts?.create ?? (async () => { throw new Error('Unexpected root creation'); }),
        attached: opts?.attached, startupCatalogConfig: opts?.startupCatalogConfig, beforeSubscribe: opts?.beforeSubscribe, validateHistory: opts?.validateHistory,
        end
    } satisfies RootHost);
    cleanups.push(async () => { await root.close(false); await rm(directory, { recursive: true, force: true }); });
    await root.prepare();
    await root.bind('thread', { model: 'mock', ...(opts?.bindTier !== undefined ? { serviceTier: opts.bindTier } : {}), thread: { turns: [] } },
        opts?.attached ?? false, opts?.expectedResumeTier);
    const native = root.client as unknown as {
        initialized: boolean;
        thread: { id: string; turns: NativeTurn[] };
        settings: Record<string, unknown>;
        queue: Array<{ id: string; clientUserMessageId: string; input: unknown }>;
        notify(method: string, params: unknown): void;
        abandoned(): void;
        serverRequest(request: NativeRequest): void;
        responses: Array<{ id: string | number; result: unknown }>;
    };
    return {
session, root, native, rpc, send, events, consumed, uncertain, sessionReady,
        ledger: async () => JSON.parse(await readFile(join(directory, 'sid.queue.json'), 'utf8')),
        retry: (id: string, cancellationAcknowledged?: boolean) => retryMessage?.(id, cancellationAcknowledged),
        cancel: (id: string) => cancelMessage?.(id),
        submit: (text: string, id: string, native = false) => userMessage?.({ role: 'user', content: { type: 'text', text },
            ...(native ? { meta: { isNativeQueuedMessage: true } } : {}) }, id), metadata: () => metadata, state: () => state, updateState,
        drain: () => (root as unknown as { notifications: Promise<void> }).notifications,
        reconnect: () => reconnect?.(),
        emitHubArchived: () => { for (const listener of hubArchivedListeners) listener(); },
        hubArchivedListenerCount: () => hubArchivedListeners.length,
        end,
    };
}

describe('externally attached root', () => {
    it('skips MCP, instructions and initial settings injection, and disables lifecycle actions', async () => {
        const builds = vi.mocked(buildHapiMcpBridge).mock.calls.length;
        const calls = vi.spyOn(CodexAppServerClient.prototype, 'request');
        const beforeSubscribe = vi.fn(async () => {});
        const end = vi.fn(async () => {});
        try {
            const f = await fixture({ attached: true, end, beforeSubscribe });
            await f.root.activate({ permissionMode: 'yolo', model: 'must-not-inject' });
            expect(vi.mocked(buildHapiMcpBridge).mock.calls).toHaveLength(builds);
            expect(beforeSubscribe).toHaveBeenCalledWith('thread');
            expect(calls).toHaveBeenCalledWith('thread/resume', { threadId: 'thread' });
            expect(calls.mock.calls.some(([method]) => ['thread/start', 'thread/settings/update', 'thread/metadata/update'].includes(method))).toBe(false);
            expect(() => f.root.config({})).toThrow('cannot inject');
            expect(f.metadata().capabilities).toMatchObject({ terminal: false, conversationHistory: {
                forkCurrent: false, forkAtMessage: false, forkLatestCompleted: false, rewindToMessage: false } });
            await expect(f.rpc.get(RPC_METHODS.ClearConversation)!({})).rejects.toThrow('owning desktop');
            await expect(f.rpc.get(RPC_METHODS.ForkConversation)!({})).rejects.toThrow('owning desktop');
            await f.root.close(false);
            expect(calls.mock.calls.some(([method]) => ['thread/archive', 'thread/queue/delete', 'turn/interrupt'].includes(method))).toBe(false);
        } finally { calls.mockRestore(); }
    });
    it.each(['thread/reverted', 'thread/rolledBack'])('freezes immediately on native %s', async method => {
        const end = vi.fn(async () => {}); const f = await fixture({ attached: true, end });
        await f.root.activate();
        f.native.notify(method, { threadId: 'thread' });
        expect(f.metadata().conversationHistoryDiverged).toBe(true);
        expect(f.metadata().codexRuntime?.state).toBe('history-changed');
        expect(end).toHaveBeenCalledWith(f.root, false, 'history-changed');
        await expect(f.rpc.get(RPC_METHODS.SetSessionConfig)!({ model: 'changed' })).rejects.toThrow('stopping');
    });
    it.each(['thread/deleted', 'thread/closed'])('detaches on native %s without archiving the engine', async method => {
        const end = vi.fn(async () => {}); const f = await fixture({ attached: true, end });
        await f.root.activate(); f.native.notify(method, { threadId: 'thread' }); await f.drain();
        expect(end).toHaveBeenCalledWith(f.root, false, 'unavailable');
    });
    it('fails closed on unverifiable native history and never reconnects a lost engine', async () => {
        const end = vi.fn(async () => {}); const f = await fixture({ attached: true, end });
        await f.root.activate();
        const request = vi.spyOn(f.root.client, 'request').mockRejectedValue(new Error('read unavailable'));
        await expect(f.root.refresh()).rejects.toThrow('read unavailable');
        expect(end).toHaveBeenCalledWith(f.root, false, 'unavailable');
        request.mockRestore();
        const other = await fixture({ attached: true, end }); await other.root.activate();
        other.native.initialized = false; other.native.abandoned();
        expect(end).toHaveBeenCalledWith(other.root, false, 'unavailable');
        expect(other.native.initialized).toBe(false);
    });
    it('revalidates history before an explicit native control instead of relying only on rewrite notifications', async () => {
        let changed = false;
        const validateHistory = vi.fn(async () => { if (changed) throw new Error('changed history'); });
        const end = vi.fn(async () => {}); const f = await fixture({ attached: true, end, validateHistory });
        await f.root.activate(); changed = true;
        const request = vi.spyOn(f.root.client, 'request');
        await expect(f.rpc.get(RPC_METHODS.SetSessionConfig)!({ model: 'must-not-apply' })).rejects.toThrow('changed history');
        expect(request.mock.calls.some(([method]) => method === 'thread/settings/update')).toBe(false);
        expect(end).toHaveBeenCalledWith(f.root, false, 'unavailable');
    });
});

describe('native readiness after Hub reconnect', () => {
    it('replays readiness only after an activated root revalidates native history', async () => {
        const f = await fixture()
        f.reconnect()
        await vi.waitFor(() => expect(f.state().steeringActive).toBe(false))
        expect(f.sessionReady).not.toHaveBeenCalled()
        await f.root.activate()
        expect(f.sessionReady).toHaveBeenCalledTimes(1)
        f.reconnect()
        await vi.waitFor(() => expect(f.sessionReady).toHaveBeenCalledTimes(2))
    })

    it('does not replay readiness if native revalidation fails', async () => {
        const f = await fixture()
        await f.root.activate()
        const read = vi.spyOn(f.root.client, 'request').mockRejectedValue(new Error('native unavailable'))
        f.reconnect()
        await vi.waitFor(() => expect(read).toHaveBeenCalledWith('thread/read', expect.anything()))
        await new Promise(resolve => setTimeout(resolve, 10))
        expect(f.sessionReady).toHaveBeenCalledTimes(1)
    })
})

describe('async question delivery', () => {
    const item = { type: 'agentMessage', id: 'async_call', delivery: 'async', text: 'Which client?',
        questions: [{ title: 'Which client?', options: ['Web', 'Terminal'] }] };

    it.each([false, true])('routes question answers through native user input (active: %s)', async active => {
        const f = await fixture(); await f.root.activate();
        if (active) f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'turn', status: 'inProgress' } });
        f.native.notify('item/completed', { threadId: 'thread', turnId: 'turn', item });
        await f.drain();
        const q = asyncQuestionsForItem('thread', item)[0];
        expect(f.state().requests![q.id].tool).toBe('request_user_input');
        const method = active ? 'turn/steer' : 'turn/start';
        const original = f.root.client.request.bind(f.root.client);
        const request = vi.spyOn(f.root.client, 'request').mockImplementation(async (name, params) => {
            if (name !== method) return original(name, params);
            const p = params as Record<string, unknown>;
            f.native.notify('item/completed', { threadId: 'thread', turnId: 'answer-turn', item: {
                type: 'userMessage', id: 'native-answer', clientId: p.clientUserMessageId, content: p.input
            } });
            return {};
        });
        try {
            await f.rpc.get(RPC_METHODS.Permission)!({ id: q.id, approved: true, answers: { [q.questionItemId]: ['Web'] } });
            await f.drain();
            expect(request).toHaveBeenCalledWith(method, expect.objectContaining({ threadId: 'thread',
                ...(active ? { expectedTurnId: 'turn' } : {}), input: [expect.objectContaining({ text: expect.stringContaining(q.questionItemId.replaceAll('"', '\\"')) })] }));
            expect(f.native.responses).toEqual([]);
            expect(f.state().requests![q.id]).toBeUndefined();
            expect(f.state().completedRequests![q.id]).toMatchObject({ status: 'resolved' });
        } finally { request.mockRestore(); }
    });

    it('preserves an explicit dismissal when a new root replays the same native thread', async () => {
        const before = await fixture(); await before.root.activate();
        before.native.notify('item/completed', { threadId: 'thread', turnId: 'turn', item });
        await before.drain();
        const q = asyncQuestionsForItem('thread', item)[0];
        await before.rpc.get(RPC_METHODS.Permission)!({ id: q.id, approved: false });
        await before.root.close(false);

        const after = await fixture({ initialState: before.state() });
        after.native.thread.turns = [{ id: 'turn', status: 'completed', items: [item] }];
        await after.root.refresh();
        expect(after.state().requests?.[q.id]).toBeUndefined();
        expect(after.state().completedRequests?.[q.id]).toMatchObject({ status: 'canceled', decision: 'denied' });
    });

    it('retains unanswered questions across turn completion and native reconnect', async () => {
        const f = await fixture(); await f.root.activate();
        f.native.thread.turns = [{ id: 'turn', status: 'completed', items: [item] }];
        f.native.notify('item/completed', { threadId: 'thread', turnId: 'turn', item });
        f.native.notify('turn/completed', { threadId: 'thread', turn: f.native.thread.turns[0] });
        await f.drain();
        const q = asyncQuestionsForItem('thread', item)[0];
        expect(f.state().requests![q.id]).toBeDefined();
        f.native.initialized = false; f.native.abandoned();
        await vi.waitFor(() => expect(f.native.initialized).toBe(true));
        await f.root.refresh();
        expect(f.state().requests![q.id]).toBeDefined();
        expect(f.state().completedRequests?.[q.id]).toBeUndefined();
    });
});

async function startCompaction(f: Awaited<ReturnType<typeof fixture>>, id = 'input', turnId = 'compacting-turn') {
    f.native.queue = [{ id: `native-${id}`, clientUserMessageId: id, input: [{ type: 'text', text: id }] }];
    await f.root.refresh();
    f.native.queue = [];
    // Native removes input before announcing the turn and before recording userMessage.
    f.native.notify('thread/queue/changed', { threadId: 'thread' });
    await vi.waitFor(() => expect(f.uncertain).toHaveBeenCalledWith(expect.arrayContaining([id])));
    const turn = { id: turnId, status: 'inProgress', items: [] };
    f.native.thread.turns.push(turn);
    f.native.notify('turn/started', { threadId: 'thread', turn });
    f.native.notify('item/started', { threadId: 'thread', turnId, item: { id: 'compact', type: 'contextCompaction' } });
    return turn;
}

describe('optional bounded history replay', () => {
    it.each([
        { selected: true, fullHistory: false, bounded: true },
        { selected: true, fullHistory: true, bounded: false },
        { selected: false, fullHistory: false, bounded: false },
    ])('reads the expected history window: %j', async ({ selected, fullHistory, bounded }) => {
        const f = await fixture();
        vi.stubEnv('HAPI_CODEX_LAZY_HISTORY_IDS', selected ? ' other, thread ' : 'other');
        const request = vi.spyOn(f.root.client, 'request');
        request.mockResolvedValueOnce({ thread: { id: 'thread', historyMode: 'paginated' } });
        if (bounded) request.mockResolvedValueOnce({ data: [{ id: 'new', items: [] }], nextCursor: 'older' });
        else request.mockResolvedValueOnce({ data: [{ id: 'old', items: [] }], nextCursor: 'next' })
            .mockResolvedValueOnce({ data: [{ id: 'new', items: [] }] });
        try {
            expect((await f.root.readThread('thread', fullHistory)).turns).toEqual(
                bounded ? [{ id: 'new', items: [] }] : [{ id: 'old', items: [] }, { id: 'new', items: [] }]);
            const calls = request.mock.calls.filter(([method]) => method === 'thread/turns/list');
            expect(calls).toHaveLength(bounded ? 1 : 2);
            expect(calls[0]?.[1]).toMatchObject(bounded
                ? { sortDirection: 'desc', limit: 1, itemsView: 'full' }
                : { sortDirection: 'asc', itemsView: 'full' });
        } finally { request.mockRestore(); vi.unstubAllEnvs(); }
    });

    it('retains legacy history reads when the native thread does not support pagination', async () => {
        const f = await fixture();
        vi.stubEnv('HAPI_CODEX_LAZY_HISTORY_IDS', 'thread');
        const request = vi.spyOn(f.root.client, 'request');
        request.mockResolvedValueOnce({ thread: { id: 'thread' } })
            .mockResolvedValueOnce({ thread: { id: 'thread', turns: [{ id: 'old', items: [] }] } });
        try {
            expect((await f.root.readThread()).turns).toEqual([{ id: 'old', items: [] }]);
            expect(request).toHaveBeenLastCalledWith('thread/read', { threadId: 'thread', includeTurns: true });
        } finally { request.mockRestore(); vi.unstubAllEnvs(); }
    });

    it.each([true, false])('preserves initial subscription and child discovery; selected root: %s', async selected => {
        const f = await fixture();
        vi.stubEnv('HAPI_CODEX_LAZY_HISTORY_IDS', selected ? 'thread' : 'other');
        const request = vi.spyOn(f.root.client, 'request');
        try {
            await f.root.bind('thread', {}, true);
            expect(request).toHaveBeenCalledWith('thread/resume', { threadId: 'thread' });
            expect(request.mock.calls.some(([method]) => method === 'thread/list')).toBe(true);
        } finally { request.mockRestore(); vi.unstubAllEnvs(); }
    });

    it('restores loaded child subscriptions, pending questions and live events after a lazy-root reconnect', async () => {
        const f = await fixture();
        vi.stubEnv('HAPI_CODEX_LAZY_HISTORY_IDS', 'thread');
        const question: NativeRequest = { id: 'native-question', method: 'item/tool/requestUserInput', params: {
            threadId: 'child', turnId: 'child-turn', itemId: 'question',
            questions: [{ id: 'choice', header: 'Choose', question: 'Which?', options: [{ label: 'A', description: 'A' }] }]
        } };
        const original = f.root.client.request.bind(f.root.client);
        const request = vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
            const p = params as Record<string, unknown> | undefined;
            if (method === 'thread/list') return { data: [{ id: 'child', parentThreadId: 'thread' }, { id: 'unloaded', parentThreadId: 'thread' }] };
            if (method === 'thread/loaded/list') return { data: ['child', 'unrelated'] };
            if (method === 'thread/read' && p?.threadId === 'child') return { thread: { id: 'child', parentThreadId: 'thread' } };
            if (method === 'thread/resume' && p?.threadId === 'child') {
                f.native.serverRequest(question);
                f.native.notify('item/completed', { threadId: 'child', turnId: 'child-turn',
                    item: { id: 'answer', type: 'agentMessage', text: 'Child still connected' } });
                return { thread: { id: 'child' } };
            }
            return original(method, params);
        });
        try {
            await f.root.activate();
            f.native.serverRequest(question);
            await vi.waitFor(() => expect(Object.keys(f.state().requests ?? {})).toHaveLength(1));
            const oldKey = Object.keys(f.state().requests!)[0];
            f.native.initialized = false; f.native.abandoned();
            await vi.waitFor(() => expect(request).toHaveBeenCalledWith('thread/resume', { threadId: 'child', excludeTurns: true }));
            await vi.waitFor(() => {
                expect(f.state().completedRequests?.[oldKey]?.status).toBe('canceled');
                expect(Object.keys(f.state().requests ?? {})).toHaveLength(1);
                expect(Object.keys(f.state().requests!)[0]).not.toBe(oldKey);
            });
            const newKey = Object.keys(f.state().requests!)[0];
            await f.rpc.get(RPC_METHODS.Permission)!({ id: newKey, approved: true, answers: { choice: ['A'] } });
            await vi.waitFor(() => expect(f.native.responses).toContainEqual({
                id: 'native-question', result: { answers: { choice: { answers: ['A'] } } }
            }));
            await vi.waitFor(() => expect(f.send).toHaveBeenCalledWith(expect.objectContaining({
                type: 'agent-run-trace', agentId: 'child', message: expect.objectContaining({ type: 'message', message: 'Child still connected' })
            }), expect.any(String)));
            expect(request.mock.calls.some(([method, params]) => method === 'thread/resume'
                && ['unloaded', 'unrelated'].includes(String((params as Record<string, unknown>)?.threadId)))).toBe(false);
            expect(request.mock.calls.some(([method, params]) => method === 'thread/read'
                && (params as Record<string, unknown>)?.includeTurns === true
                && (params as Record<string, unknown>)?.threadId === 'child')).toBe(false);
            expect(request.mock.calls.some(([method, params]) => method === 'thread/turns/list'
                && (params as Record<string, unknown>)?.threadId === 'child')).toBe(false);
        } finally { request.mockRestore(); vi.unstubAllEnvs(); }
    });
});
describe('historical fork during generation', () => {
    it('rejects steered and unknown-status boundaries before creating a child', async () => {
        const create = vi.fn<RootHost['create']>()
        const f = await fixture({ create })
        f.native.thread.turns = [
            { id: 'earlier', status: 'completed', items: [
                { id: 'u1', type: 'userMessage', clientId: 'first', content: [{ type: 'text', text: 'first prompt' }] },
                { id: 'u2', type: 'userMessage', clientId: 'steer' }
            ] },
            { id: 'unknown', status: 'unknown', items: [{ id: 'u3', type: 'userMessage', clientId: 'unknown' }] },
            { id: 'running', status: 'inProgress', items: [] }
        ]
        await f.root.refresh()
        await f.root.activate()
        await expect(f.rpc.get(RPC_METHODS.ForkConversation)!({ messageLocalId: 'steer' })).rejects.toThrow('first message')
        await expect(f.rpc.get(RPC_METHODS.ForkConversation)!({ messageLocalId: 'unknown' })).rejects.toThrow('completed')
        expect(create).not.toHaveBeenCalled()
    })
    it('creates a child before a completed turn without interrupting the active source', async () => {
        const initialSettings = vi.fn(async () => {})
        const create = vi.fn<RootHost['create']>(async () => ({ threadId: 'child',
            session: { sessionId: 'child-session' }, initialSettings }) as unknown as SharedCodexRoot)
        const f = await fixture({ create })
        f.native.thread.turns = [
            { id: 'earlier', status: 'completed', items: [{ id: 'u1', type: 'userMessage', clientId: 'local-earlier' }] },
            { id: 'running', status: 'inProgress', items: [{ id: 'u2', type: 'userMessage', clientId: 'local-running' }] }
        ]
        await f.root.refresh()
        await f.root.activate()
        const request = vi.spyOn(f.root.client, 'request')
        const fork = f.rpc.get(RPC_METHODS.ForkConversation)!
        await expect(fork({ messageLocalId: 'local-earlier' })).resolves.toEqual({ nativeSessionId: 'child', sessionId: 'child-session' })
        expect(create).toHaveBeenCalledWith('thread/fork', expect.objectContaining({ threadId: 'thread', beforeTurnId: 'earlier' }), f.root, { collaborationMode: undefined })
        expect(f.state().steeringActive).toBe(true)
        expect(request.mock.calls.some(([method]) => method === 'turn/interrupt')).toBe(false)
        await expect(fork({})).rejects.toThrow('busy')
        await expect(fork({ messageLocalId: 'local-running' })).rejects.toThrow('completed')
        expect(create).toHaveBeenCalledTimes(1)
    })
})

describe('compaction delivery confirmation', () => {
    async function compactBatch() {
        const f = await fixture();
        await f.root.activate();
        f.submit('BATCH-A', 'original-A');
        await vi.waitFor(() => expect(f.native.queue).toHaveLength(1));
        f.submit('BATCH-B', 'original-B');
        await vi.waitFor(() => expect(f.native.queue[0]?.input).toEqual([
            { type: 'text', text: 'BATCH-A' }, { type: 'text', text: 'BATCH-B' }
        ]));
        const submission = structuredClone(f.native.queue[0]);
        f.native.notify('thread/queue/changed', { threadId: 'thread' });
        await f.drain();
        expect(f.uncertain).not.toHaveBeenCalled();
        f.native.queue = [];
        f.native.notify('thread/queue/changed', { threadId: 'thread' });
        const turn = { id: 'batch-turn', status: 'inProgress', items: [] };
        f.native.thread.turns.push(turn);
        f.native.notify('turn/started', { threadId: 'thread', turn });
        f.native.notify('item/started', { threadId: 'thread', turnId: turn.id,
            item: { id: 'batch-compact', type: 'contextCompaction' } });
        await f.drain();
        expect(f.state().codexCompactionPendingMessageIds).toEqual(['original-A', 'original-B']);
        expect(f.consumed).not.toHaveBeenCalled();
        return { f, submission, turn };
    }

    it('tracks every original batch member during compaction until native acceptance', async () => {
        const { f, submission, turn } = await compactBatch();
        f.native.notify('item/started', { threadId: 'thread', turnId: turn.id,
            item: { id: 'batch-user', type: 'userMessage', clientId: submission.clientUserMessageId, content: submission.input } });
        await f.drain();
        expect(f.consumed).toHaveBeenCalledExactlyOnceWith(['original-A', 'original-B'], { steered: undefined });
        expect(f.state().codexCompactionPendingMessageIds).toEqual([]);
        expect(f.native.queue).toEqual([]);
    });

    it.each(['completed', 'interrupted', 'failed'])('keeps an unaccepted batch uncertain after a %s compaction turn', async status => {
        const { f, turn } = await compactBatch();
        turn.status = status;
        f.native.notify('turn/completed', { threadId: 'thread', turn });
        await f.drain();
        expect(f.state().codexCompactionPendingMessageIds).toEqual([]);
        expect(f.consumed).not.toHaveBeenCalled();
        const ledger = await f.ledger();
        expect(ledger.entries['original-A'].state).toBe('unknown');
        expect(ledger.entries['original-B'].state).toBe('unknown');
        expect(f.native.queue).toEqual([]);
    });

    it('does not turn uncertainty discovered by a cold snapshot into live compaction evidence', async () => {
        const f = await fixture();
        f.native.queue = [{ id: 'old-native', clientUserMessageId: 'old', input: [] }];
        await f.root.refresh();
        f.native.queue = [];
        await f.root.refresh();
        expect(f.uncertain).toHaveBeenCalledWith(['old']);
        f.native.thread.turns.push({ id: 'later', status: 'inProgress', items: [] });
        f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'later' } });
        f.native.notify('item/started', { threadId: 'thread', turnId: 'later', item: { id: 'c', type: 'contextCompaction' } });
        await f.drain();
        expect(f.state()).toMatchObject({ codexCompactionPendingMessageIds: [] });
    });

    it('reports only freshly dequeued input as waiting, without acknowledging or replaying it', async () => {
        const f = await fixture();
        const request = vi.spyOn(f.root.client, 'request');
        const turn = await startCompaction(f);
        await vi.waitFor(() => expect(f.state()).toMatchObject({ codexCompactionPendingMessageIds: ['input'] }));
        expect(f.consumed).not.toHaveBeenCalled();
        expect(request.mock.calls.some(([method]) => method === 'thread/queue/add')).toBe(false);
        f.native.notify('item/started', { threadId: 'thread', turnId: turn.id,
            item: { id: 'user', type: 'userMessage', clientId: 'input', content: [] } });
        await vi.waitFor(() => expect(f.consumed).toHaveBeenCalledWith(['input'], { steered: undefined }));
        expect(f.state()).toMatchObject({ codexCompactionPendingMessageIds: [] });
    });

    it.each(['completed', 'interrupted', 'failed'])('restores uncertainty when the turn is %s without consumption', async status => {
        const f = await fixture();
        const turn = await startCompaction(f);
        await vi.waitFor(() => expect(f.state()).toMatchObject({ codexCompactionPendingMessageIds: ['input'] }));
        turn.status = status;
        f.native.notify('turn/completed', { threadId: 'thread', turn });
        await vi.waitFor(() => expect(f.state()).toMatchObject({ codexCompactionPendingMessageIds: [] }));
        expect(f.consumed).not.toHaveBeenCalled();
        await startCompaction(f, 'next', 'next-turn');
        await vi.waitFor(() => expect(f.state()).toMatchObject({ codexCompactionPendingMessageIds: ['next'] }));
    });

    it('withdraws waiting at compaction completion and ignores child and stale turn events', async () => {
        const f = await fixture();
        const turn = await startCompaction(f);
        await vi.waitFor(() => expect(f.state()).toMatchObject({ codexCompactionPendingMessageIds: ['input'] }));
        for (const [threadId, turnId] of [['child', turn.id], ['thread', 'stale']]) {
            f.native.notify('item/completed', { threadId, turnId, item: { id: 'other', type: 'contextCompaction' } });
        }
        await f.drain();
        expect(f.state()).toMatchObject({ codexCompactionPendingMessageIds: ['input'] });
        f.native.notify('item/completed', { threadId: 'thread', turnId: turn.id, item: { id: 'compact', type: 'contextCompaction' } });
        await vi.waitFor(() => expect(f.state()).toMatchObject({ codexCompactionPendingMessageIds: [] }));
        expect(f.consumed).not.toHaveBeenCalled();
    });

    it('does not keep waiting after native disconnect or stopping', async () => {
        const f = await fixture();
        await f.root.activate();
        await startCompaction(f);
        await vi.waitFor(() => expect(f.state()).toMatchObject({ codexCompactionPendingMessageIds: ['input'] }));
        f.native.initialized = false;
        f.native.abandoned();
        expect(f.state()).toMatchObject({ codexCompactionPendingMessageIds: [] });
        await vi.waitFor(() => expect(f.native.initialized).toBe(true));
        await f.root.refresh();
        expect(f.state()).toMatchObject({ codexCompactionPendingMessageIds: [] });
        f.root.stopAccepting();
        expect(f.state()).toMatchObject({ codexCompactionPendingMessageIds: [] });
    });
});

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

it('keeps the active round measurable when only the hub reconnects', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(1_000_000);
            const f = await fixture();
            await f.root.activate();
            const settled = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); await f.drain(); };
            f.native.notify('thread/tokenUsage/updated', { threadId: 'thread', tokenUsage: { total: { output_tokens: 100 } } });
            vi.setSystemTime(1_001_000);
            await f.drain();
            f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'turn' } });
            vi.setSystemTime(1_002_000);
            await f.drain();
            // Hub-only reconnect: the native turn keeps running without a new
            // turn/started, so the active round's ledger identity, baseline
            // and windows must survive the replay.
            f.reconnect();
            await settled();
            f.native.notify('thread/tokenUsage/updated', { threadId: 'thread', tokenUsage: { total: { output_tokens: 160 } } });
            vi.setSystemTime(1_003_000);
            await f.drain();
            f.native.notify('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } });
            vi.setSystemTime(1_004_000);
            await f.drain();
            expect(f.send.mock.calls.map(([body]) => body).filter(body => body.type === 'turn_duration')).toEqual([
                expect.objectContaining({ durationMs: 2_000, generationMs: 2_000, generationOutputTokens: 60 })
            ]);
        } finally { vi.useRealTimers(); }
    });

    it('keeps timing approval waits out of generation after a reconnect', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(1_000_000);
            const f = await fixture();
            await f.root.activate();
            const settled = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); await f.drain(); };
            f.native.notify('thread/tokenUsage/updated', { threadId: 'thread', tokenUsage: { total: { output_tokens: 100 } } });
            vi.setSystemTime(1_001_000);
            await f.drain();
            // App-server reconnect: the re-armed permissions must keep the
            // host's user-wait hook, or approval waits count as generation.
            await (f.root as unknown as { reconnect(): Promise<void> }).reconnect();
            f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'turn' } });
            vi.setSystemTime(1_002_000);
            await f.drain();
            const question: NativeRequest = { id: 'native-question', method: 'item/tool/requestUserInput', params: {
                threadId: 'thread', turnId: 'turn', itemId: 'question',
                questions: [{ id: 'choice', header: 'Choose', question: 'Which?', options: [{ label: 'A', description: 'A' }] }]
            } };
            vi.setSystemTime(1_003_000);
            f.native.serverRequest(question);
            for (let i = 0; i < 200 && Object.keys(f.state().requests ?? {}).length === 0; i++) await Promise.resolve();
            await f.drain();
            const key = Object.keys(f.state().requests!)[0];
            expect(key, 'approval surfaced after reconnect').toBeTruthy();
            vi.setSystemTime(1_003_500);
            await f.rpc.get(RPC_METHODS.Permission)!({ id: key, approved: true, answers: { choice: ['A'] } });
            await settled();
            f.native.notify('thread/tokenUsage/updated', { threadId: 'thread', tokenUsage: { total: { output_tokens: 160 } } });
            vi.setSystemTime(1_004_000);
            await f.drain();
            f.native.notify('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } });
            vi.setSystemTime(1_005_000);
            await f.drain();
            // 3 s round with a 0.5 s wait for the user: 2.5 s of generation.
            expect(f.send.mock.calls.map(([body]) => body).filter(body => body.type === 'turn_duration')).toEqual([
                expect.objectContaining({ durationMs: 3_000, generationMs: 2_500, generationOutputTokens: 60 })
            ]);
        } finally { vi.useRealTimers(); }
    });

    describe('shared permission modes', () => {
    it('switches native auto-review on and back to the human reviewer', async () => {
        const f = await fixture();
        expect((await f.root.applySettings({ permissionMode: 'autoReview' })).applied.permissionMode).toBe('autoReview');
        expect(f.root.client).toMatchObject({ settings: { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandboxPolicy: { type: 'workspaceWrite' } } });
        expect((await f.root.applySettings({ permissionMode: 'default' })).applied.permissionMode).toBe('default');
        expect(f.root.client).toMatchObject({ settings: { approvalsReviewer: 'user' } });
    });
});

describe('shared plan actions', () => {
    it('allows the Hub retry callback to resubmit input after a failed preflight read', async () => {
        const f = await fixture();
        await f.root.activate();
        const original = f.root.client.request.bind(f.root.client);
        let failLookup = true;
        vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
            if (method === 'thread/queue/list' && failLookup) {
                failLookup = false;
                throw new Error('preflight read failed');
            }
            return original(method, params);
        });
        f.submit('retry me', 'retry-id');
        await vi.waitFor(() => expect(f.events).toHaveBeenCalledWith({
            type: 'message', message: expect.stringContaining('preflight read failed')
        }));
        expect(f.native.queue).toHaveLength(0);
        await expect(f.retry('retry-id')).resolves.toBe(true);
        f.submit('retry me', 'retry-id');
        await vi.waitFor(() => expect(f.native.queue).toHaveLength(1));
        await expect(f.retry('retry-id')).resolves.toBe(false);
    });

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
        await f.root.activate();
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

    it('keeps the completed plan actionable when tier recovery starts before the mode write', async () => {
        const f = await fixture();
        await f.root.activate();
        const id = await completePlan(f);
        const action = () => f.rpc.get(RPC_METHODS.ImplementCodexPlan)!({ planId: id });
        const originalRequest = f.root.client.request.bind(f.root.client);
        const request = vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
            if (method === 'thread/settings/update' && (params as { serviceTier?: string }).serviceTier === 'priority') return {} as never;
            return originalRequest(method, params);
        });
        const originalSettings = f.root.applySettings.bind(f.root);
        let enteredQueue!: () => void;
        const modeQueued = new Promise<void>(resolve => { enteredQueue = resolve; });
        vi.spyOn(f.root, 'applySettings').mockImplementation((raw, onMutation) => {
            if ((raw as { collaborationMode?: string }).collaborationMode === 'default') enteredQueue();
            return originalSettings(raw, onMutation);
        });
        vi.useFakeTimers();
        const uncertainTier = expect(f.root.applySettings({ serviceTier: 'fast' })).rejects.toThrow('confirmation is pending');
        const implementation = expect(action()).resolves.toMatchObject({ ok: false, code: 'unavailable' });
        await modeQueued;
        await vi.advanceTimersByTimeAsync(15_000);
        await Promise.all([uncertainTier, implementation]);
        expect(f.root.needsTierConfirmation).toBe(true);
        expect(f.state().codexPlanProposalId).toBeNull();
        expect(request.mock.calls.filter(([method]) => method === 'thread/settings/update')).toEqual([
            ['thread/settings/update', expect.objectContaining({ serviceTier: 'priority' })]
        ]);
        expect(f.native.queue).toHaveLength(0);
        await f.root.applySettings({ serviceTier: 'standard' });
        expect(f.state().codexPlanProposalId).toBe(id);
        vi.useRealTimers();
        await expect(action()).resolves.toEqual({ ok: true });
        expect(f.native.queue).toHaveLength(1);
    });

    it.each(['implement', 'continue planning', 'native recovery', 'explicit Default'])(
        'restores Plan before offering actions after the mode switch fails (%s)', async nextAction => {
        const f = await fixture({ bindTier: 'ultrafast' });
        f.native.settings.serviceTier = 'ultrafast';
        await f.root.activate({}, true);
        const id = await completePlan(f);
        const action = () => f.rpc.get(RPC_METHODS.ImplementCodexPlan)!({ planId: id });
        const original = f.root.client.request.bind(f.root.client);
        let failEffectiveRead = true;
        const request = vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
            if (method === 'thread/resume' && failEffectiveRead) {
                failEffectiveRead = false;
                expect(f.native.settings.collaborationMode).toMatchObject({ mode: 'default' });
                throw new Error('effective tier read failed after the mode write');
            }
            return original(method, params);
        });
        await expect(action()).resolves.toMatchObject({ ok: false, code: 'unavailable' });
        expect(f.root.needsTierConfirmation).toBe(true);
        expect(f.native.queue).toHaveLength(0);
        expect(f.state().codexPlanProposalId).toBeNull();
        if (nextAction === 'explicit Default') {
            await f.root.applySettings({ serviceTier: 'standard', collaborationMode: 'default' });
            expect(f.native.settings.collaborationMode).toMatchObject({ mode: 'default' });
            expect(f.state().codexPlanProposalId).toBeNull();
            await expect(action()).resolves.toMatchObject({ ok: false, code: 'stale_plan' });
            return;
        }
        if (nextAction === 'native recovery') await f.root.applyNativeSettings({ threadId: 'thread', serviceTier: null });
        else await f.root.applySettings({ serviceTier: 'standard' });
        expect(f.native.settings.collaborationMode).toMatchObject({ mode: 'plan' });
        expect(f.state().codexPlanProposalId).toBe(id);
        if (nextAction === 'continue planning') {
            // Continue planning focuses the composer. Its next input uses the current native mode.
            request.mockClear();
            f.submit('Continue planning from the proposal', 'continued-plan');
            await vi.waitFor(() => expect(f.native.queue).toHaveLength(1));
            expect(request.mock.calls.some(([method]) => method === 'thread/settings/update')).toBe(false);
            expect(f.native.settings.collaborationMode).toMatchObject({ mode: 'plan' });
        } else if (nextAction === 'implement') {
            await expect(action()).resolves.toEqual({ ok: true });
            expect(f.native.queue).toHaveLength(1);
        }
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
        await f.root.activate();
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

describe('shared root Abort retains the native queue (control: no drain/resume policy change)', () => {
    it('turn/interrupts only the active turn and leaves native queued entries intact', async () => {
        const f = await fixture();
        await f.root.activate();
        const requests: Array<{ method: string; params: unknown }> = [];
        const client = f.root.client as unknown as { request(method: string, params?: Record<string, unknown>): Promise<unknown> };
        const origRequest = client.request.bind(client);
        client.request = async (method: string, params: Record<string, unknown> = {}) => {
            requests.push({ method, params });
            if (method === 'turn/interrupt') return {};
            return origRequest(method, params);
        };

        // Drive an active native turn.
        f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'turn-1' } });

        // A native queued submission is pending.
        await client.request('thread/queue/add', { clientUserMessageId: 'm1', input: [{ type: 'text', text: 'hi' }] });
        expect(f.native.queue.length).toBe(1);
        requests.length = 0;

        const abort = f.rpc.get(RPC_METHODS.Abort)!;
        await abort({});

        // Abort must call exactly one method — turn/interrupt for the active
        // turn — and must not drain, reset or replay the native queue.
        expect(requests).toEqual([{ method: 'turn/interrupt', params: { threadId: 'thread', turnId: 'turn-1' } }]);
        expect(f.native.queue.length).toBe(1);

        f.native.notify('turn/completed', { threadId: 'thread', turn: { id: 'turn-1', status: 'interrupted' } });
    });

    it('does not call turn/interrupt when no turn is active, and leaves the queue untouched', async () => {
        const f = await fixture();
        await f.root.activate();
        const requests: Array<{ method: string; params: unknown }> = [];
        const client = f.root.client as unknown as { request(method: string, params?: Record<string, unknown>): Promise<unknown> };
        const origRequest = client.request.bind(client);
        client.request = async (method: string, params: Record<string, unknown> = {}) => {
            requests.push({ method, params });
            if (method === 'turn/interrupt') return {};
            return origRequest(method, params);
        };

        const abort = f.rpc.get(RPC_METHODS.Abort)!;
        await abort({});

        expect(requests.filter((r) => r.method === 'turn/interrupt')).toEqual([]);
        expect(f.native.queue.length).toBe(0);
    });
});


describe('batch history fork boundaries', () => {
    it.each([1, 2])('forks at the first original member of a %i-member accepted batch', async count => {
        const create = vi.fn().mockResolvedValue({
            threadId: 'child-thread', session: { sessionId: 'child-session' }, initialSettings: vi.fn()
        });
        const f = await fixture({ create });
        await f.root.activate();
        f.submit('A', 'original-A');
        await vi.waitFor(() => expect(f.native.queue).toHaveLength(1));
        if (count === 2) {
            vi.spyOn(f.root.client, 'request').mockImplementation(async (method, raw) => {
                const params = raw as Record<string, unknown>;
                if (method === 'thread/queue/list') return { data: f.native.queue } as never;
                if (method === 'thread/queue/update') {
                    f.native.queue[0].input = params.input;
                    return { queuedSubmission: f.native.queue[0] } as never;
                }
                if (method === 'thread/read') return { thread: structuredClone(f.native.thread) } as never;
                throw new Error(`Unexpected ${method}`);
            });
            f.submit('B', 'original-B');
            await vi.waitFor(() => expect(f.native.queue[0].input).toEqual([{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }]));
        }
        const item = { id: 'user-batch', type: 'userMessage',
            clientId: f.native.queue[0].clientUserMessageId, content: f.native.queue[0].input };
        f.native.thread.turns.push({ id: 'batch-turn', status: 'completed', items: [item] });
        f.native.notify('item/completed', { threadId: 'thread', turnId: 'batch-turn', item });
        await vi.waitFor(() => expect(f.metadata().conversationHistoryPoints?.['original-A']).toBe(true));
        const fork = f.rpc.get(RPC_METHODS.ForkConversation)!;
        expect(await fork({ messageLocalId: 'original-A' })).toEqual({ nativeSessionId: 'child-thread', sessionId: 'child-session' });
        expect(create).toHaveBeenCalledWith('thread/fork', expect.objectContaining({ threadId: 'thread', beforeTurnId: 'batch-turn' }), f.root, { collaborationMode: undefined });
        if (count === 2) {
            await expect(fork({ messageLocalId: 'original-B' })).rejects.toThrow('Cannot cut inside');
        }
        item.content = [{ type: 'text', text: 'unmatched native content' }];
        await expect(fork({ messageLocalId: 'original-A' })).rejects.toThrow('Cannot cut inside');
    });
});

describe('latest completed list fork', () => {
    it('uses an inclusive fixed cutoff while later source turns advance', async () => {
        const initialSettings = vi.fn(async () => {});
        const create = vi.fn<RootHost['create']>(async (_method, params) => {
            expect(params).toMatchObject({ threadId: 'thread', lastTurnId: 'two' });
            expect(params).not.toHaveProperty('beforeTurnId');
            f.native.thread.turns.push({ id: 'later', status: 'inProgress', items: [] });
            return { threadId: 'child', session: { sessionId: 'child-session' }, initialSettings,
                readThread: async () => ({ turns: f.native.thread.turns.slice(0, 2) }) } as unknown as SharedCodexRoot;
        });
        const f = await fixture({ create });
        f.native.thread.turns = [
            { id: 'one', status: 'completed', items: [{ id: 'u1', type: 'userMessage', clientId: 'first', content: [{ type: 'text', text: 'first prompt' }] }] },
            { id: 'two', status: 'completed', items: [{ id: 'u2', type: 'userMessage', clientId: 'second', content: [{ type: 'text', text: 'second prompt' }] }] },
            { id: 'three', status: 'inProgress', items: [{ id: 'u3', type: 'userMessage', clientId: 'running', content: [{ type: 'text', text: 'running prompt' }] }] }
        ];
        await f.root.refresh(); await f.root.activate();
        expect(f.metadata().capabilities?.conversationHistory?.forkLatestCompleted).toBe(true);
        const request = vi.spyOn(f.root.client, 'request');
        await expect(f.rpc.get(RPC_METHODS.ForkConversation)!({ latestCompleted: true })).resolves.toEqual({
            nativeSessionId: 'child', sessionId: 'child-session', completedTurnId: 'two'
        });
        expect(create).toHaveBeenCalledTimes(1);
        expect(f.state().steeringActive).toBe(true);
        expect(request.mock.calls.some(([method]) => method === 'turn/interrupt')).toBe(false);
    });
    it('refuses empty, unknown and mixed boundary requests before mutation', async () => {
        const create = vi.fn<RootHost['create']>();
        const f = await fixture({ create }); await f.root.activate();
        const fork = f.rpc.get(RPC_METHODS.ForkConversation)!;
        await expect(fork({ latestCompleted: true })).rejects.toThrow('No completed');
        f.native.thread.turns = [{ id: 'bad', status: 'unknown', items: [] }];
        await expect(fork({ latestCompleted: true })).rejects.toThrow('prefix');
        await expect(fork({ latestCompleted: true, messageLocalId: 'first' })).rejects.toThrow();
        expect(create).not.toHaveBeenCalled();
    });

    it('refuses a live fork when tier recovery starts while reading the history boundary', async () => {
        const create = vi.fn<RootHost['create']>();
        const f = await fixture({ create });
        f.native.thread.turns = [{ id: 'one', status: 'completed', items: [] }];
        await f.root.refresh(); await f.root.activate();
        const original = f.root.client.request.bind(f.root.client);
        let entered!: () => void;
        let release!: () => void;
        const reading = new Promise<void>(resolve => { entered = resolve; });
        const hold = new Promise<void>(resolve => { release = resolve; });
        vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
            if (method === 'thread/read' && params && (params as { includeTurns?: boolean }).includeTurns === true) {
                entered();
                await hold;
            }
            return original(method, params);
        });
        const fork = expect(f.rpc.get(RPC_METHODS.ForkConversation)!({ lastTurnId: 'one' })).rejects.toThrow('Confirm the service tier');
        await reading;
        f.root.beginTierConfirmation();
        release();
        await fork;
        expect(create).not.toHaveBeenCalled();
    });
});

describe('fork preview boundary answers', () => {
    const preview = async (f: Awaited<ReturnType<typeof fixture>>, raw: unknown) =>
        f.rpc.get(RPC_METHODS.PreviewForkBoundary)!(raw);

    it('publishes the forkPreview capability for the shared runtime', async () => {
        const f = await fixture();
        await f.root.refresh(); await f.root.activate();
        expect(f.metadata().capabilities?.conversationHistory?.forkPreview).toBe(true);
    });

    it('answers the latestCompleted preview with the completed cutoff and the excluded user row', async () => {
        const f = await fixture();
        f.native.thread.turns = [
            { id: 'one', status: 'completed', items: [{ id: 'u1', type: 'userMessage', clientId: 'first', content: [{ type: 'text', text: 'first prompt' }] }] },
            { id: 'two', status: 'completed', items: [{ id: 'u2', type: 'userMessage', clientId: 'second', content: [{ type: 'text', text: 'second prompt' }] }] },
            { id: 'three', status: 'inProgress', items: [{ id: 'u3', type: 'userMessage', clientId: 'running', content: [{ type: 'text', text: 'running prompt' }] }] }
        ];
        await f.root.refresh(); await f.root.activate();
        await expect(preview(f, { mode: 'latestCompleted' })).resolves.toEqual({
            nativeTurnId: 'two', cutBeforeLocalId: 'running'
        });
    });

    it('excludes a failed trailing turn from the running-source preview', async () => {
        const f = await fixture();
        f.native.thread.turns = [
            { id: 'one', status: 'completed', items: [{ id: 'u1', type: 'userMessage', clientId: 'first', content: [{ type: 'text', text: 'first prompt' }] }] },
            { id: 'two', status: 'failed', items: [{ id: 'u2', type: 'userMessage', clientId: 'second', content: [{ type: 'text', text: 'second prompt' }] }] },
            { id: 'three', status: 'inProgress', items: [] }
        ];
        await f.root.refresh(); await f.root.activate();
        await expect(preview(f, { mode: 'latestCompleted' })).resolves.toEqual({
            nativeTurnId: 'one', cutBeforeLocalId: 'second'
        });
    });

    it('answers an idle current preview with the last turn and no cut', async () => {
        const f = await fixture();
        f.native.thread.turns = [
            { id: 'one', status: 'completed', items: [{ id: 'u1', type: 'userMessage', clientId: 'first', content: [{ type: 'text', text: 'first prompt' }] }] },
            { id: 'two', status: 'completed', items: [{ id: 'u2', type: 'userMessage', clientId: 'second', content: [{ type: 'text', text: 'second prompt' }] }] }
        ];
        await f.root.refresh(); await f.root.activate();
        await expect(preview(f, { mode: 'current' })).resolves.toEqual({ nativeTurnId: 'two' });
        await expect(preview(f, { mode: 'current' })).resolves.not.toHaveProperty('cutBeforeLocalId');
    });

    it('omits the idle-current pin when the pinned prefix is not terminal', async () => {
        const f = await fixture();
        // A turn left 'unknown' in the rollout (e.g. a crashed write) is not
        // adopted as the running turn, so the idle branch pins the last turn.
        f.native.thread.turns = [
            { id: 'one', status: 'completed', items: [{ id: 'u1', type: 'userMessage', clientId: 'first', content: [{ type: 'text', text: 'first prompt' }] }] },
            { id: 'two', status: 'unknown', items: [{ id: 'u2', type: 'userMessage', clientId: 'second', content: [{ type: 'text', text: 'second prompt' }] }] }
        ];
        await f.root.refresh(); await f.root.activate();
        // Confirm verifies the pinned turn's prefix and would reject this
        // fork; the preview must not answer a pin the confirm refuses. An
        // unpinned answer keeps preview and confirm on the same whole-history
        // cut.
        await expect(preview(f, { mode: 'current' })).resolves.toEqual({});
    });

    it('omits the idle-current pin when a middle turn is unfinished', async () => {
        const f = await fixture();
        f.native.thread.turns = [
            { id: 'one', status: 'completed', items: [{ id: 'u1', type: 'userMessage', clientId: 'first', content: [{ type: 'text', text: 'first prompt' }] }] },
            { id: 'two', status: 'unknown', items: [] },
            { id: 'three', status: 'completed', items: [{ id: 'u3', type: 'userMessage', clientId: 'third', content: [{ type: 'text', text: 'third prompt' }] }] }
        ];
        await f.root.refresh(); await f.root.activate();
        await expect(preview(f, { mode: 'current' })).resolves.toEqual({});
    });

    it('reads the native thread once for a message preview', async () => {
        const f = await fixture();
        f.native.thread.turns = [
            { id: 'one', status: 'completed', items: [{ id: 'u1', type: 'userMessage', clientId: 'first', content: [{ type: 'text', text: 'first prompt' }] }] },
            { id: 'two', status: 'completed', items: [{ id: 'u2', type: 'userMessage', clientId: 'second', content: [{ type: 'text', text: 'second prompt' }] }] }
        ];
        await f.root.refresh(); await f.root.activate();
        const read = vi.spyOn(f.root, 'readThread');
        await preview(f, { mode: 'message', messageLocalId: 'second' });
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('answers an empty thread current preview without a pin', async () => {
        const f = await fixture();
        await f.root.refresh(); await f.root.activate();
        await expect(preview(f, { mode: 'current' })).resolves.toEqual({});
    });

    it('answers a current preview with the completed cut once a turn starts running', async () => {
        const f = await fixture();
        f.native.thread.turns = [
            { id: 'one', status: 'completed', items: [{ id: 'u1', type: 'userMessage', clientId: 'first', content: [{ type: 'text', text: 'first prompt' }] }] },
            { id: 'two', status: 'completed', items: [{ id: 'u2', type: 'userMessage', clientId: 'second', content: [{ type: 'text', text: 'second prompt' }] }] },
            { id: 'three', status: 'inProgress', items: [{ id: 'u3', type: 'userMessage', clientId: 'running', content: [{ type: 'text', text: 'running prompt' }] }] }
        ];
        await f.root.refresh(); await f.root.activate();
        await expect(preview(f, { mode: 'current' })).resolves.toEqual({
            nativeTurnId: 'two', cutBeforeLocalId: 'running'
        });
    });

    it('answers a message preview with the pinned predecessor turn and the excluded row', async () => {
        const f = await fixture();
        f.native.thread.turns = [
            { id: 'one', status: 'completed', items: [{ id: 'u1', type: 'userMessage', clientId: 'first', content: [{ type: 'text', text: 'first prompt' }] }] },
            { id: 'two', status: 'completed', items: [{ id: 'u2', type: 'userMessage', clientId: 'second', content: [{ type: 'text', text: 'second prompt' }] }] }
        ];
        await f.root.refresh(); await f.root.activate();
        await expect(preview(f, { mode: 'message', messageLocalId: 'second' })).resolves.toEqual({
            nativeTurnId: 'one', cutBeforeLocalId: 'second'
        });
    });

    it('answers a first-turn message preview without a pin', async () => {
        const f = await fixture();
        f.native.thread.turns = [
            { id: 'one', status: 'completed', items: [{ id: 'u1', type: 'userMessage', clientId: 'first', content: [{ type: 'text', text: 'first prompt' }] }] },
            { id: 'two', status: 'completed', items: [{ id: 'u2', type: 'userMessage', clientId: 'second', content: [{ type: 'text', text: 'second prompt' }] }] }
        ];
        await f.root.refresh(); await f.root.activate();
        await expect(preview(f, { mode: 'message', messageLocalId: 'first' })).resolves.toEqual({
            cutBeforeLocalId: 'first'
        });
    });

    it('refuses a message preview inside a steered turn or without native history', async () => {
        const f = await fixture();
        f.native.thread.turns = [
            { id: 'one', status: 'completed', items: [
                { id: 'u1', type: 'userMessage', clientId: 'first', content: [{ type: 'text', text: 'first prompt' }] },
                { id: 'u2', type: 'userMessage', clientId: 'steer' }
            ] }
        ];
        await f.root.refresh(); await f.root.activate();
        await expect(preview(f, { mode: 'message', messageLocalId: 'steer' })).rejects.toThrow('first message');
        await expect(preview(f, { mode: 'message', messageLocalId: 'unknown' })).rejects.toThrow('native history point');
    });

    it('refuses a message preview whose completed-turn prefix contains a running turn', async () => {
        const f = await fixture();
        f.native.thread.turns = [
            { id: 'one', status: 'completed', items: [{ id: 'u1', type: 'userMessage', clientId: 'first', content: [{ type: 'text', text: 'first prompt' }] }] },
            { id: 'two', status: 'inProgress', items: [{ id: 'u2', type: 'userMessage', clientId: 'second', content: [{ type: 'text', text: 'second prompt' }] }] }
        ];
        await f.root.refresh(); await f.root.activate();
        // ForkConversation refuses this boundary after the confirm; the
        // preview must refuse it with the same rule before the user commits.
        await expect(preview(f, { mode: 'message', messageLocalId: 'second' }))
            .rejects.toThrow('Historical fork requires a completed turn and history prefix');
    });

    it('skips an empty-text userMessage when naming the excluded boundary row', async () => {
        const f = await fixture();
        f.native.thread.turns = [
            { id: 'one', status: 'completed', items: [{ id: 'u1', type: 'userMessage', clientId: 'first', content: [{ type: 'text', text: 'first prompt' }] }] },
            { id: 'two', status: 'completed', items: [{ id: 'u2', type: 'userMessage', clientId: 'second', content: [{ type: 'text', text: 'second prompt' }] }] },
            { id: 'three', status: 'inProgress', items: [{ id: 'u3', type: 'userMessage', clientId: 'running', content: [] }] }
        ];
        await f.root.refresh(); await f.root.activate();
        // An empty-text user message never reaches the hub transcript, so
        // naming it as the cut would make the hub preview throw
        // 'Fork boundary message not found'.
        await expect(preview(f, { mode: 'latestCompleted' })).resolves.toEqual({ nativeTurnId: 'two' });
    });

    it('names the original member id when the first excluded turn was queued as a batch', async () => {
        const create = vi.fn().mockResolvedValue({
            threadId: 'child-thread', session: { sessionId: 'child-session' }, initialSettings: vi.fn()
        });
        const f = await fixture({ create });
        await f.root.activate();
        f.submit('A', 'original-A');
        await vi.waitFor(() => expect(f.native.queue).toHaveLength(1));
        vi.spyOn(f.root.client, 'request').mockImplementation(async (method, raw) => {
            const params = raw as Record<string, unknown>;
            if (method === 'thread/queue/list') return { data: f.native.queue } as never;
            if (method === 'thread/queue/update') {
                f.native.queue[0].input = params.input;
                return { queuedSubmission: f.native.queue[0] } as never;
            }
            if (method === 'thread/read') return { thread: structuredClone(f.native.thread) } as never;
            throw new Error(`Unexpected ${method}`);
        });
        f.submit('B', 'original-B');
        await vi.waitFor(() => expect(f.native.queue[0].input).toEqual([{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }]));
        const batchItem = { id: 'user-batch', type: 'userMessage',
            clientUserMessageId: f.native.queue[0].clientUserMessageId, content: f.native.queue[0].input };
        // The native client id of a queued batch is synthetic; the hub rows are
        // keyed by the original member ids.
        expect(f.native.queue[0].clientUserMessageId).toMatch(/^hapi-batch-/);
        f.native.thread.turns = [
            { id: 'one', status: 'completed', items: [{ id: 'u1', type: 'userMessage', clientId: 'first', content: [{ type: 'text', text: 'first prompt' }] }] },
            { id: 'two', status: 'inProgress', items: [batchItem] }
        ];
        f.native.notify('item/completed', { threadId: 'thread', turnId: 'two', item: batchItem });
        await vi.waitFor(() => expect(f.metadata().conversationHistoryPoints?.['original-A']).toBe(true));
        await expect(preview(f, { mode: 'latestCompleted' })).resolves.toEqual({
            nativeTurnId: 'one', cutBeforeLocalId: 'original-A'
        });
        // The confirm must accept the same hub row once the batch turn completes.
        f.native.thread.turns[1].status = 'completed';
        const fork = f.rpc.get(RPC_METHODS.ForkConversation)!;
        await expect(fork({ messageLocalId: 'original-A' })).resolves.toEqual({
            nativeSessionId: 'child-thread', sessionId: 'child-session'
        });
        expect(create).toHaveBeenCalledWith('thread/fork', expect.objectContaining({ threadId: 'thread', beforeTurnId: 'two' }), f.root, { collaborationMode: undefined });
    });
});

describe('pinned fork confirm', () => {
    it('forks through the previewed turn while the source advances past it', async () => {
        const initialSettings = vi.fn(async () => {});
        const create = vi.fn<RootHost['create']>(async (_method, params) => {
            expect(params).toMatchObject({ threadId: 'thread', lastTurnId: 'two' });
            return { threadId: 'child', session: { sessionId: 'child-session' }, initialSettings,
                readThread: async () => ({ turns: [{ id: 'one' }, { id: 'two' }] }) } as unknown as SharedCodexRoot;
        });
        const f = await fixture({ create });
        f.native.thread.turns = [
            { id: 'one', status: 'completed', items: [{ id: 'u1', type: 'userMessage', clientId: 'first', content: [{ type: 'text', text: 'first prompt' }] }] },
            { id: 'two', status: 'completed', items: [{ id: 'u2', type: 'userMessage', clientId: 'second', content: [{ type: 'text', text: 'second prompt' }] }] },
            { id: 'three', status: 'inProgress', items: [] }
        ];
        await f.root.refresh(); await f.root.activate();
        await expect(f.rpc.get(RPC_METHODS.ForkConversation)!({ lastTurnId: 'two' })).resolves.toEqual({
            nativeSessionId: 'child', sessionId: 'child-session', completedTurnId: 'two'
        });
        expect(create).toHaveBeenCalledTimes(1);
    });

    it('rejects the confirm when the pinned turn left the native history', async () => {
        const create = vi.fn<RootHost['create']>();
        const f = await fixture({ create });
        f.native.thread.turns = [
            { id: 'one', status: 'completed', items: [{ id: 'u1', type: 'userMessage', clientId: 'first', content: [{ type: 'text', text: 'first prompt' }] }] }
        ];
        await f.root.refresh(); await f.root.activate();
        await expect(f.rpc.get(RPC_METHODS.ForkConversation)!({ lastTurnId: 'gone' }))
            .rejects.toThrow('no longer part of the native history');
        expect(create).not.toHaveBeenCalled();
    });

    it('rejects the confirm when the pinned prefix is no longer complete', async () => {
        const create = vi.fn<RootHost['create']>();
        const f = await fixture({ create });
        f.native.thread.turns = [
            { id: 'one', status: 'unknown', items: [] },
            { id: 'two', status: 'completed', items: [] }
        ];
        await f.root.refresh(); await f.root.activate();
        await expect(f.rpc.get(RPC_METHODS.ForkConversation)!({ lastTurnId: 'two' }))
            .rejects.toThrow('no longer has a completed native history prefix');
        expect(create).not.toHaveBeenCalled();
    });

    it('keeps latestCompleted rejections when the pin is absent', async () => {
        const create = vi.fn<RootHost['create']>();
        const f = await fixture({ create }); await f.root.activate();
        await expect(f.rpc.get(RPC_METHODS.ForkConversation)!({ latestCompleted: true })).rejects.toThrow('No completed');
        expect(create).not.toHaveBeenCalled();
    });
});

describe('completed native prefix validation', () => {
    it('rejects duplicate or unknown native turn identities and states', () => {
        expect(() => latestCompletedForkCutoff([{ id: 'one', status: 'completed' }, { id: 'one', status: 'inProgress' }])).toThrow('ambiguous');
        expect(() => latestCompletedForkCutoff([{ id: 'one', status: 'unknown' }, { id: 'two', status: 'completed' }])).toThrow('prefix');
        expect(() => latestCompletedForkCutoff([{ status: 'completed' }])).toThrow('ambiguous');
    });
    it('uses the last completed turn and excludes a failed trailing turn', () => {
        expect(latestCompletedForkCutoff([{ id: 'one', status: 'completed' }, { id: 'two', status: 'failed' }, { id: 'three', status: 'inProgress' }])).toBe('one');
        expect(latestCompletedForkCutoff([{ id: 'one', status: 'completed' }, { id: 'two', status: 'completed' }])).toBe('two');
    });
});

it('closes a native child whose inherited prefix does not match the requested cutoff', async () => {
    const child = { threadId: 'wrong-child', session: { sessionId: 'wrong-session' },
        readThread: async () => ({ turns: [{ id: 'one' }, { id: 'running' }] }) } as unknown as SharedCodexRoot;
    const end = vi.fn(async () => {});
    const create = vi.fn<RootHost['create']>(async () => child);
    const f = await fixture({ create, end });
    f.native.thread.turns = [{ id: 'one', status: 'completed', items: [] }, { id: 'running', status: 'inProgress', items: [] }];
    await f.root.refresh(); await f.root.activate();
    await expect(f.rpc.get(RPC_METHODS.ForkConversation)!({ latestCompleted: true })).rejects.toThrow('does not match');
    expect(end).toHaveBeenCalledWith(child);
    expect(f.state().steeringActive).toBe(true);
});

describe('completed fork capability snapshot races', () => {
    it('ignores an in-progress snapshot returned after completion and the next turn start', async () => {
        const f = await fixture();
        f.native.thread.turns = [{ id: 'one', status: 'inProgress', items: [] }];
        await f.root.refresh();
        const snapshot = structuredClone(f.native.thread);
        let release!: () => void;
        const read = vi.spyOn(f.root, 'readThread').mockImplementationOnce(async () => {
            await new Promise<void>(resolve => { release = resolve; });
            return snapshot;
        });
        const refresh = f.root.refresh();
        await vi.waitFor(() => expect(release).toBeDefined());
        f.native.notify('turn/completed', { threadId: 'thread', turn: { id: 'one', status: 'completed' } });
        f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'two', status: 'inProgress' } });
        await f.drain();
        expect(f.metadata().capabilities?.conversationHistory?.forkLatestCompleted).toBe(true);
        release(); await refresh; read.mockRestore();
        expect(f.metadata().capabilities?.conversationHistory?.forkLatestCompleted).toBe(true);
        expect(f.state().steeringActive).toBe(true);
    });
    it('rechecks the revision when a queued snapshot metadata updater executes', async () => {
        const f = await fixture();
        f.native.thread.turns = [{ id: 'one', status: 'completed', items: [] }];
        await f.root.refresh();
        f.native.thread.turns = [{ id: 'two', status: 'inProgress', items: [] }];
        const original = f.session.updateMetadata.bind(f.session);
        let delayed: Parameters<ApiSessionClient['updateMetadata']>[0] | undefined;
        const update = vi.spyOn(f.session, 'updateMetadata').mockImplementation(fn => {
            if (!delayed) { delayed = fn; return; }
            return original(fn);
        });
        await f.root.refresh();
        expect(delayed).toBeDefined();
        update.mockRestore();
        f.native.notify('turn/completed', { threadId: 'thread', turn: { id: 'two', status: 'completed' } });
        f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'three', status: 'inProgress' } });
        await f.drain();
        original(delayed!);
        expect(f.metadata().capabilities?.conversationHistory?.forkLatestCompleted).toBe(true);
    });
});

for (const queued of [false, true]) {
    it(`retains completed-history discovery when only turn/start intervenes (${queued ? 'queued updater' : 'delayed read'})`, async () => {
        const f = await fixture();
        expect(f.metadata().capabilities?.conversationHistory?.forkLatestCompleted).toBe(false);
        f.native.thread.turns = [{ id: 'historical', status: 'completed', items: [] }];
        const original = f.session.updateMetadata.bind(f.session);
        let delayed: Parameters<ApiSessionClient['updateMetadata']>[0] | undefined;
        let release!: () => void;
        const spy = queued ? vi.spyOn(f.session, 'updateMetadata').mockImplementation(fn => {
            if (!delayed) { delayed = fn; return; }
            return original(fn);
        }) : vi.spyOn(f.root, 'readThread').mockImplementationOnce(async () => {
            await new Promise<void>(resolve => { release = resolve; });
            return { turns: [{ id: 'historical', status: 'completed', items: [] }] };
        });
        const refresh = f.root.refresh();
        if (queued) await refresh;
        else await vi.waitFor(() => expect(release).toBeDefined());
        spy.mockRestore();
        f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'next', status: 'inProgress' } });
        await f.drain();
        if (queued) original(delayed!);
        else { release(); await refresh; }
        expect(f.metadata().capabilities?.conversationHistory?.forkLatestCompleted).toBe(true);
        expect(f.state().steeringActive).toBe(true);
    });
}

it('splits queued user messages across a settings-changing slash command', async () => {
    const f = await fixture();
    await f.root.activate();
    // All three callbacks fire before the serial work queue reaches them: the
    // batch key for 'done' must be computed when it enqueues (after /plan
    // updated the settings), not when its callback arrived.
    f.submit('hello', 'm1');
    f.submit('/plan', 'cmd');
    f.submit('done', 'm2');
    await vi.waitFor(() => expect(f.native.queue.length).toBe(2));
    const texts = f.native.queue.map(entry => {
        const input = entry.input as Array<{ text?: string }> | { content?: Array<{ text?: string }> } | string;
        const text = Array.isArray(input)
            ? input.map(part => part.text ?? '').join('')
            : typeof input === 'string' ? input : input.content?.map(part => part.text ?? '').join('') ?? '';
        return text;
    });
    // 'done' must NOT merge into 'hello' across the collaboration-mode change.
    expect(texts[0]).not.toContain('done');
    expect(texts[0]).toContain('hello');
    expect(texts[1]).toContain('done');
});


describe('Ultrafast native settings', () => {
    it('preserves the native tier, switches unsupported models to Standard with a system notice', async () => {
        const f = await fixture();
        expect((await f.root.applySettings({ serviceTier: 'ultrafast' })).applied.serviceTier).toBe('ultrafast');
        expect(f.root.client).toMatchObject({ settings: { serviceTier: 'ultrafast' } });
        f.events.mockClear();
        expect((await f.root.applySettings({ model: 'standard-only' })).applied.serviceTier).toBe('standard');
        expect(f.events).toHaveBeenCalledWith({ type: 'message', message: 'Ultrafast was not advertised by the current Codex model catalog; changed to Standard.' });
        expect((await f.root.applySettings({ model: 'standard-only', serviceTier: 'standard' })).applied.serviceTier).toBe('standard');
        expect(f.root.client).toMatchObject({ settings: { serviceTier: 'default' } });
    });

    it('does not announce fallback until the native settings notification confirms it', async () => {
        const f = await fixture();
        f.events.mockClear();
        const original = f.root.client.request.bind(f.root.client);
        const request = vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
            if (method === 'thread/settings/update') return {} as never;
            return original(method, params);
        });
        const applied = f.root.applySettings({ model: 'standard-only', serviceTier: 'ultrafast' });
        await vi.waitFor(() => expect(request).toHaveBeenCalledWith('thread/settings/update', expect.objectContaining({ serviceTier: null })));
        expect(f.events).not.toHaveBeenCalled();
        f.native.notify('thread/settings/updated', { threadId: 'thread', threadSettings: { model: 'standard-only', serviceTier: 'default' } });
        expect((await applied).applied.serviceTier).toBe('standard');
        expect(f.events).toHaveBeenCalledOnce();
        request.mockRestore();
    });

    it('keeps settings unchanged on catalog failure instead of claiming missing entitlement', async () => {
        const f = await fixture();
        f.events.mockClear();
        const catalog = vi.spyOn(f.root.client, 'listModels').mockRejectedValueOnce(new Error('catalog disconnected'));
        const request = vi.spyOn(f.root.client, 'request');
        await expect(f.root.applySettings({ serviceTier: 'ultrafast' })).rejects.toThrow('catalog disconnected');
        expect(request).not.toHaveBeenCalled();
        expect(f.events).not.toHaveBeenCalled();
        catalog.mockRestore();
        request.mockRestore();
    });

    it.each(['catalog discovery', 'confirmation read', 'invalidated confirmation read', 'Standard recheck'])('allows Retry for a queued Ultrafast command after %s fails before mutation', async phase => {
        const f = await fixture(); await f.root.activate();
        const repeated = phase !== 'catalog discovery';
        const fallbackRecheck = phase === 'Standard recheck';
        const invalidated = fallbackRecheck || phase === 'invalidated confirmation read';
        if (repeated) await f.root.applySettings({ serviceTier: 'ultrafast' });
        else vi.spyOn(f.root.client, 'listModels').mockRejectedValueOnce(new Error('catalog disconnected'));
        const original = f.root.client.request.bind(f.root.client);
        let reads = 0;
        const request = vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
            if (method === 'thread/resume' && repeated) {
                reads++;
                if (invalidated && reads === 1) {
                    f.native.notify('thread/settings/updated', { threadId: 'thread', threadSettings: f.native.settings });
                }
                if (fallbackRecheck && reads === 2) f.native.settings.serviceTier = 'default';
                if (reads === (fallbackRecheck ? 3 : invalidated ? 2 : 1)) throw new Error('confirmation read disconnected');
            }
            return original(method, params);
        });
        f.submit('/ultrafast on', 'retry-tier-command');
        await vi.waitFor(async () => expect((await f.ledger()).entries['retry-tier-command']?.state).toBe('rejected'));
        expect(request.mock.calls.some(([method]) => method === 'thread/settings/update')).toBe(false);
        expect(f.uncertain).not.toHaveBeenCalled();
        expect(f.root.needsTierConfirmation).toBe(false);

        expect(await f.cancel('retry-tier-command')).toBe(true);
        expect(await f.retry('retry-tier-command', true)).toBe(true);
        f.submit('/ultrafast on', 'retry-tier-command');
        await vi.waitFor(async () => expect((await f.ledger()).entries['retry-tier-command']?.state).toBe('consumed'));
        expect(request.mock.calls.filter(([method]) => method === 'thread/settings/update')).toHaveLength(repeated && !fallbackRecheck ? 0 : 1);
        if (repeated) expect(reads).toBe(fallbackRecheck ? 4 : invalidated ? 3 : 2);
    });

    it('does not follow a confirmed fallback with an Ultrafast-enabled slash reply', async () => {
        const f = await fixture();
        await f.root.applySettings({ model: 'standard-only', serviceTier: 'standard' });
        f.events.mockClear();
        await (f.root as unknown as { command(text: string): Promise<string | null> }).command('/ultrafast on');
        expect(f.events).toHaveBeenCalledOnce();
        expect(f.events).toHaveBeenCalledWith({ type: 'message', message: 'Ultrafast was not advertised by the current Codex model catalog; changed to Standard.' });
    });

    it('rechecks the latest model after another client changes it during catalog discovery', async () => {
        const f = await fixture();
        let release!: (value: { data: Array<{ id: string; serviceTiers?: Array<{ id: string }> }> }) => void;
        const catalog = vi.spyOn(f.root.client, 'listModels').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
        const pending = f.root.applySettings({ serviceTier: 'ultrafast' });
        await vi.waitFor(() => expect(catalog).toHaveBeenCalledOnce());
        f.native.notify('thread/settings/updated', { threadId: 'thread', threadSettings: { model: 'standard-only', serviceTier: 'default' } });
        release({ data: [{ id: 'mock', serviceTiers: [{ id: 'ultrafast' }] }] });
        expect((await pending).applied).toMatchObject({ model: 'standard-only', serviceTier: 'standard' });
        expect(catalog).toHaveBeenCalledTimes(2);
        catalog.mockRestore();
    });
});

it.each([[null, null], ['default', 'standard'], ['priority', 'fast'], ['ultrafast', 'ultrafast']] as const)('keeps inherited native tier %s for display without pinning it on resume or clear', async (nativeTier, hapiTier) => {
    const f = await fixture();
    const heartbeat = vi.spyOn(f.session, 'keepAlive');
    f.root.acceptSettings({ model: 'mock', serviceTier: nativeTier }, true);
    await f.root.activate();
    expect(heartbeat.mock.calls.at(-1)?.[2]?.serviceTier).toBe(hapiTier);
    expect(f.metadata().codexServiceTierExplicit).toBe(false);
    expect(f.root.freshParams().serviceTier).toBeUndefined();
});
it.each(['standard', 'fast', 'ultrafast'] as const)('persists explicit %s only after native confirmation', async tier => {
    const f = await fixture(); await f.root.activate();
    await f.root.applySettings({ serviceTier: tier });
    expect(f.metadata().codexServiceTierExplicit).toBe(true);
    expect(f.root.freshParams().serviceTier).toBe(tier === 'fast' ? 'priority' : tier === 'standard' ? 'default' : tier);
});
it('accepts null as an explicit Standard reset rather than account inheritance', async () => {
    const f = await fixture(); await f.root.activate();
    await f.root.applySettings({ serviceTier: null });
    expect(f.metadata().codexServiceTierExplicit).toBe(true);
    expect(f.root.freshParams().serviceTier).toBe('default');
});

it.each(['priority', 'flex'])('preserves a newer %s selection during Ultrafast confirmation', async tier => {
    const f = await fixture(); await f.root.activate();
    const original = f.root.client.request.bind(f.root.client);
    const request = vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
        if (method === 'thread/resume' && f.native.settings.serviceTier === 'ultrafast') {
            f.native.settings.serviceTier = tier;
        }
        return original(method, params);
    });
    await expect(f.root.applySettings({ serviceTier: 'ultrafast' })).rejects.toThrow('superseded by a newer tier selection');
    expect(f.native.settings.serviceTier).toBe(tier);
    const writes = request.mock.calls.filter(([method]) => method === 'thread/settings/update');
    expect(writes).toEqual([['thread/settings/update', expect.objectContaining({ serviceTier: 'ultrafast' })]]);
});

it('does not reset a newer Fast selection that the effective snapshot filters before the native turn reply', async () => {
    const f = await fixture(); await f.root.activate();
    const original = f.root.client.request.bind(f.root.client);
    let reads = 0;
    const request = vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
        if (method !== 'thread/resume') return original(method, params);
        if (++reads === 1) {
            f.native.settings.serviceTier = 'priority';
            f.native.notify('thread/settings/updated', { threadId: 'thread', threadSettings: { ...f.native.settings } });
            await f.drain();
        }
        return { ...f.native.settings, serviceTier: null } as never;
    });
    await expect(f.root.applySettings({ serviceTier: 'ultrafast' })).rejects.toThrow('superseded by a newer tier selection');
    expect(reads).toBe(2);
    expect(f.native.settings.serviceTier).toBe('priority');
    expect(request.mock.calls.filter(([method]) => method === 'thread/settings/update'))
        .toEqual([['thread/settings/update', expect.objectContaining({ serviceTier: 'ultrafast' })]]);
});

it('does not reset a native Flex turn accepted while an older Ultrafast read is pending', async () => {
    const f = await fixture(); await f.root.activate();
    const original = f.root.client.request.bind(f.root.client);
    let entered!: () => void;
    let release!: (value: unknown) => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    const snapshot = new Promise<unknown>(resolve => { release = resolve; });
    let held = false;
    const request = vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
        if (method === 'thread/resume' && f.native.settings.serviceTier === 'ultrafast' && !held) {
            held = true; entered();
            return await snapshot as never;
        }
        return original(method, params);
    });
    const update = expect(f.root.applySettings({ serviceTier: 'ultrafast' })).rejects.toThrow('superseded by a newer tier selection');
    await reading;
    const choice = await f.root.prepareNativeTurn({ serviceTier: 'flex' });
    f.native.settings.serviceTier = 'flex';
    await f.root.confirmNativeTurn(choice.params, true, choice.fallbackNotice, choice.generation);
    release({ model: 'mock', serviceTier: 'default' });
    await update;
    expect(f.root.freshParams().serviceTier).toBe('flex');
    expect(request.mock.calls.filter(([method]) => method === 'thread/settings/update'))
        .toEqual([['thread/settings/update', expect.objectContaining({ serviceTier: 'ultrafast' })]]);
});

it('does not write Standard when native Flex is accepted during the fallback recheck', async () => {
    const f = await fixture(); await f.root.activate();
    const original = f.root.client.request.bind(f.root.client);
    let entered!: () => void;
    let release!: () => void;
    const rechecking = new Promise<void>(resolve => { entered = resolve; });
    const holdRecheck = new Promise<void>(resolve => { release = resolve; });
    let reads = 0;
    const request = vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
        if (method === 'thread/resume' && ++reads <= 2) {
            if (reads === 1) f.native.settings.serviceTier = 'default';
            else { entered(); await holdRecheck; }
        }
        return original(method, params);
    });
    const update = expect(f.root.applySettings({ serviceTier: 'ultrafast' })).rejects.toThrow('superseded by a newer tier selection');
    await rechecking;
    const choice = await f.root.prepareNativeTurn({ serviceTier: 'flex' });
    f.native.settings.serviceTier = 'flex';
    await f.root.confirmNativeTurn(choice.params, true, choice.fallbackNotice, choice.generation);
    release();
    await update;
    expect(f.root.freshParams().serviceTier).toBe('flex');
    expect(request.mock.calls.filter(([method]) => method === 'thread/settings/update'))
        .toEqual([['thread/settings/update', expect.objectContaining({ serviceTier: 'ultrafast' })]]);
    expect(f.events).not.toHaveBeenCalledWith({ type: 'message', message: 'Codex did not apply Ultrafast; changed to Standard.' });
});

it.each([false, true])('requires an effective read despite provisional Ultrafast notifications (repeated: %s)', async repeated => {
    const f = await fixture();
    await f.root.activate({}, false, true);
    const original = f.root.client.request.bind(f.root.client);
    let reads = 0;
    vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
        if (method !== 'thread/resume') return original(method, params);
        if (++reads === 1) f.native.settings.serviceTier = 'default';
        const snapshot = await original(method, params);
        if (reads === 2 || repeated && reads % 2 === 0) {
            f.native.notify('thread/settings/updated', { threadId: 'thread', threadSettings: { model: 'mock', serviceTier: 'ultrafast' } });
            expect(f.root.needsTierConfirmation).toBe(true);
            expect(f.sessionReady).not.toHaveBeenCalled();
        }
        return snapshot;
    });
    const update = f.root.applySettings({ serviceTier: 'ultrafast' });
    const fallbackNotice = { type: 'message', message: 'Codex did not apply Ultrafast; changed to Standard.' };
    if (repeated) {
        await expect(update).rejects.toThrow('settings changed during effective tier confirmation');
        expect(f.sessionReady).not.toHaveBeenCalled();
        expect(f.events).not.toHaveBeenCalledWith(fallbackNotice);
    } else {
        await expect(update).resolves.toMatchObject({ applied: { serviceTier: 'standard' } });
        expect(f.sessionReady).toHaveBeenCalledTimes(1);
        expect(f.events).toHaveBeenCalledWith(fallbackNotice);
    }
    expect(reads).toBe(repeated ? 6 : 4);
    expect(f.root.needsTierConfirmation).toBe(repeated);
});

it.each([
    { requested: 'priority', effective: 'priority', ready: true },
    { requested: 'priority', effective: 'flex', ready: false },
    { requested: 'priority', effective: 'default', ready: false },
    { requested: 'flex', effective: 'flex', ready: true },
    { requested: 'flex', effective: 'default', ready: false },
    { requested: undefined, effective: 'default', ready: true },
    { requested: undefined, effective: 'priority', ready: false },
])('restores input after cold resume only for the expected effective tier (%j)', async ({ requested, effective, ready }) => {
    const f = await fixture({ initialTierPending: true });
    await f.root.bind('thread', { model: 'mock', serviceTier: effective, thread: { turns: [] } }, false, requested);
    await f.root.activate();
    expect(f.metadata().codexTierConfirmationPending).toBe(!ready);
    expect(f.root.needsTierConfirmation).toBe(!ready);
    expect(f.sessionReady).toHaveBeenCalledTimes(Number(ready));
});

it('preserves settings when an active thread provider differs from the startup catalog', async () => {
    const f = await fixture();
    f.root.acceptSettings({ model: 'mock', modelProvider: 'other-provider' }, true);
    const request = vi.spyOn(f.root.client, 'request');
    await expect(f.root.applySettings({ serviceTier: 'ultrafast' })).rejects.toThrow('different Codex model provider');
    expect(request.mock.calls.some(([method]) => method === 'thread/settings/update')).toBe(false);
});

it('provides Standard recovery before an attached Ultrafast model change with unknown catalog identity', async () => {
    const f = await fixture({ attached: true }); await f.root.activate();
    f.root.acceptSettings({ model: 'mock', serviceTier: 'ultrafast' }, true);
    const request = vi.spyOn(f.root.client, 'request');
    await expect(f.root.applySettings({ model: 'standard-only' })).rejects.toThrow('Choose Standard in HAPI');
    expect(request.mock.calls.some(([method]) => method === 'thread/settings/update')).toBe(false);
    await f.root.applySettings({ serviceTier: 'standard' });
    expect((await f.root.applySettings({ model: 'standard-only' })).applied).toMatchObject({ model: 'standard-only', serviceTier: 'standard' });
});

it('announces native launch configuration discarding Ultrafast only after confirmed Standard', async () => {
    const f = await fixture(); f.root.acceptSettings({ model: 'mock', serviceTier: null }, true);
    f.events.mockClear(); await f.root.confirmUltrafastLaunch();
    expect(f.events).toHaveBeenCalledWith({ type: 'message', message: 'Codex did not apply Ultrafast; changed to Standard.' });
    expect(f.root.freshParams().serviceTier).toBe('default');
});
it('keeps an actually applied Ultrafast launch without a fallback notice', async () => {
    const f = await fixture(); f.root.acceptSettings({ model: 'mock', serviceTier: 'ultrafast' }, true);
    f.events.mockClear(); await f.root.confirmUltrafastLaunch(); expect(f.events).not.toHaveBeenCalled();
});
it('keeps Standard available when an attached engine cannot verify Ultrafast catalog provenance', async () => {
    const f = await fixture({ attached: true });
    vi.spyOn(f.root.client, 'supportsProviderScopedModels').mockReturnValue(true);
    f.root.acceptSettings({ model: 'mock', modelProvider: 'provider-a', serviceTier: 'priority' }, true);
    await f.root.activate();
    const catalog = vi.spyOn(f.root.client, 'listModels');
    await expect(f.root.applySettings({ serviceTier: 'ultrafast' })).rejects.toThrow('externally attached thread');
    expect(catalog).not.toHaveBeenCalled();
    const result = await f.rpc.get(RPC_METHODS.ListCodexModels)!({ includeHidden: true });
    expect(result).toMatchObject({ success: true, models: [{ id: 'mock', serviceTiers: [] }, { id: 'standard-only' }] });
    expect(catalog).toHaveBeenCalledWith({ includeHidden: true, modelProvider: 'provider-a' });
    expect((await f.root.applySettings({ serviceTier: 'standard' })).applied.serviceTier).toBe('standard');
});

it('withholds chat Ultrafast after the provider configuration changes but retains the models', async () => {
    const f = await fixture({ startupCatalogConfig: { config: {}, layers: [] } });
    await f.root.activate();
    vi.spyOn(f.root.client, 'supportsProviderScopedModels').mockReturnValue(true);
    const config = vi.spyOn(f.root.client, 'readConfig').mockResolvedValue({ config: {}, layers: [] });
    const list = f.rpc.get(RPC_METHODS.ListCodexModels)!;
    expect(await list({})).toMatchObject({ models: [{ id: 'mock', serviceTiers: ['ultrafast'] }, { id: 'standard-only' }] });
    config.mockResolvedValue({ config: { openai_base_url: 'https://changed.example.test' }, layers: [] });
    expect(await list({})).toMatchObject({ models: [{ id: 'mock', serviceTiers: [] }, { id: 'standard-only' }] });
});

it.each(['priority', 'default'])('reconciles a lost native turn reply from an independent %s snapshot without replaying input', async serviceTier => {
    const f = await fixture({ bindTier: 'default' });
    await f.root.activate();
    const original = f.root.client.request.bind(f.root.client);
    let supplySnapshot!: (value: unknown) => void;
    const snapshot = new Promise(resolve => { supplySnapshot = resolve; });
    const request = vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
        if (method === 'thread/resume') return await snapshot as never;
        return original(method, params);
    });
    const prepared = await f.root.prepareNativeTurn({ serviceTier: 'priority' });
    const recovering = f.root.recoverLostNativeTurn({ ...prepared, explicitTier: true });
    expect(f.metadata().codexTierConfirmationPending).toBe(true);
    await expect(f.root.nativeQueueMutation('thread/queue/start', { threadId: 'thread' })).rejects.toThrow('tier confirmation');
    supplySnapshot({ model: 'mock', serviceTier });
    await recovering;
    expect(f.metadata().codexTierConfirmationPending).toBe(serviceTier !== 'priority');
    expect(f.metadata().codexServiceTierExplicit).toBe(serviceTier === 'priority');
    expect(request.mock.calls.map(([method]) => method)).toEqual(['thread/resume']);
});

it.each(['next-model', 'other-model'])('reconciles a model-only Ultrafast turn with a lost reply and %s in the snapshot', async effectiveModel => {
    const f = await fixture({ bindTier: 'ultrafast' });
    await f.root.activate({}, false);
    vi.spyOn(f.root.client, 'listModels').mockResolvedValue({
        data: [{ id: 'next-model', serviceTiers: [{ id: 'ultrafast' }] }]
    } as never);
    const heartbeat = vi.spyOn(f.session, 'keepAlive');
    const prepared = await f.root.prepareNativeTurn({ model: 'next-model' });
    expect(prepared.params.serviceTier).toBeUndefined();
    expect(prepared).toMatchObject({ inheritedUltrafast: true, expectedModel: 'next-model' });
    f.root.acceptSettings({ model: 'next-model', serviceTier: 'ultrafast' }, false);
    f.native.settings = { model: effectiveModel, serviceTier: 'ultrafast' };
    const request = vi.spyOn(f.root.client, 'request');
    await f.root.recoverLostNativeTurn({ ...prepared, explicitTier: false });
    expect(f.root.needsTierConfirmation).toBe(effectiveModel !== 'next-model');
    if (effectiveModel === 'next-model') expect(heartbeat.mock.lastCall?.[2]?.serviceTier).toBe('ultrafast');
    expect(f.metadata().codexServiceTierExplicit).toBe(false);
    expect(f.events).toHaveBeenCalledWith({ type: 'message', message: expect.stringContaining('delivery is unconfirmed') });
    expect(request.mock.calls.map(([method]) => method)).toEqual(effectiveModel === 'next-model'
        ? ['thread/resume', 'experimentalFeature/list'] : ['thread/resume']);
});

it.each(['thread/resume', 'experimentalFeature/list'])('preserves explicit Ultrafast and retries lost-reply recovery after a notification during %s', async interruptedRead => {
    const f = await fixture({ bindTier: 'ultrafast' });
    await f.root.activate({}, true);
    f.session.updateMetadata(metadata => ({ ...metadata, codexConfirmedServiceTier: undefined }));
    vi.spyOn(f.root.client, 'listModels').mockResolvedValue({
        data: [{ id: 'next-model', serviceTiers: [{ id: 'ultrafast' }] }]
    } as never);
    const heartbeat = vi.spyOn(f.session, 'keepAlive');
    const prepared = await f.root.prepareNativeTurn({ model: 'next-model' });
    f.native.settings = { model: 'next-model', serviceTier: 'ultrafast' };
    f.native.notify('thread/settings/updated', { threadId: 'thread', threadSettings: f.native.settings });
    await f.root.refresh();
    expect(heartbeat.mock.lastCall?.[2]).not.toHaveProperty('serviceTier');
    expect(f.metadata().codexPendingServiceTier).toBeUndefined();

    const original = f.root.client.request.bind(f.root.client);
    let invalidated = false;
    const request = vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
        if (!invalidated && method === interruptedRead) {
            invalidated = true;
            expect(f.metadata().codexPendingServiceTier).toBe('ultrafast');
            f.native.notify('thread/settings/updated', { threadId: 'thread', threadSettings: f.native.settings });
        }
        return original(method, params);
    });
    await f.root.recoverLostNativeTurn({ ...prepared, explicitTier: false });
    expect(f.root.needsTierConfirmation).toBe(false);
    expect(f.metadata()).toMatchObject({ codexServiceTierExplicit: true, codexConfirmedServiceTier: 'ultrafast' });
    expect(f.metadata().codexPendingServiceTier).toBeUndefined();
    expect(heartbeat.mock.lastCall?.[2]?.serviceTier).toBe('ultrafast');
    expect(request.mock.calls.filter(([method]) => method === 'thread/resume')).toHaveLength(2);
    expect(request.mock.calls.some(([method]) => method === 'turn/start')).toBe(false);
});

it('reconciles a lost reply when the native turn changes model and explicitly repeats Ultrafast', async () => {
    const f = await fixture({ bindTier: 'ultrafast' });
    await f.root.activate({}, true);
    vi.spyOn(f.root.client, 'listModels').mockResolvedValue({
        data: [{ id: 'next-model', serviceTiers: [{ id: 'ultrafast' }] }]
    } as never);
    const turn = await f.root.prepareNativeTurn({ model: 'next-model', serviceTier: 'ultrafast' });
    expect(turn).toMatchObject({ previousTier: 'ultrafast', previousModel: 'mock', expectedModel: 'next-model' });
    f.native.settings = { model: 'next-model', serviceTier: 'ultrafast' };
    await f.root.recoverLostNativeTurn({ ...turn, explicitTier: true });
    expect(f.root.needsTierConfirmation).toBe(false);
    expect(f.metadata()).toMatchObject({ codexConfirmedServiceTier: 'ultrafast', codexServiceTierExplicit: true });
    expect(f.events).toHaveBeenCalledWith({ type: 'message', message: expect.stringContaining('delivery is unconfirmed') });
});

it.each(['ultrafast', 'default', null])('keeps saved Ultrafast until the lost Standard fallback is confirmed (%s)', async effectiveTier => {
    const f = await fixture({ bindTier: 'ultrafast' });
    await f.root.activate({}, true);
    f.session.updateMetadata(metadata => ({ ...metadata, codexConfirmedServiceTier: undefined }));
    const heartbeat = vi.spyOn(f.session, 'keepAlive');
    const turn = await f.root.prepareNativeTurn({ model: 'standard-only' });
    expect(turn.params).toMatchObject({ model: 'standard-only', serviceTier: null });
    // A selection event alone cannot replace the durable Ultrafast choice.
    f.native.notify('thread/settings/updated', { threadId: 'thread', threadSettings: { model: 'standard-only', serviceTier: 'default' } });
    await f.root.refresh();
    expect(heartbeat.mock.lastCall?.[2]).not.toHaveProperty('serviceTier');
    const applied = effectiveTier !== 'ultrafast';
    f.native.settings = { model: applied ? 'standard-only' : 'mock', serviceTier: effectiveTier };
    await f.root.recoverLostNativeTurn({ ...turn, explicitTier: false });
    expect(f.root.needsTierConfirmation).toBe(!applied);
    if (applied) {
        expect(f.metadata().codexPendingServiceTier).toBeUndefined();
        expect(f.metadata().codexConfirmedServiceTier).toBe('standard');
        expect(heartbeat.mock.lastCall?.[2]?.serviceTier).toBe('standard');
    } else {
        const metadata = f.metadata();
        expect(metadata.codexPendingServiceTier).toBe('ultrafast');
        await expect(inheritedResumeTier(f.root.client, {}, metadata.codexServiceTierExplicit, '/project',
            undefined, metadata.codexPendingServiceTier, metadata.codexTierConfirmationPending)).resolves.toEqual({ serviceTier: 'ultrafast' });
    }
});

it.each(['ultrafast', 'default'])('preserves accepted native Ultrafast if the wrapper stops before an effective %s read', async effective => {
    const f = await fixture({ bindTier: 'default' });
    await f.root.activate();
    const operation = await f.root.prepareNativeTurn({ serviceTier: 'ultrafast' });
    let enter!: () => void;
    let release!: () => void;
    const reading = new Promise<void>(resolve => { enter = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const original = f.root.client.request.bind(f.root.client);
    vi.spyOn(f.root.client, 'request').mockImplementationOnce(async (method, params) => {
        enter();
        await held;
        return original(method, params);
    }).mockImplementation(original);
    const confirm = f.root.confirmNativeTurn(operation.params, true, operation.fallbackNotice, operation.generation);
    await reading;
    const pending = structuredClone(f.metadata());
    expect(pending).toMatchObject({ codexServiceTierExplicit: true, codexPendingServiceTier: 'ultrafast', codexTierConfirmationPending: true });
    expect(await inheritedResumeTier(f.root.client, {}, pending.codexServiceTierExplicit, '/project', 'standard',
        pending.codexPendingServiceTier, pending.codexTierConfirmationPending)).toEqual({ serviceTier: 'ultrafast' });
    f.native.settings.serviceTier = effective;
    release();
    await confirm;
    expect(f.metadata().codexPendingServiceTier).toBeUndefined();
    expect(f.metadata().codexConfirmedServiceTier).toBe(effective === 'default' ? 'standard' : 'ultrafast');
    expect(f.metadata().codexTierConfirmationPending).toBe(false);
});

it.each(['web', 'native'])('keeps a newer lost-turn pause after an older %s Standard write is acknowledged', async origin => {
    const f = await fixture({ bindTier: 'priority' });
    await f.root.activate();
    const original = f.root.client.request.bind(f.root.client);
    let entered!: () => void;
    let release!: () => void;
    const dispatched = new Promise<void>(resolve => { entered = resolve; });
    const acknowledge = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
        const result = await original(method, params);
        if (method === 'thread/settings/update') {
            entered();
            await acknowledge;
        }
        return result;
    });
    const write = origin === 'web'
        ? f.root.applySettings({ serviceTier: 'standard' })
        : f.root.applyNativeSettings({ threadId: 'thread', serviceTier: null });
    await dispatched;
    const later = await f.root.prepareNativeTurn({ serviceTier: 'priority' });
    await f.root.recoverLostNativeTurn({ ...later, explicitTier: true });
    expect(f.root.needsTierConfirmation).toBe(true);
    release();
    await write;
    expect(f.root.needsTierConfirmation).toBe(true);
    expect(f.metadata().codexTierConfirmationPending).toBe(true);
    expect(f.sessionReady).toHaveBeenCalledTimes(1);
    await expect(f.root.nativeQueueMutation('thread/queue/start', { threadId: 'thread' })).rejects.toThrow('tier confirmation');
    await f.root.applySettings({ serviceTier: 'fast' });
    expect(f.root.needsTierConfirmation).toBe(false);
    expect(f.sessionReady).toHaveBeenCalledTimes(2);
});

it.each(['web', 'native'])('awaits durable Standard recovery through %s before acknowledging settings or releasing input', async origin => {
    const f = await fixture();
    f.session.updateMetadata(metadata => ({ ...metadata, codexPendingServiceTier: 'ultrafast', codexTierConfirmationPending: true }));
    await f.root.activate({}, true);
    let durable = structuredClone(f.metadata());
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const persistence = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(f.session, 'flushMetadata').mockImplementationOnce(async () => {
        entered();
        await persistence;
        durable = structuredClone(f.metadata());
        return true;
    });
    const recovery = origin === 'web'
        ? f.root.applySettings({ serviceTier: 'standard' })
        : f.root.applyNativeSettings({ threadId: 'thread', serviceTier: null });
    const acknowledged = vi.fn();
    void recovery.then(acknowledged, () => {});
    await waiting;
    expect(acknowledged).not.toHaveBeenCalled();
    expect(f.root.needsTierConfirmation).toBe(true);
    expect(f.sessionReady).not.toHaveBeenCalled();
    expect(durable.codexPendingServiceTier).toBe('ultrafast');
    release();
    await recovery;
    expect(acknowledged).toHaveBeenCalledTimes(1);
    expect(f.sessionReady).toHaveBeenCalledTimes(1);
    expect(durable.codexPendingServiceTier).toBeUndefined();
    expect(durable.codexConfirmedServiceTier).toBe('standard');
    expect(durable.codexTierConfirmationPending).toBe(true);
    expect(f.metadata().codexTierConfirmationPending).toBe(false);
    expect(await inheritedResumeTier(f.root.client, {}, durable.codexServiceTierExplicit, '/project',
        durable.codexConfirmedServiceTier ?? 'ultrafast', durable.codexPendingServiceTier,
        durable.codexTierConfirmationPending && durable.codexConfirmedServiceTier === undefined)).toEqual({ serviceTier: null });
});

it('keeps Web Standard recovery visible if the tier metadata is acknowledged after the wait times out', async () => {
    const f = await fixture();
    f.session.updateMetadata(metadata => ({ ...metadata, codexPendingServiceTier: 'ultrafast', codexTierConfirmationPending: true }));
    await f.root.activate({}, true);
    const queued: Array<Parameters<ApiSessionClient['updateMetadata']>[0]> = [];
    const applyMetadata = f.session.updateMetadata.bind(f.session);
    const delayMetadata = vi.spyOn(f.session, 'updateMetadata').mockImplementation(update => { queued.push(update); });
    vi.spyOn(f.session, 'flushMetadata').mockResolvedValueOnce(false);
    await expect(f.root.applySettings({ serviceTier: 'standard' })).rejects.toThrow('could not confirm saving it');
    expect(f.sessionReady).not.toHaveBeenCalled();
    expect(f.metadata().codexPendingServiceTier).toBe('ultrafast');

    for (const update of queued) applyMetadata(update);
    delayMetadata.mockRestore();
    expect(f.metadata()).toMatchObject({ codexConfirmedServiceTier: 'standard', codexTierConfirmationPending: true });
    expect(f.metadata().codexPendingServiceTier).toBeUndefined();
    expect(f.root.needsTierConfirmation).toBe(true);

    await f.root.applySettings({ serviceTier: 'standard' });
    expect(f.metadata().codexTierConfirmationPending).toBe(false);
    expect(f.root.needsTierConfirmation).toBe(false);
    expect(f.sessionReady).toHaveBeenCalledTimes(1);
});

it.each(['default', null, 'priority'])('reconciles delayed lost reply if newer Standard is reported as %s', async serviceTier => {
    const f = await fixture({ bindTier: 'default' });
    await f.root.activate();
    const prepared = await f.root.prepareNativeTurn({ serviceTier: 'priority' });
    await f.root.applySettings({ serviceTier: 'standard' });
    // Like the Hub, retire the duplicate metadata once Standard is in the tier column.
    f.session.updateMetadata(metadata => ({ ...metadata, codexConfirmedServiceTier: undefined }));
    vi.spyOn(f.root.client, 'request').mockResolvedValueOnce({ model: 'mock', serviceTier });
    await f.root.recoverLostNativeTurn({ ...prepared, explicitTier: true });
    expect(f.root.needsTierConfirmation).toBe(serviceTier === 'priority');
    expect(f.root.hasConfirmedStandardTier).toBe(true);
    if (serviceTier === 'priority') {
        const metadata = f.metadata();
        expect(metadata.codexPendingServiceTier).toBe('standard');
        await expect(inheritedResumeTier(f.root.client, {}, metadata.codexServiceTierExplicit, '/project',
            'standard', metadata.codexPendingServiceTier, metadata.codexTierConfirmationPending)).resolves.toEqual({ serviceTier: null });
    }
});

it('keeps a newer native Standard notification confirmed when an older reply is lost', async () => {
    const f = await fixture({ bindTier: 'priority' });
    await f.root.activate();
    const older = await f.root.prepareNativeTurn({ serviceTier: 'priority' });
    let entered!: () => void, release!: (value: unknown) => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const original = f.root.client.request.bind(f.root.client);
    vi.spyOn(f.root.client, 'request').mockImplementationOnce(async () => {
        entered();
        return await held as never;
    }).mockImplementation(original);
    const confirming = f.root.confirmNativeTurn({ serviceTier: null }, true);
    await reading;
    f.native.settings.serviceTier = 'default';
    f.native.notify('thread/settings/updated', { threadId: 'thread', threadSettings: f.native.settings });
    await f.drain();
    release({ model: 'mock', serviceTier: 'priority' });
    await confirming;
    await f.root.recoverLostNativeTurn({ ...older, explicitTier: true });
    expect(f.root.hasConfirmedStandardTier).toBe(true);
    expect(f.root.needsTierConfirmation).toBe(false);
});

it.each(['snapshot', 'notification'])('releases a lost-turn pause after newer native Standard %s', async source => {
    const f = await fixture({ bindTier: 'priority' });
    await f.root.activate();
    const older = await f.root.prepareNativeTurn({ serviceTier: 'priority' });
    const newer = await f.root.prepareNativeTurn({ serviceTier: null });
    await f.root.recoverLostNativeTurn({ ...older, explicitTier: true });
    expect(f.root.needsTierConfirmation).toBe(true);
    await expect(f.root.nativeQueueMutation('thread/queue/start', { threadId: 'thread' })).rejects.toThrow('tier confirmation');
    const original = f.root.client.request.bind(f.root.client);
    vi.spyOn(f.root.client, 'request').mockImplementationOnce(async () => {
        if (source === 'snapshot') return { model: 'mock', serviceTier: 'default' } as never;
        f.native.settings.serviceTier = 'default';
        f.native.notify('thread/settings/updated', { threadId: 'thread', threadSettings: f.native.settings });
        await f.drain();
        return { model: 'mock', serviceTier: 'priority' } as never;
    }).mockImplementation(original);
    await f.root.confirmNativeTurn(newer.params, true, undefined, newer.generation);
    expect(f.root.hasConfirmedStandardTier).toBe(true);
    expect(f.metadata().codexTierConfirmationPending).toBe(false);
    expect(f.root.needsTierConfirmation).toBe(false);
    f.submit('queued after Standard confirmation', 'after-confirmation');
    await vi.waitFor(() => expect(f.native.queue).toHaveLength(1));
});

it('preserves explicit native Fast intent when a Web effort update observes the tier first', async () => {
    const f = await fixture({ bindTier: 'ultrafast' });
    await f.root.activate();
    const turn = await f.root.prepareNativeTurn({ serviceTier: 'priority' });
    f.native.settings.serviceTier = 'priority';
    await f.root.applySettings({ modelReasoningEffort: 'high' });
    expect(f.metadata().codexServiceTierExplicit).toBe(false);
    await f.root.confirmNativeTurn(turn.params, true, undefined, turn.generation);
    expect(f.metadata().codexServiceTierExplicit).toBe(true);
});

it('confirms an identical tier from a fresh snapshot without requiring a duplicate event', async () => {
    const f = await fixture(); await f.root.activate();
    await f.root.applySettings({ serviceTier: 'ultrafast' });
    const request = vi.spyOn(f.root.client, 'request');
    await f.root.applySettings({ serviceTier: 'ultrafast' });
    expect(request).toHaveBeenCalledWith('thread/resume', { threadId: 'thread', excludeTurns: true });
    expect(request.mock.calls.some(([method]) => method === 'thread/settings/update')).toBe(false);
    expect(f.metadata().codexServiceTierExplicit).toBe(true);
});
it('pins inherited Standard when an explicit identical selection has no native event', async () => {
    const f = await fixture(); await f.root.activate();
    await f.root.client.request('thread/settings/update', { threadId: 'thread', serviceTier: null });
    expect(f.metadata().codexServiceTierExplicit).toBe(false);
    const request = vi.spyOn(f.root.client, 'request');
    await f.root.applySettings({ serviceTier: 'standard' });
    expect(request.mock.calls.some(([method]) => method === 'thread/settings/update')).toBe(false);
    expect(f.metadata().codexServiceTierExplicit).toBe(true);
});
it('confirms Standard when the catalog advertises Ultrafast but effective thread features disable it', async () => {
    const f = await fixture(); await f.root.activate();
    const original = f.root.client.request.bind(f.root.client);
    vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
        if (method === 'experimentalFeature/list') return { data: [{ name: 'ultrafast_mode', enabled: false }] } as never;
        return original(method, params);
    });
    expect((await f.root.applySettings({ serviceTier: 'ultrafast' })).applied.serviceTier).toBe('standard');
    expect(f.events).toHaveBeenCalledWith({ type: 'message', message: 'Ultrafast is disabled in the current Codex configuration; changed to Standard.' });
});
it('persists confirmed tier intent from a native frontend without pinning initial snapshots', async () => {
    const f = await fixture(); await f.root.activate();
    f.native.notify('thread/settings/updated', { threadId: 'thread', threadSettings: { serviceTier: 'priority' } });
    expect(f.metadata().codexServiceTierExplicit).toBe(false);
    await f.root.applyNativeSettings({ threadId: 'thread', serviceTier: 'ultrafast' });
    expect(f.metadata().codexServiceTierExplicit).toBe(true);
    expect(f.root.freshParams().serviceTier).toBe('ultrafast');
});
it('does not pin a native tier when its write is rejected', async () => {
    const f = await fixture(); await f.root.activate();
    const original = f.root.client.request.bind(f.root.client);
    vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
        if (method === 'thread/settings/update') throw new Error('write rejected');
        return original(method, params);
    });
    await expect(f.root.applyNativeSettings({ threadId: 'thread', serviceTier: 'priority' })).rejects.toThrow('write rejected');
    expect(f.metadata().codexServiceTierExplicit).toBe(false);
});
it('falls back from a native Ultrafast selection on an unsupported model', async () => {
    const f = await fixture(); await f.root.activate();
    await f.root.applyNativeSettings({ threadId: 'thread', model: 'standard-only', serviceTier: 'ultrafast' });
    expect(f.root.freshParams()).toMatchObject({ model: 'standard-only', serviceTier: 'default' });
    expect(f.events).toHaveBeenCalledWith({ type: 'message', message: 'Ultrafast was not advertised by the current Codex model catalog; changed to Standard.' });
});
it('preserves inherited intent when only a model change requires Standard fallback', async () => {
    const f = await fixture(); f.root.acceptSettings({ model: 'mock', serviceTier: 'ultrafast' }, true);
    await f.root.activate();
    await f.root.applySettings({ model: 'standard-only' });
    expect(f.metadata().codexServiceTierExplicit).toBe(false);
    expect(f.root.freshParams().serviceTier).toBeUndefined();
});
it('rechecks a tier-only model after asynchronous feature discovery', async () => {
    const f = await fixture();
    const original = f.root.client.request.bind(f.root.client);
    let release!: (value: unknown) => void;
    vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
        if (method === 'experimentalFeature/list') return await new Promise<unknown>(resolve => { release = resolve; }) as never;
        return original(method, params);
    });
    const pending = f.root.applySettings({ serviceTier: 'ultrafast' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    f.native.notify('thread/settings/updated', { threadId: 'thread', threadSettings: { model: 'standard-only', serviceTier: 'default' } });
    release({ data: [{ name: 'ultrafast_mode', enabled: true }] });
    expect((await pending).applied).toMatchObject({ model: 'standard-only', serviceTier: 'standard' });
});
it('does not add a fallible feature RPC after a native launch already confirmed Ultrafast', async () => {
    const f = await fixture(); f.root.acceptSettings({ model: 'mock', serviceTier: 'ultrafast' }, true);
    const request = vi.spyOn(f.root.client, 'request').mockRejectedValue(new Error('feature discovery disconnected'));
    await f.root.confirmUltrafastLaunch();
    expect(request).not.toHaveBeenCalled();
});
it('revalidates a native model-only change without pinning inherited tier intent', async () => {
    const f = await fixture(); await f.root.activate();
    await f.root.client.request('thread/settings/update', { threadId: 'thread', model: 'mock', serviceTier: 'ultrafast' });
    expect(f.metadata().codexServiceTierExplicit).toBe(false);
    await f.root.applyNativeSettings({ threadId: 'thread', model: 'standard-only' });
    expect(f.metadata().codexServiceTierExplicit).toBe(false);
    expect(f.root.freshParams()).toMatchObject({ model: 'standard-only' });
    expect(f.root.freshParams().serviceTier).toBeUndefined();
    expect(f.events).toHaveBeenCalledWith({ type: 'message', message: 'Ultrafast was not advertised by the current Codex model catalog; changed to Standard.' });
});
it.each([false, true])('recovers a known thread through settings while input is paused (restored=%s)', async restored => {
    const f = await fixture();
    if (restored) f.session.updateMetadata(metadata => ({ ...metadata, codexTierConfirmationPending: true }));
    await f.root.activate({}, true, !restored);
    expect(f.root.needsTierConfirmation).toBe(true);
    expect(f.metadata().codexTierConfirmationPending).toBe(true);
    expect(f.sessionReady).not.toHaveBeenCalled();
    f.reconnect();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.sessionReady).not.toHaveBeenCalled();
    await expect(f.rpc.get(RPC_METHODS.ImplementCodexPlan)!({ planId: 'pending' })).rejects.toThrow('Confirm the service tier');
    f.submit('held until confirmed', 'pending-tier-input');
    expect(f.native.queue).toHaveLength(0);
    await f.rpc.get(RPC_METHODS.SetSessionConfig)!({ serviceTier: 'standard' });
    expect(f.metadata().codexTierConfirmationPending).toBe(false);
    expect(f.root.needsTierConfirmation).toBe(false);
    expect(f.sessionReady).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(f.native.queue).toHaveLength(1));
    f.reconnect();
    await vi.waitFor(() => expect(f.sessionReady).toHaveBeenCalledTimes(2));
});
it('reconciles a persisted pending confirmation from an authoritative cold-resume Standard snapshot', async () => {
    const f = await fixture();
    f.session.updateMetadata(metadata => ({ ...metadata, codexTierConfirmationPending: true }));
    await f.root.bind('thread', { model: 'mock', serviceTier: 'default', thread: { turns: [] } }, false);
    await f.root.activate();
    expect(f.root.needsTierConfirmation).toBe(false);
    expect(f.metadata().codexTierConfirmationPending).toBe(false);
    expect(f.sessionReady).toHaveBeenCalledOnce();
});
it.each([null, 'ultrafast'])('clears restored pending state after successful launch confirmation (%s)', async tier => {
    const f = await fixture();
    f.session.updateMetadata(metadata => ({ ...metadata, codexTierConfirmationPending: true }));
    f.root.acceptSettings({ model: 'mock', serviceTier: tier }, true);
    await f.root.confirmUltrafastLaunch();
    expect(f.metadata().codexTierConfirmationPending).toBe(false);
    expect(f.sessionReady).not.toHaveBeenCalled();
    await f.root.activate(); expect(f.sessionReady).toHaveBeenCalledOnce();
});
it('resolves native turn fallback without changing settings or intent before acceptance', async () => {
    const f = await fixture(); await f.root.activate(); f.events.mockClear();
    const input = [{ type: 'text', text: 'native input' }];
    const before = f.root.freshParams(); const metadata = f.metadata();
    const request = vi.spyOn(f.root.client, 'request');
    const resolved = await f.root.prepareNativeTurn({ threadId: 'thread', input, model: 'standard-only', serviceTier: 'ultrafast' });
    expect(resolved.params).toEqual({ threadId: 'thread', input, model: 'standard-only', serviceTier: null });
    expect(f.root.freshParams()).toEqual(before);
    expect(f.metadata()).toEqual(metadata);
    expect(f.events).not.toHaveBeenCalled();
    expect(request.mock.calls.some(([method]) => ['turn/start', 'thread/settings/update'].includes(method))).toBe(false);
    request.mockResolvedValueOnce({ model: 'standard-only', serviceTier: 'default' });
    await f.root.confirmNativeTurn(resolved.params, true, resolved.fallbackNotice);
    expect(f.metadata().codexServiceTierExplicit).toBe(true);
    expect(f.events).toHaveBeenCalledWith({ type: 'message', message: 'Ultrafast was not advertised by the current Codex model catalog; changed to Standard.' });
});
it('checks the collaboration model before native settings and turn overrides', async () => {
    const f = await fixture(); await f.root.activate();
    const collaborationMode = { mode: 'plan', settings: { model: 'standard-only' } };
    const resolved = await f.root.prepareNativeTurn({ model: 'mock', collaborationMode, serviceTier: 'ultrafast' });
    expect(resolved.params).toMatchObject({ model: 'standard-only', serviceTier: null, collaborationMode });
    const request = vi.spyOn(f.root.client, 'request');
    await f.root.applyNativeSettings({ collaborationMode, serviceTier: 'ultrafast' });
    expect(request).toHaveBeenCalledWith('thread/settings/update', expect.objectContaining({ model: 'standard-only', serviceTier: null }));
});
it('normalizes native Fast before settings confirmation and turn admission', async () => {
    const f = await fixture(); await f.root.activate();
    await f.root.applyNativeSettings({ serviceTier: 'fast' });
    expect(f.root.freshParams().serviceTier).toBe('priority');
    expect((await f.root.prepareNativeTurn({ serviceTier: 'fast' })).params.serviceTier).toBe('priority');
    expect(f.metadata().codexServiceTierExplicit).toBe(true);
});
it('fences input throughout launch tier confirmation before activation', async () => {
    const f = await fixture(); f.root.beginTierConfirmation();
    expect(f.root.needsTierConfirmation).toBe(true);
    await f.root.activate({}, false, true);
    expect(f.root.needsTierConfirmation).toBe(true);
    await f.root.applyNativeSettings({ serviceTier: null });
    expect(f.root.needsTierConfirmation).toBe(false);
});
it('does not forward a native turn or write settings after tier discovery failure', async () => {
    const f = await fixture(); await f.root.activate();
    vi.spyOn(f.root.client, 'listModels').mockRejectedValueOnce(new Error('catalog unavailable'));
    const request = vi.spyOn(f.root.client, 'request');
    await expect(f.root.prepareNativeTurn({ threadId: 'thread', serviceTier: 'ultrafast', input: [] })).rejects.toThrow('catalog unavailable');
    expect(request.mock.calls.some(([method]) => ['turn/start', 'thread/settings/update'].includes(method))).toBe(false);
});

it('preserves accepted explicit tier intent across a later model-only change', async () => {
    const f = await fixture(); await f.root.activate({}, false);
    let release!: (value: unknown) => void;
    const snapshot = new Promise(resolve => { release = resolve; });
    vi.spyOn(f.root.client, 'request').mockImplementationOnce(() => snapshot as never);
    const pending = f.root.confirmNativeTurn({ model: 'mock', serviceTier: 'priority' }, true);
    expect(f.metadata().codexServiceTierExplicit).toBe(true);
    expect(f.metadata().codexPendingServiceTier).toBe('fast');
    expect(f.metadata().codexTierConfirmationPending).toBe(true);
    release({ model: 'changed-model', serviceTier: 'priority' }); await pending;
    expect(f.metadata().codexServiceTierExplicit).toBe(true);
    expect(f.metadata().codexPendingServiceTier).toBeUndefined();
    expect(f.metadata().codexTierConfirmationPending).toBe(false);
    expect(f.metadata().codexConfirmedServiceTier).toBe('fast');
    expect(f.root.freshParams()).toMatchObject({ model: 'changed-model', serviceTier: 'priority' });
});
it('clears filtered Fast intent after an accepted turn and rejects a repeated selection without pausing input', async () => {
    const f = await fixture({ bindTier: 'default' });
    await f.root.activate();
    const keepAlive = vi.spyOn(f.session, 'keepAlive');
    const operation = await f.root.prepareNativeTurn({ serviceTier: 'priority' });
    f.native.settings.serviceTier = 'priority';
    f.native.notify('thread/settings/updated', { threadId: 'thread', threadSettings: f.native.settings });
    await f.drain();
    const original = f.root.client.request.bind(f.root.client);
    const request = vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
        if (method === 'thread/resume') return { ...f.native.settings, serviceTier: null } as never;
        if (method === 'thread/settings/update') return {} as never;
        return original(method, params);
    });
    await f.root.confirmNativeTurn(operation.params, true, operation.fallbackNotice, operation.generation);
    expect(f.metadata().codexServiceTierExplicit).toBe(false);
    expect(f.metadata().codexPendingServiceTier).toBeUndefined();
    expect(f.metadata().codexTierConfirmationPending).toBe(false);
    expect(f.root.needsTierConfirmation).toBe(false);
    expect(keepAlive.mock.lastCall?.[2]?.serviceTier).toBeNull();
    expect(f.root.freshParams().serviceTier).toBeUndefined();
    await expect(f.root.applyNativeSettings({ threadId: 'thread', serviceTier: 'priority' })).rejects.toThrow('Fast is unavailable');
    await expect(f.root.applySettings({ serviceTier: 'fast' })).rejects.toThrow('Fast is unavailable');
    expect(request.mock.calls.some(([method]) => method === 'thread/settings/update')).toBe(false);
    expect(f.root.needsTierConfirmation).toBe(false);
    f.submit('still admitted', 'filtered-fast-repeat');
    await vi.waitFor(async () => expect((await f.ledger()).entries['filtered-fast-repeat']?.state).toBe('queued'));
});

it.each(['web', 'native'])('holds recovery when the first %s Fast write is selected but filtered by Codex', async origin => {
    const f = await fixture({ bindTier: 'default' });
    await f.root.activate({}, false, true);
    let entered!: () => void;
    let release!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    const heldSnapshot = new Promise<void>(resolve => { release = resolve; });
    const original = f.root.client.request.bind(f.root.client);
    const request = vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
        if (method === 'thread/resume' && f.native.settings.serviceTier === 'priority') {
            entered(); await heldSnapshot;
            return { ...f.native.settings, serviceTier: null } as never;
        }
        return original(method, params);
    });
    const keepAlive = vi.spyOn(f.session, 'keepAlive');
    const change = origin === 'web' ? f.root.applySettings({ serviceTier: 'fast' })
        : f.root.applyNativeSettings({ threadId: 'thread', serviceTier: 'priority' });
    const rejected = expect(change).rejects.toThrow('Fast is unavailable');
    await reading;
    try {
        f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'running' } });
        await f.drain();
        expect(keepAlive.mock.lastCall?.[2]?.serviceTier).toBe('standard');
        expect(f.metadata().codexConfirmedServiceTier).toBeUndefined();
    } finally { release(); }
    await rejected;
    expect(f.root.needsTierConfirmation).toBe(true);
    expect(f.metadata().codexTierConfirmationPending).toBe(true);
    expect(f.metadata().codexConfirmedServiceTier).toBeUndefined();
    expect(f.sessionReady).not.toHaveBeenCalled();
    expect(request.mock.calls.filter(([method]) => method === 'thread/settings/update')).toHaveLength(1);
    await f.root.applySettings({ serviceTier: 'standard' });
    expect(f.root.needsTierConfirmation).toBe(false);
});

it('keeps a late Fast selection provisional after the settings confirmation times out', async () => {
    const f = await fixture({ bindTier: 'default' }); await f.root.activate();
    let sent!: () => void;
    const dispatched = new Promise<void>(resolve => { sent = resolve; });
    const original = f.root.client.request.bind(f.root.client);
    vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
        if (method === 'thread/settings/update' && (params as { serviceTier?: unknown }).serviceTier === 'priority') {
            sent(); return {} as never;
        }
        return original(method, params);
    });
    const keepAlive = vi.spyOn(f.session, 'keepAlive');
    vi.useFakeTimers();
    try {
        const settings = f.root.applySettings({ serviceTier: 'fast' });
        const rejected = expect(settings).rejects.toThrow('confirmation is pending');
        await dispatched;
        await vi.advanceTimersByTimeAsync(15_000);
        await rejected;
        f.native.settings.serviceTier = 'priority';
        f.native.notify('thread/settings/updated', { threadId: 'thread', threadSettings: f.native.settings });
        f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'running' } });
        await f.drain();
        expect(f.root.needsTierConfirmation).toBe(true);
        expect(keepAlive.mock.lastCall?.[2]?.serviceTier).toBe('standard');
        expect(f.metadata().codexConfirmedServiceTier).toBeUndefined();
    } finally { vi.useRealTimers(); }
});

it('persists a native Standard fallback when Codex reports no override and restores it on cold resume', async () => {
    const f = await fixture({ bindTier: 'priority' });
    await f.root.activate();
    const operation = await f.root.prepareNativeTurn({ model: 'standard-only', serviceTier: 'ultrafast' });
    expect(operation.params.serviceTier).toBeNull();
    expect(operation.fallbackNotice).toBeTruthy();
    f.native.settings.serviceTier = null;
    await f.root.confirmNativeTurn(operation.params, true, operation.fallbackNotice, operation.generation);
    const saved = f.metadata();
    expect(saved.codexServiceTierExplicit).toBe(true);
    expect(saved.codexConfirmedServiceTier).toBe('standard');
    expect(saved.codexPendingServiceTier).toBeUndefined();
    expect(f.root.needsTierConfirmation).toBe(false);
    expect(f.root.freshParams().serviceTier).toBe('default');
    expect(f.events).toHaveBeenCalledWith({ type: 'message', message: operation.fallbackNotice });

    const resumeParams = await inheritedResumeTier(f.root.client, {}, saved.codexServiceTierExplicit, '/project', saved.codexConfirmedServiceTier);
    expect(resumeParams).toEqual({ serviceTier: null });
    const reopened = await fixture({ initialTierPending: true });
    await reopened.root.bind('thread', { model: 'mock', serviceTier: null, thread: { turns: [] } }, false, resumeParams.serviceTier);
    await reopened.root.activate({}, saved.codexServiceTierExplicit);
    expect(reopened.root.needsTierConfirmation).toBe(false);
    expect(reopened.metadata().codexConfirmedServiceTier).toBe('standard');
    expect(reopened.root.freshParams().serviceTier).toBe('default');
});

it('reconfirms Standard without a duplicate settings notification when native Fast is disabled', async () => {
    const f = await fixture(); await f.root.activate();
    f.native.settings.serviceTier = null;
    f.root.acceptSettings({ ...f.native.settings }, true);
    const original = f.root.client.request.bind(f.root.client);
    let selectedStandard = false;
    const request = vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
        if (method === 'thread/resume') {
            return { ...f.native.settings, serviceTier: null, thread: structuredClone(f.native.thread) } as never;
        }
        if (method === 'thread/settings/update') {
            if (selectedStandard) return {} as never;
            selectedStandard = true;
        }
        return original(method, params);
    });

    await f.root.applySettings({ serviceTier: 'standard' });
    expect(request.mock.calls.filter(([method]) => method === 'thread/settings/update')).toHaveLength(1);
    await expect(f.root.applySettings({ serviceTier: 'standard' })).resolves.toMatchObject({ applied: { serviceTier: 'standard' } });
    expect(request.mock.calls.filter(([method]) => method === 'thread/settings/update')).toHaveLength(1);
    expect(f.metadata().codexConfirmedServiceTier).toBe('standard');
    expect(f.root.needsTierConfirmation).toBe(false);
    f.submit('still admitted', 'standard-twice');
    await vi.waitFor(async () => expect((await f.ledger()).entries['standard-twice']?.state).toBe('queued'));
});

it('does not reset a newer Fast choice during model-only native turn discovery', async () => {
    const f = await fixture(); await f.root.activate();
    f.root.acceptSettings({ model: 'mock', serviceTier: 'ultrafast' }, true);
    let release!: (value: unknown) => void;
    const catalog = new Promise(resolve => { release = resolve; });
    const models = vi.spyOn(f.root.client, 'listModels').mockImplementationOnce(() => catalog as never);
    const pending = f.root.prepareNativeTurn({ model: 'standard-only' });
    await vi.waitFor(() => expect(models).toHaveBeenCalled());
    await f.root.applyNativeSettings({ serviceTier: 'priority' });
    release({ data: [{ id: 'standard-only', serviceTiers: [{ id: 'priority' }] }] });
    expect((await pending).params).toEqual({ model: 'standard-only' });
    expect(f.root.freshParams().serviceTier).toBe('priority');
});

it('does not overwrite a newer tier notification with a delayed native snapshot', async () => {
    const f = await fixture(); await f.root.activate();
    let entered!: () => void;
    let release!: (value: unknown) => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    const snapshot = new Promise(resolve => { release = resolve; });
    vi.spyOn(f.root.client, 'request').mockImplementationOnce(() => {
        entered();
        return snapshot as never;
    });
    const pending = f.root.confirmNativeTurn({ serviceTier: 'priority' }, true);
    await reading;
    f.native.settings.serviceTier = 'default';
    f.root.acceptSettings({ model: 'mock', serviceTier: 'default' }, true);
    release({ model: 'mock', serviceTier: 'priority' }); await pending;
    expect(f.root.freshParams().serviceTier).toBe('default');
    expect(f.metadata().codexServiceTierExplicit).toBe(true);
});

it('writes the requested tier instead of confirming an obsolete idempotent snapshot', async () => {
    const f = await fixture(); await f.root.activate();
    f.root.acceptSettings({ model: 'mock', serviceTier: 'default' }, true);
    let release!: (value: unknown) => void;
    const snapshot = new Promise(resolve => { release = resolve; });
    const original = f.root.client.request.bind(f.root.client);
    const request = vi.spyOn(f.root.client, 'request').mockImplementationOnce(() => snapshot as never);
    const pending = f.root.applyNativeSettings({ serviceTier: null });
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('thread/resume', expect.anything()));
    f.native.notify('thread/settings/updated', { threadId: 'thread', threadSettings: { model: 'mock', serviceTier: 'priority' } });
    request.mockImplementation(original);
    release({ model: 'mock', serviceTier: 'default' }); await pending;
    expect(request).toHaveBeenCalledWith('thread/settings/update', expect.objectContaining({ serviceTier: null }));
    expect(f.root.hasConfirmedStandardTier).toBe(true);
});
it('announces fallback confirmed by a newer notification during native reconciliation', async () => {
    const f = await fixture(); await f.root.activate(); f.events.mockClear();
    let release!: (value: unknown) => void;
    const snapshot = new Promise(resolve => { release = resolve; });
    vi.spyOn(f.root.client, 'request').mockImplementationOnce(() => snapshot as never);
    const notice = 'Ultrafast was not advertised by the current Codex model catalog; changed to Standard.';
    const pending = f.root.confirmNativeTurn({ serviceTier: null }, true, notice);
    f.native.notify('thread/settings/updated', { threadId: 'thread', threadSettings: { model: 'mock', serviceTier: 'default' } });
    release({ model: 'mock', serviceTier: 'default' }); await pending;
    expect(f.events).toHaveBeenCalledWith({ type: 'message', message: notice });
});

it.each(['turn', 'web', 'native'])('holds Web and native input if Standard is rejected after Ultrafast selection through %s', async origin => {
    const f = await fixture(); await f.root.activate();
    const turn = await f.root.prepareNativeTurn({ serviceTier: 'ultrafast' });
    const original = f.root.client.request.bind(f.root.client);
    let rejectReset = true;
    const request = vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
        const requestedTier = (params as { serviceTier?: unknown } | undefined)?.serviceTier;
        if (method === 'thread/settings/update' && requestedTier === 'ultrafast' && f.native.settings.serviceTier === 'ultrafast') {
            return {} as never;
        }
        if (method === 'thread/settings/update' && requestedTier === null && rejectReset) {
            rejectReset = false;
            throw new Error('Native settings reset rejected');
        }
        if (method === 'thread/resume' && f.native.settings.serviceTier === 'ultrafast') {
            return { ...f.native.settings, serviceTier: null, thread: structuredClone(f.native.thread) } as never;
        }
        return original(method, params);
    });
    if (origin === 'turn') {
        f.native.settings.serviceTier = 'ultrafast';
        await expect(f.root.confirmNativeTurn(turn.params, true, turn.fallbackNotice, turn.generation)).resolves.toBeUndefined();
    } else {
        const operation = origin === 'web' ? f.root.applySettings({ serviceTier: 'ultrafast' })
            : f.root.applyNativeSettings({ threadId: 'thread', serviceTier: 'ultrafast' });
        await expect(operation).rejects.toThrow('Native settings reset rejected');
    }
    expect(f.root.needsTierConfirmation).toBe(true);
    expect(f.metadata().codexTierConfirmationPending).toBe(true);
    f.submit('hold until Standard', 'paused-web-input');
    await expect(f.root.nativeQueueMutation('thread/queue/add', { threadId: 'thread', input: [] })).rejects.toThrow('tier confirmation');
    expect(request.mock.calls.some(([method]) => method === 'thread/queue/add')).toBe(false);

    if (origin === 'turn') await f.root.applySettings({ serviceTier: 'standard' });
    else {
        // Native keeps Ultrafast selected and suppresses an identical write,
        // although its effective snapshot still reports no override.
        if (origin === 'web') await f.root.applySettings({ serviceTier: 'ultrafast' });
        else await f.root.applyNativeSettings({ threadId: 'thread', serviceTier: 'ultrafast' });
        expect(request.mock.calls.filter(([method, params]) => method === 'thread/settings/update'
            && (params as { serviceTier?: unknown }).serviceTier === 'ultrafast')).toHaveLength(1);
    }
    expect(f.root.hasConfirmedStandardTier).toBe(true);
    expect(f.root.needsTierConfirmation).toBe(false);
    await vi.waitFor(async () => expect((await f.ledger()).entries['paused-web-input']?.state).toBe('queued'));
    expect(request.mock.calls.filter(([method]) => method === 'thread/queue/add')).toHaveLength(1);
});

it.each(['web', 'native', 'turn', 'web-model', 'native-model', 'turn-model'])('confirms the loaded effective tier after %s settings selection', async origin => {
    const f = await fixture(); await f.root.activate();
    const modelOnly = origin.endsWith('-model');
    if (modelOnly) {
        f.root.acceptSettings({ model: 'mock', serviceTier: 'ultrafast' }, true);
        f.native.settings = { ...f.native.settings, serviceTier: 'ultrafast' };
    }
    const original = f.root.client.request.bind(f.root.client);
    vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
        // Reloaded config advertises enabled while this loaded thread still
        // filters the newly selected tier using its original feature state.
        if (method === 'thread/resume' && f.native.settings.serviceTier === 'ultrafast') {
            return { ...f.native.settings, serviceTier: null, thread: structuredClone(f.native.thread) } as never;
        }
        return original(method, params);
    });
    if (origin.startsWith('web')) expect((await f.root.applySettings(modelOnly ? { model: 'mock' } : { serviceTier: 'ultrafast' })).applied.serviceTier).toBe('standard');
    else if (origin.startsWith('native')) await f.root.applyNativeSettings(modelOnly ? { model: 'mock' } : { serviceTier: 'ultrafast' });
    else {
        f.native.settings = { ...f.native.settings, serviceTier: 'ultrafast' };
        await f.root.confirmNativeTurn(modelOnly ? { model: 'mock' } : { serviceTier: 'ultrafast' }, !modelOnly);
    }
    expect(f.root.hasConfirmedStandardTier).toBe(true);
    expect(f.root.freshParams().serviceTier).toBe(modelOnly ? undefined : 'default');
    expect(f.metadata().codexServiceTierExplicit).toBe(!modelOnly);
    expect(f.events).toHaveBeenCalledWith({ type: 'message', message: 'Codex did not apply Ultrafast; changed to Standard.' });
});

it.each(['ultrafast', 'priority'])('rechecks a selected notification during native confirmation without replacing newer %s', async selected => {
    const f = await fixture(); await f.root.activate();
    const original = f.root.client.request.bind(f.root.client);
    let release!: (value: unknown) => void;
    let first = true;
    vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
        if (method === 'thread/resume') {
            if (first) { first = false; return await new Promise<unknown>(resolve => { release = resolve; }) as never; }
            return { model: 'mock', serviceTier: selected === 'priority' ? 'priority' : null } as never;
        }
        return original(method, params);
    });
    const pending = f.root.confirmNativeTurn({ serviceTier: 'ultrafast' }, true);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    f.native.settings = { ...f.native.settings, serviceTier: selected };
    f.native.notify('thread/settings/updated', { threadId: 'thread', threadSettings: f.native.settings });
    release({ model: 'mock', serviceTier: null }); await pending;
    expect(f.root.freshParams().serviceTier).toBe(selected === 'ultrafast' ? 'default' : 'priority');
    if (selected === 'ultrafast') expect(f.events).toHaveBeenCalledWith({ type: 'message', message: 'Codex did not apply Ultrafast; changed to Standard.' });
});

it.each(['stalled', 'repeated cursor'])('allows Standard recovery after a %s Default effort lookup', async failure => {
    const f = await fixture({ initialTierPending: true });
    await f.root.activate({}, false, true);
    expect(f.root.needsTierConfirmation).toBe(true);
    const original = f.root.client.request.bind(f.root.client);
    const request = vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
        if (method !== 'model/list') return original(method, params);
        if (failure === 'stalled') return await new Promise<never>(() => {});
        return { data: [], nextCursor: 'same-page' } as never;
    });
    vi.useFakeTimers();
    const effort = expect(f.root.applySettings({ modelReasoningEffort: null })).rejects.toThrow(
        failure === 'stalled' ? 'Settings update timed out; settings were not changed' : 'pagination did not advance');
    const standard = expect(f.root.applySettings({ serviceTier: 'standard' })).resolves.toMatchObject({ applied: { serviceTier: 'standard' } });
    await vi.advanceTimersByTimeAsync(10_000);
    await effort;
    await standard;
    expect(request.mock.calls.filter(([method]) => method === 'model/list')).toHaveLength(failure === 'stalled' ? 1 : 2);
    expect(request.mock.calls.filter(([method]) => method === 'thread/settings/update'))
        .toEqual([['thread/settings/update', expect.objectContaining({ serviceTier: null })]]);
    expect(f.root.needsTierConfirmation).toBe(false);
});

it('resolves Default effort from every page of the retained Codex provider', async () => {
    const f = await fixture(); await f.root.activate();
    vi.spyOn(f.root.client, 'supportsProviderScopedModels').mockReturnValue(true);
    f.root.acceptSettings({ model: 'mock', modelProvider: 'retained-provider' }, true);
    const original = f.root.client.request.bind(f.root.client);
    const request = vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
        if (method !== 'model/list') return original(method, params);
        const { cursor, modelProvider } = params as { cursor?: string; modelProvider?: string };
        if (modelProvider !== 'retained-provider') return { data: [{ id: 'mock', defaultReasoningEffort: 'low' }] } as never;
        return (cursor ? { data: [{ id: 'mock', defaultReasoningEffort: 'high' }] }
            : { data: [], nextCursor: 'page-2' }) as never;
    });
    await expect(f.root.applySettings({ modelReasoningEffort: null })).resolves.toMatchObject({ applied: { modelReasoningEffort: 'high' } });
    expect(request.mock.calls.filter(([method]) => method === 'model/list')).toEqual([
        ['model/list', { cursor: undefined, includeHidden: true, modelProvider: 'retained-provider' }],
        ['model/list', { cursor: 'page-2', includeHidden: true, modelProvider: 'retained-provider' }]
    ]);
});

it.each(['item/tool/requestUserInput', 'item/commandExecution/requestApproval'])('bounds confirmation while keeping running-turn %s visible', async method => {
    const f = await fixture(); await f.root.activate();
    f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'running' } }); await f.drain();
    const original = f.root.client.request.bind(f.root.client);
    const originalModels = f.root.client.listModels.bind(f.root.client);
    vi.useFakeTimers();
    try {
        const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
        const models = vi.spyOn(f.root.client, 'listModels').mockImplementation(async () => { await delay(9_000); return originalModels(); });
        const request = vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
            if (method === 'thread/settings/update') await delay(13_000);
            if (method === 'thread/resume') await delay(10_000);
            return original(method, params);
        });
        const pending = f.root.applySettings({ serviceTier: 'ultrafast' }).then(() => 'success', error => (error as Error).message);
        await vi.advanceTimersByTimeAsync(25_000);
        expect(await pending).toContain('confirmation is pending');
        expect(f.metadata().codexTierConfirmationPending).toBe(true);
        expect(f.metadata().codexServiceTierExplicit).toBe(false);
        f.native.serverRequest({ id: 'approval-in-recovery', method, params: { threadId: 'thread', turnId: 'running', itemId: 'pending-tool',
            command: 'echo hello', cwd: '/tmp', questions: [{ id: 'choice', header: 'Choose', question: 'Which?', options: [{ label: 'A', description: 'A' }] }] } });
        await vi.waitFor(() => expect(Object.keys(f.state().requests ?? {})).toHaveLength(1));
        const requestId = Object.keys(f.state().requests!)[0];
        await f.rpc.get(RPC_METHODS.Permission)!({ id: requestId, approved: true, answers: { choice: ['A'] } });
        await vi.waitFor(() => expect(f.native.responses.some(r => r.id === 'approval-in-recovery')).toBe(true));
        expect(f.root.needsTierConfirmation).toBe(true);
        f.submit('held for recovery', 'deadline-held-input');
        await vi.advanceTimersByTimeAsync(10_000);
        expect(f.native.queue).toHaveLength(0);
        expect(f.metadata().codexServiceTierExplicit).toBe(false);
        request.mockRestore(); models.mockRestore();
        await f.root.applySettings({ serviceTier: 'standard' });
        await vi.advanceTimersByTimeAsync(1);
        expect(f.metadata().codexTierConfirmationPending).toBe(false);
        await vi.waitFor(() => expect(f.native.queue).toHaveLength(1));
    } finally { vi.useRealTimers(); }
});

it.each(['initial', 'effective'])('discards a stale %s snapshot failure after a newer Standard confirmation', async phase => {
    const f = await fixture(); await f.root.activate();
    const original = f.root.client.request.bind(f.root.client);
    let pendingSnapshot!: () => void;
    const entered = new Promise<void>(resolve => { pendingSnapshot = resolve; });
    let reads = 0;
    vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
        if (method === 'thread/resume') {
            reads++;
            if (phase === 'effective' && reads === 1) {
                f.native.settings = { ...f.native.settings, serviceTier: 'ultrafast' };
                f.native.notify('thread/settings/updated', { threadId: 'thread', threadSettings: f.native.settings });
                return { model: 'mock', serviceTier: null } as never;
            }
            if (reads === (phase === 'effective' ? 2 : 1)) { pendingSnapshot(); return await new Promise<never>(() => {}); }
        }
        return original(method, params);
    });
    vi.useFakeTimers();
    try {
        const stale = f.root.confirmNativeTurn({ serviceTier: 'ultrafast' }, true);
        await entered;
        await f.root.applySettings({ serviceTier: 'standard' });
        expect(f.root.hasConfirmedStandardTier).toBe(true);
        f.events.mockClear();
        await vi.advanceTimersByTimeAsync(25_000); await stale;
        expect(f.root.needsTierConfirmation).toBe(false);
        expect(f.metadata().codexTierConfirmationPending).not.toBe(true);
        expect(f.events).not.toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('confirmation is pending') }));
    } finally { vi.useRealTimers(); }
});

it('does not introduce a tier-recovery fence for an unrelated model-write timeout', async () => {
    const f = await fixture(); await f.root.activate();
    const original = f.root.client.request.bind(f.root.client);
    vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
        if (method === 'thread/settings/update') return await new Promise<never>(() => {});
        return original(method, params);
    });
    vi.useFakeTimers();
    try {
        const pending = f.root.applySettings({ model: 'changed' }).then(() => 'success', error => (error as Error).message);
        await vi.advanceTimersByTimeAsync(25_000);
        expect(await pending).toContain('confirmation is pending');
        expect(f.root.needsTierConfirmation).toBe(false);
        expect(f.metadata().codexTierConfirmationPending).not.toBe(true);
    } finally { vi.useRealTimers(); }
});

it.each(['suspend', 'close'])('releases held input without submitting it when a paused root must %s', async action => {
    const f = await fixture({ attached: action === 'close' });
    await f.root.activate({}, true, true);
    f.submit('must not be submitted', 'paused-stop-input');
    await new Promise(resolve => setTimeout(resolve, 10));
    await (action === 'suspend' ? f.root.suspend() : f.root.close(false));
    expect(f.native.queue).toHaveLength(0);
});

it.each(['web', 'native'])('keeps Plan launch recovery controls available through %s settings', async origin => {
    const f = await fixture();
    const original = f.root.client.request.bind(f.root.client);
    let available = false;
    const request = vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
        if (method === 'thread/settings/update' && !available) throw new Error('settings endpoint unavailable');
        return original(method, params);
    });
    await f.root.activate({ collaborationMode: 'plan' }, true, true);
    expect(f.rpc.has(RPC_METHODS.SetSessionConfig)).toBe(true);
    expect(request.mock.calls.some(([method]) => method === 'thread/settings/update')).toBe(false);
    f.submit('held until Plan and Standard are applied', 'plan-recovery-input');
    const recover = () => origin === 'web' ? f.rpc.get(RPC_METHODS.SetSessionConfig)!({ serviceTier: 'standard' }) : f.root.applyNativeSettings({ serviceTier: null });
    await expect(recover()).rejects.toThrow('settings endpoint unavailable');
    expect(f.root.needsTierConfirmation).toBe(true);
    available = true; await recover();
    expect(f.root.hasConfirmedStandardTier).toBe(true);
    expect(f.native.settings.collaborationMode).toMatchObject({ mode: 'plan' });
    expect(f.root.needsTierConfirmation).toBe(false);
    await vi.waitFor(() => expect(f.native.queue).toHaveLength(1));
});

it('orders a queued Standard confirmation after native snapshots begun while it waits', async () => {
    const f = await fixture(); await f.root.activate();
    const original = f.root.client.request.bind(f.root.client);
    let enterWrite!: () => void, releaseWrite!: () => void, enterSnapshot!: () => void;
    const writing = new Promise<void>(resolve => { enterWrite = resolve; });
    const release = new Promise<void>(resolve => { releaseWrite = resolve; });
    const snapshot = new Promise<void>(resolve => { enterSnapshot = resolve; });
    vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
        if (method === 'thread/settings/update' && (params as { model?: string })?.model === 'blocking-model') { enterWrite(); await release; }
        if (method === 'thread/resume') { enterSnapshot(); return await new Promise<never>(() => {}); }
        return original(method, params);
    });
    vi.useFakeTimers();
    try {
        const blocker = f.root.applySettings({ model: 'blocking-model' }); await writing;
        const standard = f.root.applySettings({ serviceTier: 'standard' });
        const stale = f.root.confirmNativeTurn({ serviceTier: 'ultrafast' }, true); await snapshot;
        releaseWrite(); await blocker; await standard;
        expect(f.root.hasConfirmedStandardTier).toBe(true);
        await vi.advanceTimersByTimeAsync(25_000); await stale;
        expect(f.root.needsTierConfirmation).toBe(false);
    } finally { releaseWrite(); vi.useRealTimers(); }
});

it('rejects steering before changing the native queue when tier admission is paused', async () => {
    const f = await fixture(); await f.root.activate();
    f.submit('queued for steering', 'paused-steer');
    await vi.waitFor(() => expect(f.native.queue).toHaveLength(1));
    f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'running' } }); await f.drain();
    const request = vi.spyOn(f.root.client, 'request');
    f.root.beginTierConfirmation();
    await expect(f.rpc.get(RPC_METHODS.SteerQueuedMessage)!({ localId: 'paused-steer' })).rejects.toThrow('Confirm the service tier');
    expect(request.mock.calls.some(([method]) => method === 'turn/steer' || method === 'thread/queue/delete')).toBe(false);
    expect(f.native.queue).toHaveLength(1);
    expect(f.state().steeringActive).toBe(false);
});

it.each(['legacy', 'single-member batch', 'multi-member batch', 'in-flight steer'])('restores %s input once after tier confirmation interrupts steering', async kind => {
    const f = await fixture(); await f.root.activate();
    const legacy = kind === 'legacy';
    const inFlight = kind === 'in-flight steer';
    const hasSibling = kind === 'multi-member batch' || inFlight;
    f.submit('queued for steering', 'paused-steer', legacy);
    if (hasSibling) f.submit('leave queued', 'sibling');
    await vi.waitFor(async () => expect((await f.ledger()).entries[hasSibling ? 'sibling' : 'paused-steer']?.state).toBe('queued'));
    f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'running' } }); await f.drain();
    const tier = await f.root.prepareNativeTurn({ serviceTier: 'priority' });
    const original = f.root.client.request.bind(f.root.client);
    const request = vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
        if (inFlight && method === 'turn/steer') {
            await f.root.recoverLostNativeTurn({ ...tier, previousTier: undefined, explicitTier: true });
            throw new Error('Expected active turn no longer matches');
        }
        const response = await original(method, params);
        if (!inFlight && method === (hasSibling ? 'thread/queue/update' : 'thread/queue/delete')) {
            await f.root.recoverLostNativeTurn({ ...tier, previousTier: undefined, explicitTier: true });
        }
        return response;
    });
    expect(await f.rpc.get(RPC_METHODS.SteerQueuedMessage)!({ localId: 'paused-steer' })).toMatchObject({ steered: false });
    expect(f.root.needsTierConfirmation).toBe(true);
    expect((await f.ledger()).entries['paused-steer'].state).toBe('released');
    expect(f.native.queue).toHaveLength(hasSibling ? 1 : 0);
    expect(request.mock.calls.filter(([method]) => method === 'turn/steer')).toHaveLength(inFlight ? 1 : 0);
    expect(request.mock.calls.filter(([method]) => method === 'thread/queue/update')).toHaveLength(hasSibling ? 1 : 0);
    expect(request.mock.calls.some(([method]) => method === 'thread/queue/add')).toBe(false);
    expect(f.session.setSteerDeliveryState).toHaveBeenCalledWith(['paused-steer'], 'queued');
    expect(f.state().steeringActive).toBe(false);

    await f.root.applySettings({ serviceTier: 'standard' });
    await vi.waitFor(async () => expect((await f.ledger()).entries['paused-steer'].state).toBe('queued'));
    // An ordinary Hub replay for the same ID must converge on the restored input.
    f.submit('duplicate replay', 'paused-steer', legacy);
    await vi.waitFor(() => expect(request.mock.calls.filter(([method]) => method === 'thread/queue/list').length).toBeGreaterThan(1));
    expect(request.mock.calls.filter(([method]) => method === 'thread/queue/add')).toHaveLength(1);
    expect(f.native.queue.find(item => item.clientUserMessageId === 'paused-steer')?.input).toMatchObject([{ text: 'queued for steering' }]);
    expect(f.native.queue).toHaveLength(hasSibling ? 2 : 1);
});

it.each(['suspend', 'close'])('does not submit input released from the second gate during %s', async action => {
    const f = await fixture({ attached: action === 'close' }); await f.root.activate();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(f.root as unknown as { command(text: string): Promise<string | null> }, 'command').mockImplementation(async () => { entered(); await gate; return 'must not submit'; });
    vi.spyOn(f.root.client, 'supportsProviderScopedModels').mockReturnValue(true);
    const original = f.root.client.request.bind(f.root.client);
    const request = vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
        if (method === 'thread/settings/update') return await new Promise<never>(() => {});
        return original(method, params);
    });
    vi.useFakeTimers();
    try {
        f.submit('/deferred message', 'second-gate-input'); await started;
        const failure = f.root.applySettings({ serviceTier: action === 'close' ? 'standard' : 'ultrafast' }).catch(() => {});
        await vi.advanceTimersByTimeAsync(25_000); await failure;
        expect(f.root.needsTierConfirmation).toBe(true);
        release(); await (action === 'suspend' ? f.root.suspend() : f.root.close(false));
        expect(request.mock.calls.some(([method]) => method === 'thread/queue/add')).toBe(false);
        expect(f.native.queue).toHaveLength(0);
    } finally { release(); vi.useRealTimers(); }
});

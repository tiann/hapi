import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentState, Metadata } from '@/api/types';
import type { ApiSessionClient } from '@/api/apiSession';
import { CodexAppServerClient } from '../codexAppServerClient';
import { initializeSharedClient } from './launch';
import { record } from './gateway';
import { isProcessAlive } from '@/utils/process';
import { notifyRunnerSessionStarted } from '@/runner/controlClient';
import { bootstrapExistingSession } from '@/agent/sessionFactory';
import { asyncQuestionsForItem } from './asyncQuestions';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';

const state = vi.hoisted(() => ({ home: '', sessions: new Map<string, MockSession>(), beforeBootstrap: undefined as (() => Promise<void>) | undefined }));
const BOOTSTRAP_START_MARKER = vi.hoisted(() => 'Tue Sep 29 09:00:00 2026');
class MockSession extends EventEmitter {
    readonly sessionId: string;
    state: AgentState = { requests: { 'old-worker': { tool: 'request_user_input', arguments: {}, createdAt: 0 } } }; metadata: Metadata;
    messages: unknown[] = []; consumed: string[] = []; dead = false;
    serviceTier?: string | null;
    user?: (message: { content: { text: string } }, id?: string) => void;
    rpc = new Map<string, (params: unknown) => Promise<unknown>>();
    rpcHandlerManager = { registerHandler: (name: string, fn: (params: unknown) => Promise<unknown>) => { this.rpc.set(name, fn); } };
    constructor(cwd: string, id: string = randomUUID()) { super(); this.sessionId = id; this.metadata = { path: cwd, host: 'test', hostPid: process.pid, machineId: 'test', flavor: 'codex', capabilities: { concurrentClients: true } }; }
    getMetadata() { return this.metadata; }
    updateMetadata(fn: (m: Metadata) => Metadata) { this.metadata = fn(this.metadata); }
    updateAgentState(fn: (s: AgentState) => AgentState) { this.state = fn(this.state); }
    onUserMessage(fn: MockSession['user']) { this.user = fn; }
    onCancelQueuedMessage() {} onRetryQueuedMessage() {} onReconnect() {}
    sendUserMessage(text: string) { this.messages.push({ user: text }); }
    sendAgentMessage(body: unknown) { this.messages.push(body); }
    sendSessionEvent(body: unknown) { this.messages.push(body); }
    emitMessagesConsumed(ids: string[]) { this.consumed.push(...ids); }
    emitSteerIndeterminate() {}
    keepAlive(_thinking?: boolean, _mode?: unknown, settings?: { serviceTier?: string | null }) { if (settings && 'serviceTier' in settings) this.serviceTier = settings.serviceTier; }
    emitSessionReady() {}
    async setSteerDeliveryState() { return true; }
    syncNativeQueuedMessage() {}
    sendSessionDeath() { this.dead = true; } async flush() {} close() {} isPending() { return false; }
}
vi.mock('@/configuration', () => ({ configuration: { get happyHomeDir() { return state.home; }, apiUrl: 'http://mock-hub', cliApiToken: 'test' } }));
vi.mock('@/ui/logger', () => ({ logger: { debug: (...args: unknown[]) => { if (process.env.HAPI_DEBUG_SHARED_TEST) console.log(...args); }, warn: vi.fn(), info: vi.fn(), debugLargeJson: vi.fn() } }));
vi.mock('@/agent/sessionFactory', () => ({ bootstrapSession: async (options: { workingDirectory: string; metadataOverrides: Partial<Metadata> }) => {
    await state.beforeBootstrap?.();
    const session = new MockSession(options.workingDirectory); session.metadata = { ...session.metadata, ...options.metadataOverrides };
    state.sessions.set(session.sessionId, session);
    // session.getMetadata() is the hub's view; a hub without the field strips
    // hostStartMarker, so only the local bootstrap metadata still carries it.
    return { session: session as unknown as ApiSessionClient, sessionInfo: { id: session.sessionId, namespace: 'test' }, metadata: { ...session.metadata, hostStartMarker: BOOTSTRAP_START_MARKER },
        workingDirectory: options.workingDirectory, machineId: 'test', startedBy: 'terminal', api: {} };
}, bootstrapExistingSession: vi.fn() }));
vi.mock('@/runner/controlClient', () => ({ notifyRunnerSessionStarted: vi.fn(async () => ({})) }));
vi.mock('../utils/buildHapiMcpBridge', () => ({ buildHapiMcpBridge: async () => ({ server: { url: 'http://unused', stop() {} }, mcpServers: {} }) }));

// Explicit opt-in: installed official binary, entirely isolated CODEX_HOME, mock Responses API only.
describe.skipIf(process.env.HAPI_RUN_SHARED_CODEX_TESTS !== '1')('installed Codex shared runtime', () => {
    afterEach(() => { vi.unstubAllEnvs(); state.sessions.clear(); state.beforeBootstrap = undefined; });
    it('releases a failed gateway cold resume for retry from another runtime without pinning inherited tier', async () => {
        const home = await mkdtemp(join(tmpdir(), 'hapi-shared-tier-retry-')); state.home = home;
        const ch = join(home, 'codex'), cwd = join(home, 'work'); await mkdir(ch); await mkdir(cwd);
        vi.stubEnv('CODEX_HOME', ch);
        const configure = (tier?: string) => writeFile(join(ch, 'config.toml'), [
            'model = "gpt-6-astra"', 'model_provider = "mock"',
            ...(tier === undefined ? [] : [`service_tier = "${tier}"`]),
            '[features]', 'fast_mode = true', 'ultrafast_mode = false',
            '[model_providers.mock]', 'name = "No model calls"', 'base_url = "http://127.0.0.1:1/v1"',
            'wire_api = "responses"', 'requires_openai_auth = false',
            '[analytics]', 'enabled = false', '[feedback]', 'enabled = false', ''
        ].join('\n'));
        const running: Array<{ abort: AbortController; done: Promise<void> }> = [];
        const clients: CodexAppServerClient[] = [];
        const { runSharedRuntime } = await import('./runtime');
        const start = async (overrides: Partial<import('./launch').SharedLaunchOptions> = {}) => {
            const abort = new AbortController(); let ready!: (value: import('./runtime').RuntimeReady) => void;
            const pending = new Promise<import('./runtime').RuntimeReady>(resolve => { ready = resolve; });
            const done = runSharedRuntime({ workingDirectory: cwd, ...overrides }, ready, abort.signal);
            running.push({ abort, done });
            const value = await Promise.race([pending, done.then(() => { throw new Error('Runtime stopped before ready'); })]);
            const client = new CodexAppServerClient({ endpoint: value.runtime.endpoint, token: value.runtime.token });
            clients.push(client); await initializeSharedClient(client);
            return { ...value, client, abort, done };
        };
        let failConfig: ReturnType<typeof vi.spyOn> | undefined;
        const extraSpies: Array<{ mockRestore(): void }> = [];
        let releaseLaunch = () => {};
        try {
            vi.mocked(bootstrapExistingSession).mockImplementation(async options => {
                const previous = state.sessions.get(options.sessionId)!;
                const session = new MockSession(options.workingDirectory, previous.sessionId); session.metadata = { ...previous.metadata }; session.serviceTier = previous.serviceTier;
                state.sessions.set(session.sessionId, session);
                return { session: session as unknown as ApiSessionClient, sessionInfo: { id: session.sessionId, namespace: 'test', serviceTier: session.serviceTier }, metadata: session.metadata,
                    workingDirectory: options.workingDirectory, machineId: 'test', startedBy: options.startedBy, api: {} } as never;
            });
            await configure('priority');
            const original = await start(); const threadId = original.runtime.sessions[original.sessionId].threadId;
            original.abort.abort(); await original.done;
            await configure('default');
            const second = await start();
            const { SharedCodexRoot } = await import('./root');
            const originalClose = SharedCodexRoot.prototype.close;
            let enteredClose!: () => void, releaseClose!: () => void;
            const closingEntered = new Promise<void>(resolve => { enteredClose = resolve; });
            const closingGate = new Promise<void>(resolve => { releaseClose = resolve; });
            const closing = vi.spyOn(SharedCodexRoot.prototype, 'close').mockImplementationOnce(async function(this: InstanceType<typeof SharedCodexRoot>, archived) {
                enteredClose(); await closingGate; return originalClose.call(this, archived);
            });
            extraSpies.push(closing); releaseLaunch = releaseClose;
            const concurrent = new CodexAppServerClient({ endpoint: second.runtime.endpoint, token: second.runtime.token });
            clients.push(concurrent); await initializeSharedClient(concurrent);
            let enteredConfig!: () => void, releaseConfig!: () => void;
            const enteredRead = new Promise<void>(resolve => { enteredConfig = resolve; });
            const configGate = new Promise<void>(resolve => { releaseConfig = resolve; });
            failConfig = vi.spyOn(CodexAppServerClient.prototype, 'readConfig').mockImplementationOnce(async () => {
                enteredConfig(); await configGate; throw new Error('fixture concurrent config unavailable');
            });
            const firstResume = second.client.request('thread/resume', { threadId, excludeTurns: true });
            void firstResume.catch(() => {});
            await enteredRead;
            try { await expect(concurrent.request('thread/resume', { threadId, excludeTurns: true })).rejects.toThrow('already being attached'); }
            finally { releaseConfig(); }
            await closingEntered;
            try {
                expect(second.runtime.sessions[original.sessionId].active).toBe(true);
                await expect(concurrent.request('thread/resume', { threadId, excludeTurns: true })).rejects.toThrow('already being attached');
            } finally { releaseClose(); }
            await expect(firstResume).rejects.toThrow('fixture concurrent config unavailable');
            closing.mockRestore();
            failConfig.mockRestore(); failConfig = undefined;
            failConfig = vi.spyOn(CodexAppServerClient.prototype, 'readConfig').mockRejectedValueOnce(new Error('fixture config unavailable'));
            await expect(second.client.request('thread/resume', { threadId, excludeTurns: true })).rejects.toThrow('fixture config unavailable');
            failConfig.mockRestore(); failConfig = undefined;
            expect(second.runtime.sessions[original.sessionId].active).toBe(false);
            expect(state.sessions.get(original.sessionId)?.metadata.lifecycleState).not.toBe('archived');
            const third = await start();
            const response = await third.client.request<{ serviceTier: string }>('thread/resume', { threadId, excludeTurns: true });
            expect(response.serviceTier).toBe('default');
            expect(state.sessions.get(original.sessionId)?.metadata.codexServiceTierExplicit).toBe(false);
            extraSpies.push(vi.spyOn(CodexAppServerClient.prototype, 'listModels').mockResolvedValue({ data: [
                { id: 'gpt-6-astra', serviceTiers: [{ id: 'ultrafast' }] },
                { id: 'gpt-6.1-sol', serviceTiers: [{ id: 'priority' }] },
            ] } as never));
            const originalRequest = CodexAppServerClient.prototype.request;
            const failSettings = vi.spyOn(CodexAppServerClient.prototype, 'request').mockImplementation(function<T>(this: CodexAppServerClient, method: string, params?: unknown): Promise<T> {
                if (method === 'thread/settings/update' && !clients.includes(this)) return Promise.reject(new Error('fixture Standard confirmation unavailable'));
                return originalRequest.call(this, method, params) as Promise<T>;
            });
            extraSpies.push(failSettings);
            const originalConfirm = SharedCodexRoot.prototype.confirmUltrafastLaunch;
            let entered!: (threadId: string) => void;
            const confirming = new Promise<string>(resolve => { entered = resolve; });
            const delayed = new Promise<void>(resolve => { releaseLaunch = resolve; });
            const confirmation = vi.spyOn(SharedCodexRoot.prototype, 'confirmUltrafastLaunch').mockImplementationOnce(async function(this: InstanceType<typeof SharedCodexRoot>, ...args) {
                entered(this.threadId); await delayed; return originalConfirm.apply(this, args);
            });
            extraSpies.push(confirmation);
            const observer = new CodexAppServerClient({ endpoint: second.runtime.endpoint, token: second.runtime.token });
            clients.push(observer); await initializeSharedClient(observer);
            const creating = second.client.request<{ thread: { id: string } }>('thread/start', { cwd, model: 'gpt-6-astra', serviceTier: 'ultrafast' });
            const confirmingThread = await confirming;
            await expect(observer.request('thread/queue/start', { threadId: confirmingThread })).rejects.toThrow('tier confirmation');
            await expect(observer.request('thread/settings/update', { threadId: confirmingThread, serviceTier: 'priority' })).rejects.toThrow('initialization is pending');
            releaseLaunch();
            const child = await creating;
            const childSid = Object.entries(second.runtime.sessions).find(([, binding]) => binding.threadId === child.thread.id)![0];
            const childSession = state.sessions.get(childSid)!;
            expect(childSession.metadata.codexTierConfirmationPending).toBe(true);
            expect(second.runtime.sessions[second.sessionId].active).toBe(true);
            await expect(second.client.request('turn/start', { threadId: child.thread.id, input: [{ type: 'text', text: 'must not execute' }] })).rejects.toThrow('tier confirmation');
            await expect(second.client.request('thread/queue/start', { threadId: child.thread.id })).rejects.toThrow('tier confirmation');
            const plan = await start({ collaborationMode: 'plan', serviceTier: 'ultrafast', model: 'gpt-6-astra' });
            const planThread = plan.runtime.sessions[plan.sessionId].threadId;
            expect(state.sessions.get(plan.sessionId)?.metadata.codexTierConfirmationPending).toBe(true);
            failSettings.mockRestore();
            await plan.client.request('thread/settings/update', { threadId: planThread, collaborationMode: { mode: 'default', settings: {
                model: 'gpt-6-astra', reasoning_effort: null, developer_instructions: null
            } } });
            await plan.client.request('thread/settings/update', { threadId: planThread, serviceTier: null });
            const planSettings = await plan.client.request<{ serviceTier: string; collaborationMode: { mode: string } }>('thread/resume', { threadId: planThread, excludeTurns: true });
            expect(planSettings.serviceTier).toBe('default'); expect(planSettings.collaborationMode.mode).toBe('default');
            expect(state.sessions.get(plan.sessionId)?.metadata.codexTierConfirmationPending).toBe(false);
            await observer.request('thread/settings/update', { threadId: child.thread.id, serviceTier: null });
            expect(childSession.metadata.codexTierConfirmationPending).toBe(false);
            expect((await second.client.request<{ serviceTier: string }>('thread/resume', { threadId: child.thread.id, excludeTurns: true })).serviceTier).toBe('default');
            const originalPrepare = SharedCodexRoot.prototype.prepareNativeTurn;
            let preparingRoot!: InstanceType<typeof SharedCodexRoot>, enterDiscovery!: () => void;
            const discovering = new Promise<void>(resolve => { enterDiscovery = resolve; });
            const discoveryGate = new Promise<void>(resolve => { releaseLaunch = resolve; });
            const prepare = vi.spyOn(SharedCodexRoot.prototype, 'prepareNativeTurn').mockImplementationOnce(async function(this: InstanceType<typeof SharedCodexRoot>, params) {
                preparingRoot = this; enterDiscovery(); await discoveryGate; return originalPrepare.call(this, params);
            });
            extraSpies.push(prepare);
            const heldTurn = observer.request('turn/start', { threadId: child.thread.id, model: 'gpt-6-astra', serviceTier: 'ultrafast', input: [{ type: 'text', text: 'must not be forwarded' }] });
            void heldTurn.catch(() => {});
            await discovering;
            const pause = vi.spyOn(preparingRoot, 'needsTierConfirmation', 'get').mockReturnValue(true); extraSpies.push(pause);
            releaseLaunch();
            await expect(heldTurn).rejects.toThrow('tier confirmation');
            await expect(observer.request('turn/steer', { threadId: child.thread.id, expectedTurnId: 'not-running', input: [{ type: 'text', text: 'must not steer' }] })).rejects.toThrow('tier confirmation');
            expect(record((await observer.request<{ thread: unknown }>('thread/read', { threadId: child.thread.id, includeTurns: true })).thread).turns).toEqual([]);
            pause.mockRestore(); prepare.mockRestore();
            const originalStandard = SharedCodexRoot.prototype.confirmStandardLaunch;
            const standardRace = vi.spyOn(SharedCodexRoot.prototype, 'confirmStandardLaunch').mockImplementationOnce(async function(this: InstanceType<typeof SharedCodexRoot>, explicit) {
                await this.client.request('thread/settings/update', { threadId: this.threadId, serviceTier: 'priority' });
                return originalStandard.call(this, explicit);
            }); extraSpies.push(standardRace);
            const unsupported = await second.client.request<{ thread: { id: string }; serviceTier: string }>('thread/start', { cwd, model: 'gpt-6.1-sol', serviceTier: 'ultrafast' });
            standardRace.mockRestore();
            expect(unsupported.serviceTier).toBe('default');
            expect((await second.client.request<{ serviceTier: string }>('thread/resume', { threadId: unsupported.thread.id, excludeTurns: true })).serviceTier).toBe('default');
            const unsupportedSid = Object.entries(second.runtime.sessions).find(([, binding]) => binding.threadId === unsupported.thread.id)![0];
            expect(state.sessions.get(unsupportedSid)?.messages).toContainEqual({ type: 'message', message: 'Ultrafast was not advertised by the current Codex model catalog; changed to Standard.' });
            const failedStandard = vi.spyOn(SharedCodexRoot.prototype, 'confirmStandardLaunch').mockRejectedValueOnce(new Error('fixture fallback confirmation unavailable'));
            extraSpies.push(failedStandard);
            const pausedFallback = await second.client.request<{ thread: { id: string } }>('thread/start', { cwd, model: 'gpt-6.1-sol', serviceTier: 'ultrafast' });
            failedStandard.mockRestore();
            const pausedSid = Object.entries(second.runtime.sessions).find(([, binding]) => binding.threadId === pausedFallback.thread.id)![0];
            expect(state.sessions.get(pausedSid)?.metadata.codexTierConfirmationPending).toBe(true);
            expect(state.sessions.get(pausedSid)?.messages).not.toContainEqual({ type: 'message', message: 'Ultrafast was not advertised by the current Codex model catalog; changed to Standard.' });
            await second.client.request('thread/settings/update', { threadId: pausedFallback.thread.id, serviceTier: null });
            expect(state.sessions.get(pausedSid)?.metadata.codexTierConfirmationPending).toBe(false);
            await second.client.request('thread/settings/update', { threadId: unsupported.thread.id, serviceTier: 'priority' });
            second.abort.abort(); await second.done;
            // Re-import selected Ultrafast in HAPI while the native snapshot still stores Fast.
            state.sessions.get(unsupportedSid)!.serviceTier = 'ultrafast';
            state.sessions.get(unsupportedSid)!.metadata.codexServiceTierExplicit = true;
            const resumed = await third.client.request<{ serviceTier: string }>('thread/resume', { threadId: unsupported.thread.id, model: 'gpt-6.1-sol', excludeTurns: true });
            expect(resumed.serviceTier).toBe('default');
            // Persisted recovery state must fence input before a cold bind completes.
            state.sessions.get(childSid)!.metadata.codexTierConfirmationPending = true;
            state.sessions.get(childSid)!.metadata.codexServiceTierExplicit = true;
            state.sessions.get(childSid)!.serviceTier = 'fast';
            const recoveryClient = new CodexAppServerClient({ endpoint: third.runtime.endpoint, token: third.runtime.token });
            clients.push(recoveryClient); await initializeSharedClient(recoveryClient);
            let binding!: () => void;
            const enteredBind = new Promise<void>(resolve => { binding = resolve; });
            const bindGate = new Promise<void>(resolve => { releaseLaunch = resolve; });
            const metadataDelay = vi.spyOn(CodexAppServerClient.prototype, 'request').mockImplementation(function<T>(this: CodexAppServerClient, method: string, params?: unknown): Promise<T> {
                if (method === 'thread/metadata/update' && (params as { threadId?: string })?.threadId === child.thread.id) {
                    binding(); return bindGate.then(() => originalRequest.call(this, method, params)) as Promise<T>;
                }
                return originalRequest.call(this, method, params) as Promise<T>;
            });
            extraSpies.push(metadataDelay);
            const coldPending = third.client.request('thread/resume', { threadId: child.thread.id, excludeTurns: true });
            await enteredBind;
            await expect(recoveryClient.request('thread/queue/start', { threadId: child.thread.id })).rejects.toThrow('tier confirmation');
            releaseLaunch(); await coldPending;
            await recoveryClient.request('thread/settings/update', { threadId: child.thread.id, serviceTier: null });
            expect(state.sessions.get(childSid)?.metadata.codexTierConfirmationPending).toBe(false);
            metadataDelay.mockRestore();
            // Accepted input must not wait for side-client settings reconciliation.
            let lookupEntered!: () => void;
            const lookupStarted = new Promise<void>(resolve => { lookupEntered = resolve; });
            const lookupGate = new Promise<void>(resolve => { releaseLaunch = resolve; });
            const stalledSnapshot = vi.spyOn(CodexAppServerClient.prototype, 'request').mockImplementation(function<T>(this: CodexAppServerClient, method: string, params?: unknown): Promise<T> {
                if (this !== third.client && method === 'thread/resume' && (params as { threadId?: string })?.threadId === unsupported.thread.id) {
                    lookupEntered(); return lookupGate.then(() => originalRequest.call(this, method, params)) as Promise<T>;
                }
                return originalRequest.call(this, method, params) as Promise<T>;
            });
            extraSpies.push(stalledSnapshot);
            state.sessions.get(unsupportedSid)!.metadata.codexServiceTierExplicit = false;
            const accepted = third.client.request<{ turn: { id: string } }>('turn/start', { threadId: unsupported.thread.id, model: 'gpt-6.1-sol',
                serviceTier: 'priority', input: [{ type: 'text', text: 'Local no-network acceptance test', text_elements: [] }] });
            await lookupStarted;
            const result = await Promise.race([accepted, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Accepted turn blocked on snapshot')), 2_000))]);
            expect(result.turn.id).toBeTruthy();
            expect(state.sessions.get(unsupportedSid)!.metadata.codexServiceTierExplicit).toBe(true);
            await third.client.request('thread/settings/update', { threadId: unsupported.thread.id, model: 'gpt-6-astra' });
            releaseLaunch(); stalledSnapshot.mockRestore();
            expect(state.sessions.get(unsupportedSid)!.metadata.codexServiceTierExplicit).toBe(true);
            await third.client.request('turn/interrupt', { threadId: unsupported.thread.id, turnId: result.turn.id }).catch(() => {});
            await configure();
            const unset = await start();
            const unsetThread = unset.runtime.sessions[unset.sessionId].threadId;
            expect((await unset.client.request<{ serviceTier: string | null }>('thread/resume', { threadId: unsetThread, excludeTurns: true })).serviceTier).toBeNull();
            unset.abort.abort(); await unset.done;
            const inherited = await start();
            expect((await inherited.client.request<{ serviceTier: string | null }>('thread/resume', { threadId: unsetThread, excludeTurns: true })).serviceTier).toBeNull();
            inherited.abort.abort(); await inherited.done;
            const validatedCwd = join(home, 'runner-validated'); await mkdir(validatedCwd);
            const runner = await start({ startedBy: 'runner', workingDirectory: validatedCwd, resumeSessionId: unsetThread });
            expect(vi.mocked(bootstrapExistingSession).mock.calls.at(-1)?.[0].workingDirectory).toBe(validatedCwd);
            const saved = await runner.client.request<{ thread: { cwd: string } }>('thread/read', { threadId: unsetThread, includeTurns: false });
            expect((await realpath(saved.thread.cwd)).toLowerCase()).toBe((await realpath(validatedCwd)).toLowerCase());
        } finally {
            releaseLaunch();
            for (const spy of extraSpies.reverse()) spy.mockRestore();
            failConfig?.mockRestore(); vi.mocked(bootstrapExistingSession).mockReset();
            for (const item of running) item.abort.abort();
            await Promise.allSettled(running.map(item => item.done));
            await Promise.allSettled(clients.map(client => client.disconnect()));
            await rm(home, { recursive: true, force: true, maxRetries: 3 });
        }
    }, 90_000);
    it('projects native async questions and delivers answers during generation and after completion', async () => {
        const home = await mkdtemp('/tmp/hapi-shared-async-'); state.home = home;
        const ch = join(home, 'codex'); const cwd = join(home, 'work'); await mkdir(ch); await mkdir(cwd);
        const modelRequests: Record<string, unknown>[] = [];
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const questions = [{ title: 'Which client?', options: ['Web', 'Terminal'] }, { title: 'Any details?' }];
        const http = createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on('data', chunk => chunks.push(Buffer.from(chunk)));
            request.on('end', () => { void (async () => {
                if (!request.url?.endsWith('/responses')) { response.writeHead(404).end(); return; }
                modelRequests.push(record(JSON.parse(Buffer.concat(chunks).toString())));
                const count = modelRequests.length;
                if (count === 2) await gate;
                const id = randomUUID();
                const item = count === 1 ? { type: 'function_call', call_id: 'call_async', name: 'request_user_input_async', arguments: JSON.stringify({ questions }) }
                    : { type: 'message', role: 'assistant', id: `msg_${id}`, content: [{ type: 'output_text', text: 'MOCK DONE' }] };
                const events = [{ type: 'response.created', response: { id } }, { type: 'response.output_item.done', item },
                    { type: 'response.completed', response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } }];
                response.writeHead(200, { 'Content-Type': 'text/event-stream' });
                response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
            })(); });
        });
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        const port = (http.address() as { port: number }).port;
        // This model's bundled tool catalog includes request_user_input_async.
        // All Responses traffic goes to the isolated mock; no model credentials.
        await writeFile(join(ch, 'config.toml'), `model = "gpt-6.1-sol"\nmodel_provider = "mock_provider"\napproval_policy = "never"\nsandbox_mode = "read-only"\ncheck_for_update_on_startup = false\n[features]\nsend_message_to_user_async = true\n[model_providers.mock_provider]\nname = "Isolated mock"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n[projects."${cwd}"]\ntrust_level = "trusted"\n`);
        vi.stubEnv('CODEX_HOME', ch);
        const { runSharedRuntime } = await import('./runtime');
        let ready!: (value: import('./runtime').RuntimeReady) => void;
        const readiness = new Promise<import('./runtime').RuntimeReady>(resolve => { ready = resolve; });
        const abort = new AbortController();
        const running = runSharedRuntime({ workingDirectory: cwd }, ready, abort.signal);
        let client: CodexAppServerClient | undefined;
        try {
            const { runtime, sessionId } = await Promise.race([readiness, running.then(() => { throw new Error('Runtime stopped before ready'); })]);
            const threadId = runtime.sessions[sessionId].threadId;
            const web = state.sessions.get(sessionId)!;
            client = new CodexAppServerClient({ endpoint: runtime.endpoint, token: runtime.token });
            const nativeRequests = vi.fn(); client.setServerRequestHandler(nativeRequests); await initializeSharedClient(client);
            await client.request('thread/resume', { threadId });
            web.user?.({ content: { text: 'ASK ASYNC' } }, 'async-prompt');
            await vi.waitFor(() => expect(Object.keys(web.state.requests ?? {})).toHaveLength(2), { timeout: 15_000 });
            expect(nativeRequests).not.toHaveBeenCalled();
            const [choice, details] = asyncQuestionsForItem(threadId, { type: 'agentMessage', id: 'call_async', delivery: 'async', questions });
            expect(web.messages).toContainEqual(expect.objectContaining({ type: 'tool-call', name: 'request_user_input', callId: choice.id }));
            await vi.waitFor(() => expect(modelRequests.length).toBe(2));
            await web.rpc.get('permission')!({ id: choice.id, approved: true, answers: { [choice.questionItemId]: ['Web'] } });
            release();
            await vi.waitFor(() => expect(web.state.completedRequests?.[choice.id]?.status).toBe('resolved'), { timeout: 15_000 });
            await vi.waitFor(() => expect(web.state.steeringActive).toBe(false), { timeout: 15_000 });
            expect(web.state.requests?.[details.id]).toBeDefined();
            await web.rpc.get('permission')!({ id: details.id, approved: true, answers: { [details.questionItemId]: ['user_note: From mobile'] } });
            await vi.waitFor(() => expect(web.state.completedRequests?.[details.id]?.status).toBe('resolved'), { timeout: 15_000 });
            await vi.waitFor(() => expect(web.messages).toContainEqual({ user: 'Any details?\nFrom mobile' }));
            await vi.waitFor(() => expect(JSON.stringify(modelRequests)).toContain('From mobile'), { timeout: 15_000 });
            expect(JSON.stringify(modelRequests)).toContain('send_user_message_question_reply');
            const history = record(record(await client.request('thread/read', { threadId, includeTurns: true })).thread);
            const items = (history.turns as Array<{ items: unknown[] }>).flatMap(turn => turn.items);
            expect(items).toContainEqual(expect.objectContaining({ type: 'agentMessage', id: 'call_async', delivery: 'async',
                questions: [{ title: 'Which client?', options: ['Web', 'Terminal'] }, { title: 'Any details?', options: null }] }));
            expect(Object.keys(web.state.requests ?? {})).toHaveLength(0);
        } finally {
            release(); abort.abort(); await running.catch(() => {}); await client?.disconnect();
            await new Promise<void>(resolve => http.close(() => resolve()));
            await rm(home, { recursive: true, force: true, maxRetries: 3 });
        }
    }, 60_000);
    it('seeds the generated fork title before binding child history', async () => {
        const home = await mkdtemp('/tmp/hapi-shared-fork-summary-'); state.home = home;
        const ch = join(home, 'codex'); const cwd = join(home, 'work'); await mkdir(ch); await mkdir(cwd);
        const http = createServer((request, response) => {
            if (!request.url?.endsWith('/responses')) { response.writeHead(404).end(); return; }
            request.resume();
            request.on('end', () => {
                const id = randomUUID();
                const events = [
                    { type: 'response.created', response: { id } },
                    { type: 'response.output_item.done', item: { id: `msg_${id}`, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'MOCK' }] } },
                    { type: 'response.completed', response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } }
                ];
                response.writeHead(200, { 'Content-Type': 'text/event-stream' });
                response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
            });
        });
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        const port = (http.address() as { port: number }).port;
        await writeFile(join(ch, 'config.toml'), `model = "mock-model"\nmodel_provider = "mock_provider"\napproval_policy = "never"\nsandbox_mode = "read-only"\ncheck_for_update_on_startup = false\n[model_providers.mock_provider]\nname = "Isolated mock"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n[projects."${cwd}"]\ntrust_level = "trusted"\n`);
        vi.stubEnv('CODEX_HOME', ch);
        const { runSharedRuntime } = await import('./runtime');
        let ready!: (value: import('./runtime').RuntimeReady) => void;
        const readiness = new Promise<import('./runtime').RuntimeReady>(resolve => { ready = resolve; });
        const abort = new AbortController();
        const running = runSharedRuntime({ workingDirectory: cwd }, ready, abort.signal);
        try {
            const { sessionId } = await Promise.race([readiness, running.then(() => { throw new Error('Runtime stopped before ready'); })]);
            const source = state.sessions.get(sessionId)!;
            source.updateMetadata(metadata => ({ ...metadata, name: 'Source title' }));
            const result = record(await source.rpc.get(RPC_METHODS.ForkConversation)!({}));
            const child = state.sessions.get(String(result.sessionId))!;
            expect(result.sessionId).not.toBe(sessionId);
            expect(child.metadata.summary).toMatchObject({ text: 'Fork: Source title' });
            expect(child.metadata.name).toBeUndefined();
        } finally {
            abort.abort(); await running.catch(() => {});
            await new Promise<void>(resolve => http.close(() => resolve()));
            await rm(home, { recursive: true, force: true, maxRetries: 3 });
        }
    }, 60_000);
    it('rejects a child ID before creating a HAPI binding or calling native resume', async () => {
        const home = await mkdtemp('/tmp/hapi-shared-child-'); state.home = home;
        const ch = join(home, 'codex'); await mkdir(ch);
        await writeFile(join(ch, 'config.toml'), 'model = "mock-model"\nmodel_provider = "mock"\n[model_providers.mock]\nname = "No model calls"\nbase_url = "http://127.0.0.1:1/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n');
        vi.stubEnv('CODEX_HOME', ch); vi.stubEnv('HOME', home);
        // Only the read-only ancestry reply is stubbed; startup/shutdown use
        // the installed native engine. No child is actually resumed.
        const originalRequest = CodexAppServerClient.prototype.request;
        const requests = vi.spyOn(CodexAppServerClient.prototype, 'request').mockImplementation(function<T>(this: CodexAppServerClient, method: string, params?: unknown): Promise<T> {
            if (method === 'thread/read' && record(params).threadId === 'child') {
                return Promise.resolve({ thread: { id: 'child', parentThreadId: 'parent' } } as T);
            }
            return originalRequest.call(this, method, params) as Promise<T>;
        });
        const ready = vi.fn();
        try {
            const { runSharedRuntime } = await import('./runtime');
            await expect(runSharedRuntime({ workingDirectory: home, resumeSessionId: 'child' }, ready))
                .rejects.toThrow('Cannot cold-resume a child agent independently');
            expect(ready).not.toHaveBeenCalled(); expect(state.sessions.size).toBe(0);
            expect(requests.mock.calls.some(([method]) => method === 'thread/resume')).toBe(false);
        } finally { requests.mockRestore(); await rm(home, { recursive: true, force: true }); }
    }, 30_000);
    it.each(['abort', 'failure'])('cleans up the native engine and partial roots on startup %s', async outcome => {
        const home = await mkdtemp('/tmp/hapi-shared-startup-'); state.home = home;
        const ch = join(home, 'codex'); await mkdir(ch);
        await writeFile(join(ch, 'config.toml'), 'model = "mock-model"\nmodel_provider = "mock"\n[model_providers.mock]\nname = "No model calls"\nbase_url = "http://127.0.0.1:1/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n');
        vi.stubEnv('CODEX_HOME', ch); vi.stubEnv('HOME', home);
        let entered!: () => void; let release!: () => void;
        const reached = new Promise<void>(resolve => { entered = resolve; });
        const gate = new Promise<void>(resolve => { release = resolve; });
        state.beforeBootstrap = async () => { entered(); await gate; if (outcome === 'failure') throw new Error('bootstrap failure'); };
        const abort = new AbortController(); const ready = vi.fn();
        const { runSharedRuntime } = await import('./runtime');
        const running = runSharedRuntime({ workingDirectory: home }, ready, abort.signal);
        const result = outcome === 'failure' ? expect(running).rejects.toThrow('bootstrap failure') : expect(running).resolves.toBeUndefined();
        try {
            await Promise.race([reached, running]);
            if (outcome === 'abort') abort.abort();
            release(); await result;
            expect(ready).not.toHaveBeenCalled();
            const { readRuntimes } = await import('./registry');
            const records = await readRuntimes(); expect(records).toHaveLength(1);
            expect(isProcessAlive(records[0].serverPid!)).toBe(false);
            for (const session of state.sessions.values()) {
                expect(session.dead).toBe(true); expect(session.metadata.lifecycleState).not.toBe('archived');
            }
        } finally { release(); abort.abort(); await running.catch(() => {}); await rm(home, { recursive: true, force: true }); }
    }, 30_000);
    it('reports the bootstrap start marker to the runner although the hub view of the metadata lacks it', async () => {
        const home = await mkdtemp('/tmp/hapi-shared-marker-'); state.home = home;
        const ch = join(home, 'codex'); const cwd = join(home, 'work'); await mkdir(ch); await mkdir(cwd);
        await writeFile(join(ch, 'config.toml'), `model = "mock-model"\nmodel_provider = "mock"\n[model_providers.mock]\nname = "No model calls"\nbase_url = "http://127.0.0.1:1/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n[projects."${cwd}"]\ntrust_level = "trusted"\n`);
        vi.stubEnv('CODEX_HOME', ch); vi.stubEnv('HOME', home);
        const { runSharedRuntime } = await import('./runtime');
        let ready!: (value: import('./runtime').RuntimeReady) => void;
        const readiness = new Promise<import('./runtime').RuntimeReady>(resolve => { ready = resolve; });
        const abort = new AbortController();
        const running = runSharedRuntime({ workingDirectory: cwd }, ready, abort.signal);
        try {
            const { runtime, sessionId } = await Promise.race([readiness, running.then(() => { throw new Error('Runtime stopped before ready'); })]);
            // The runner adopts an untracked runner-started webhook only when the
            // marker proves the process generation (decideUntrackedRunnerWebhook),
            // so the webhook must not depend on the hub echoing the field back.
            expect(vi.mocked(notifyRunnerSessionStarted)).toHaveBeenCalledWith(sessionId,
                expect.objectContaining({ codexSessionId: runtime.sessions[sessionId].threadId, hostStartMarker: BOOTSTRAP_START_MARKER }));
        } finally { abort.abort(); await running.catch(() => {}); await rm(home, { recursive: true, force: true, maxRetries: 3 }); }
    }, 30_000);
    it('binds empty roots, exchanges messages, isolates /new, and archives only the selected root', async () => {
        const home = await mkdtemp('/tmp/hapi-shared-test-'); state.home = home;
        const ch = join(home, 'codex'); const cwd = join(home, 'work'); await mkdir(ch); await mkdir(cwd);
        const modelRequests: unknown[] = [];
        const http = createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on('data', chunk => chunks.push(Buffer.from(chunk)));
            request.on('end', () => {
                if (!request.url?.endsWith('/responses')) { response.writeHead(404).end(); return; }
                modelRequests.push(JSON.parse(Buffer.concat(chunks).toString()));
                const id = randomUUID();
                const events = [{ type: 'response.created', response: { id } },
                    { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `msg_${id}`, content: [{ type: 'output_text', text: 'MOCK ANSWER' }] } },
                    { type: 'response.completed', response: { id, usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } } }];
                response.writeHead(200, { 'Content-Type': 'text/event-stream' });
                response.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
            });
        });
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        const port = (http.address() as { port: number }).port;
        await writeFile(join(ch, 'config.toml'), `model = "mock-model"\nmodel_provider = "mock_provider"\napproval_policy = "never"\nsandbox_mode = "read-only"\ncheck_for_update_on_startup = false\n[model_providers.mock_provider]\nname = "Isolated mock"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n[projects."${cwd}"]\ntrust_level = "trusted"\n`);
        vi.stubEnv('CODEX_HOME', ch); vi.stubEnv('HOME', home); vi.stubEnv('HAPI_SESSION_ID', 'parent-must-not-leak');
        const { runSharedRuntime } = await import('./runtime');
        let ready!: (value: import('./runtime').RuntimeReady) => void;
        const readiness = new Promise<import('./runtime').RuntimeReady>(resolve => { ready = resolve; });
        const abort = new AbortController();
        const running = runSharedRuntime({ workingDirectory: cwd }, ready, abort.signal);
        const clients: CodexAppServerClient[] = [];
        let roots: string[] = [];
        try {
            const { runtime, sessionId } = await Promise.race([readiness, running.then(() => { throw new Error('Runtime stopped before ready'); })]);
            const connect = async () => { const client = new CodexAppServerClient({ endpoint: runtime.endpoint, token: runtime.token });
                client.setServerRequestHandler(() => {}); clients.push(client); await initializeSharedClient(client); return client; };
            const first = await connect(); const second = await connect();
            const initial = runtime.sessions[sessionId].threadId; roots.push(initial);
            const resumed = record(await first.request('thread/resume', { threadId: initial }));
            await second.request('thread/resume', { threadId: initial });
            expect(record(resumed.thread).turns).toEqual([]); expect(modelRequests).toHaveLength(0);
            expect(state.sessions.size).toBe(1);
            const web = state.sessions.get(sessionId)!;
            expect(web.state.requests).toEqual({});
            expect(web.state.completedRequests?.['old-worker']?.status).toBe('canceled');
            web.user?.({ content: { text: 'HELLO FROM WEB' } }, 'web-1');
            await vi.waitFor(() => expect(web.consumed).toContain('web-1'), { timeout: 15_000 });
            await vi.waitFor(() => expect(web.messages).toContainEqual(expect.objectContaining({ type: 'message', message: 'MOCK ANSWER' })), { timeout: 15_000 });
            const newResponse = record(await first.request('thread/start', { cwd }));
            const next = String(record(newResponse.thread).id); roots.push(next);
            expect(next).not.toBe(initial); expect(state.sessions.size).toBe(2);
            const nextSession = [...state.sessions.values()].find(session => session.metadata.codexSessionId === next)!;
            expect(web.metadata.codexSessionId).toBe(initial);
            expect(process.env.HAPI_SESSION_ID).toBe('parent-must-not-leak');
            // A thread created through the gateway (native /new) is fresh: the
            // first turn must measure from the zero seed, not a null baseline.
            await first.request('turn/start', { threadId: next, input: [{ type: 'text', text: 'HELLO NEW THREAD', text_elements: [] }] });
            await vi.waitFor(() => expect(nextSession.messages).toContainEqual(expect.objectContaining({
                type: 'turn_duration', generationMs: expect.any(Number), generationOutputTokens: 3
            })), { timeout: 15_000 });
            await first.request('thread/archive', { threadId: next }); roots = [initial];
            await vi.waitFor(() => expect(nextSession.dead).toBe(true)); expect(web.dead).toBe(false);
            await second.request('turn/start', { threadId: initial, model: 'second-mock', input: [{ type: 'text', text: 'HELLO FROM TERMINAL', text_elements: [] }], clientUserMessageId: 'native-1' });
            await vi.waitFor(() => expect(web.messages).toContainEqual({ user: 'HELLO FROM TERMINAL' }), { timeout: 15_000 });
            await vi.waitFor(() => {
                const usageModels = web.messages.map(record).filter(body => body.type === 'token_count').map(body => body.model);
                expect(usageModels).toContain('mock-model');
                expect(usageModels).toContain('second-mock');
            }, { timeout: 15_000 });
            await first.disconnect(); expect(web.dead).toBe(false);
            await second.request('thread/archive', { threadId: initial }); roots = [];
            await running;
        } finally {
            for (const threadId of roots) {
                await clients.at(-1)?.request('thread/archive', { threadId }).catch(() => {});
            }
            abort.abort(); await running.catch(() => {});
            await Promise.all(clients.map(client => client.disconnect()));
            await new Promise<void>(resolve => http.close(() => resolve()));
            await rm(home, { recursive: true, force: true, maxRetries: 3 });
        }
    }, 60_000);
    it('seeds a gateway-created thread before session-ready releases queued input', async () => {
        const home = await mkdtemp('/tmp/hapi-shared-gateway-seed-'); state.home = home;
        const ch = join(home, 'codex'); const cwd = join(home, 'work'); await mkdir(ch); await mkdir(cwd);
        const modelRequests: unknown[] = [];
        const http = createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on('data', chunk => chunks.push(Buffer.from(chunk)));
            request.on('end', () => {
                if (!request.url?.endsWith('/responses')) { response.writeHead(404).end(); return; }
                modelRequests.push(JSON.parse(Buffer.concat(chunks).toString()));
                const id = randomUUID();
                const events = [{ type: 'response.created', response: { id } },
                    { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `msg_${id}`, content: [{ type: 'output_text', text: 'MOCK ANSWER' }] } },
                    { type: 'response.completed', response: { id, usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } } }];
                response.writeHead(200, { 'Content-Type': 'text/event-stream' });
                response.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
            });
        });
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        const port = (http.address() as { port: number }).port;
        await writeFile(join(ch, 'config.toml'), `model = "mock-model"\nmodel_provider = "mock_provider"\napproval_policy = "never"\nsandbox_mode = "read-only"\ncheck_for_update_on_startup = false\n[model_providers.mock_provider]\nname = "Isolated mock"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n[projects."${cwd}"]\ntrust_level = "trusted"\n`);
        vi.stubEnv('CODEX_HOME', ch); vi.stubEnv('HOME', home);
        const { runSharedRuntime } = await import('./runtime');
        let ready!: (value: import('./runtime').RuntimeReady) => void;
        const readiness = new Promise<import('./runtime').RuntimeReady>(resolve => { ready = resolve; });
        const abort = new AbortController();
        const running = runSharedRuntime({ workingDirectory: cwd }, ready, abort.signal);
        const clients: CodexAppServerClient[] = [];
        // Hold the runner notification for the gateway-created session: the
        // zero seed used to wait behind it while session-ready had already
        // released input, and a later seed cannot repair that first turn.
        let releaseRunner!: () => void;
        const runnerGate = new Promise<void>(resolve => { releaseRunner = resolve; });
        let released = false;
        const release = () => { if (!released) { released = true; releaseRunner(); } };
        const originalReady = MockSession.prototype.emitSessionReady;
        try {
            const { runtime, sessionId } = await Promise.race([readiness, running.then(() => { throw new Error('Runtime stopped before ready'); })]);
            const firstWeb = state.sessions.get(sessionId)!;
            vi.mocked(notifyRunnerSessionStarted).mockImplementation(async (id: string) => {
                if (id !== sessionId) await runnerGate;
                return {};
            });
            // The hub releases a queued prompt the moment session-ready fires.
            MockSession.prototype.emitSessionReady = function (this: MockSession) {
                this.user?.({ content: { text: 'QUEUED AT READY' } }, 'queued-at-ready');
                originalReady.call(this);
            };
            const first = new CodexAppServerClient({ endpoint: runtime.endpoint, token: runtime.token });
            clients.push(first); first.setServerRequestHandler(() => {}); await initializeSharedClient(first);
            const started = first.request('thread/start', { cwd });
            const nextSession = await vi.waitFor(() => {
                const session = [...state.sessions.values()].find(candidate => candidate !== firstWeb);
                expect(session, 'gateway session created').toBeDefined();
                return session!;
            }, { timeout: 15_000 });
            // The queued turn runs to completion while the runner notification
            // is still gated: its first turn must already measure from the
            // zero seed.
            await vi.waitFor(() => expect(nextSession.messages).toContainEqual(expect.objectContaining({
                type: 'turn_duration', generationMs: expect.any(Number), generationOutputTokens: 3
            })), { timeout: 15_000 });
            expect(JSON.stringify(modelRequests)).toContain('QUEUED AT READY');
            release();
            await started;
        } finally {
            MockSession.prototype.emitSessionReady = originalReady;
            release();
            vi.mocked(notifyRunnerSessionStarted).mockImplementation(async () => ({}));
            abort.abort(); await running.catch(() => {});
            await Promise.all(clients.map(client => client.disconnect()));
            await new Promise<void>(resolve => http.close(() => resolve()));
            await rm(home, { recursive: true, force: true, maxRetries: 3 });
        }
    }, 60_000);
});

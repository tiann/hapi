import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentState, Metadata } from '@/api/types';
import type { ApiSessionClient } from '@/api/apiSession';
import { CodexAppServerClient } from '../codexAppServerClient';
import { initializeSharedClient } from './launch';
import { record } from './gateway';
import { isProcessAlive } from '@/utils/process';

const state = vi.hoisted(() => ({ home: '', sessions: new Map<string, MockSession>(), beforeBootstrap: undefined as (() => Promise<void>) | undefined }));
class MockSession {
    readonly sessionId = randomUUID();
    state: AgentState = { requests: { 'old-worker': { tool: 'request_user_input', arguments: {}, createdAt: 0 } } }; metadata: Metadata;
    messages: unknown[] = []; consumed: string[] = []; dead = false;
    user?: (message: { content: { text: string } }, id?: string) => void;
    rpc = new Map<string, (params: unknown) => Promise<unknown>>();
    rpcHandlerManager = { registerHandler: (name: string, fn: (params: unknown) => Promise<unknown>) => { this.rpc.set(name, fn); } };
    constructor(cwd: string) { this.metadata = { path: cwd, host: 'test', hostPid: process.pid, machineId: 'test', flavor: 'codex', capabilities: { concurrentClients: true } }; }
    getMetadata() { return this.metadata; }
    updateMetadata(fn: (m: Metadata) => Metadata) { this.metadata = fn(this.metadata); }
    updateAgentState(fn: (s: AgentState) => AgentState) { this.state = fn(this.state); }
    onUserMessage(fn: MockSession['user']) { this.user = fn; }
    onCancelQueuedMessage() {} onRetryQueuedMessage() {} onReconnect() {}
    sendUserMessage(text: string) { this.messages.push({ user: text }); }
    sendAgentMessage(body: unknown) { this.messages.push(body); }
    sendSessionEvent(body: unknown) { this.messages.push(body); }
    emitMessagesConsumed(ids: string[]) { this.consumed.push(...ids); }
    emitSteerIndeterminate() {} keepAlive() {} emitSessionReady() {}
    async setSteerDeliveryState() { return true; }
    syncNativeQueuedMessage() {}
    sendSessionDeath() { this.dead = true; } async flush() { return true; } async flushMetadata() { return true; } close() {} isPending() { return false; }
}
vi.mock('@/configuration', () => ({ configuration: { get happyHomeDir() { return state.home; }, apiUrl: 'http://mock-hub', cliApiToken: 'test' } }));
vi.mock('@/ui/logger', () => ({ logger: { debug: (...args: unknown[]) => { if (process.env.HAPI_DEBUG_SHARED_TEST) console.log(...args); }, warn: vi.fn(), info: vi.fn(), debugLargeJson: vi.fn() } }));
vi.mock('@/agent/sessionFactory', () => ({ bootstrapSession: async (options: { workingDirectory: string; metadataOverrides: Partial<Metadata> }) => {
    await state.beforeBootstrap?.();
    const session = new MockSession(options.workingDirectory); session.metadata = { ...session.metadata, ...options.metadataOverrides };
    state.sessions.set(session.sessionId, session);
    return { session: session as unknown as ApiSessionClient, sessionInfo: { id: session.sessionId, namespace: 'test' }, metadata: session.metadata,
        workingDirectory: options.workingDirectory, machineId: 'test', startedBy: 'terminal', api: {} };
}, bootstrapExistingSession: async (options: { sessionId: string; workingDirectory: string }) => {
    await state.beforeBootstrap?.();
    const session = state.sessions.get(options.sessionId)!;
    return { session: session as unknown as ApiSessionClient, sessionInfo: { id: session.sessionId, namespace: 'test', metadata: structuredClone(session.metadata) },
        metadata: session.metadata, workingDirectory: options.workingDirectory, machineId: 'test', startedBy: 'runner', api: {} };
} }));
vi.mock('@/api/api', () => ({ ApiClient: { create: async () => ({ getSession: async (id: string) => ({ id, active: false, metadata: state.sessions.get(id)!.metadata }) }) } }));
vi.mock('@/runner/controlClient', () => ({ notifyRunnerSessionStarted: vi.fn(async () => ({})) }));
vi.mock('../utils/buildHapiMcpBridge', () => ({ buildHapiMcpBridge: async () => ({ server: { url: 'http://unused', stop() {} }, mcpServers: {} }) }));

// Explicit opt-in: installed official binary, entirely isolated CODEX_HOME, mock Responses API only.
describe.skipIf(process.env.HAPI_RUN_SHARED_CODEX_TESTS !== '1')('installed Codex shared runtime', () => {
    afterEach(() => { vi.unstubAllEnvs(); state.sessions.clear(); state.beforeBootstrap = undefined; });
    it.each(['source-return', 'missing-id', 'native-error', 'cleanup', 'changed-boundary', 'changed-source'])('preserves a pending child on %s without binding the source', async failure => {
        const home = await mkdtemp('/tmp/hapi-shared-pending-'); state.home = home;
        const ch = join(home, 'codex'); await mkdir(ch);
        await writeFile(join(ch, 'config.toml'), 'model = "mock-model"\nmodel_provider = "mock"\n[model_providers.mock]\nname = "No model calls"\nbase_url = "http://127.0.0.1:1/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n');
        vi.stubEnv('CODEX_HOME', ch); vi.stubEnv('HOME', home);
        const child = new MockSession(home);
        child.metadata = { ...child.metadata, codexSessionId: 'source', codexForkRequest: { sourceThreadId: 'source', beforeTurnId: 'boundary' } };
        state.sessions.set(child.sessionId, child);
        state.beforeBootstrap = async () => {
            if (failure === 'cleanup') child.metadata.codexForkCleanup = { sourceSessionId: 'parent', machineId: 'test' };
            if (failure === 'changed-boundary') child.metadata.codexForkRequest!.beforeTurnId = 'other';
            if (failure === 'changed-source') child.metadata.codexSessionId = 'other';
        };
        const originalRequest = CodexAppServerClient.prototype.request;
        const requests = vi.spyOn(CodexAppServerClient.prototype, 'request').mockImplementation(function<T>(this: CodexAppServerClient, method: string, params?: unknown): Promise<T> {
            if (method === 'thread/fork') {
                if (failure === 'native-error') return Promise.reject(new Error('native fork rejected'));
                return Promise.resolve({ thread: failure === 'missing-id' ? {} : { id: 'source' } } as T);
            }
            return originalRequest.call(this, method, params) as Promise<T>;
        });
        const ready = vi.fn();
        try {
            const { runSharedRuntime } = await import('./runtime');
            await expect(runSharedRuntime({ workingDirectory: home, existingSessionId: child.sessionId, resumeSessionId: 'source' }, ready)).rejects.toThrow();
            expect(ready).not.toHaveBeenCalled(); expect(child.metadata.codexForkRequest).toBeDefined();
            expect(child.consumed).toEqual([]); expect(child.metadata.lifecycleState).not.toBe('archived');
            expect(requests.mock.calls.some(([method]) => method === 'thread/resume')).toBe(false);
            const forks = requests.mock.calls.filter(([method]) => method === 'thread/fork');
            if (['cleanup', 'changed-boundary', 'changed-source'].includes(failure)) expect(forks).toHaveLength(0);
            else {
                expect(forks).toHaveLength(1);
                expect(forks[0][1]).toMatchObject({ threadId: 'source', beforeTurnId: 'boundary', deferGoalContinuation: true });
            }
            const { readRuntimes } = await import('./registry');
            for (const runtime of await readRuntimes()) expect(Object.values(runtime.sessions)).toEqual([]);
        } finally { requests.mockRestore(); await rm(home, { recursive: true, force: true }); }
    }, 30_000);
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
            // A persisted child must fork in its own execution, never reserve/resume
            // the still-live source, and must retain its Hub identity on restart.
            const pending = new MockSession(cwd);
            pending.metadata = { ...pending.metadata, codexSessionId: initial, codexForkRequest: { sourceThreadId: initial }, forkedFrom: sessionId };
            state.sessions.set(pending.sessionId, pending);
            let release!: (confirmed: boolean) => void;
            const flush = vi.spyOn(pending, 'flushMetadata').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
            const childAbort = new AbortController();
            let childReady!: (ready: import('./runtime').RuntimeReady) => void;
            const childReadiness = new Promise<import('./runtime').RuntimeReady>(resolve => { childReady = resolve; });
            const childRunning = runSharedRuntime({ workingDirectory: cwd, existingSessionId: pending.sessionId, resumeSessionId: initial, collaborationMode: 'plan' }, childReady, childAbort.signal);
            try {
                await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce());
                const { readRuntimes } = await import('./registry');
                const reserved = (await readRuntimes()).find(r => r.sessions[pending.sessionId]?.active)!;
                const threadId = reserved.sessions[pending.sessionId].threadId;
                const frontends = await Promise.all([0, 1].map(async () => {
                    const client = new CodexAppServerClient({ endpoint: reserved.endpoint, token: reserved.token });
                    client.setServerRequestHandler(() => {}); clients.push(client); await initializeSharedClient(client); return client;
                }));
                for (const client of frontends) {
                    await expect(client.request('hapi/attach', { sessionId: pending.sessionId })).rejects.toThrow(/activat/i);
                    await expect(client.request('thread/resume', { threadId })).rejects.toThrow(/activat/i);
                    for (const method of ['turn/start', 'turn/steer', 'thread/queue/add', 'thread/queue/start', 'thread/settings/update', 'thread/goal/set', 'thread/fork', 'thread/archive']) {
                        await expect(client.request(method, { threadId, ephemeral: true, input: [{ type: 'text', text: 'NOT ADMITTED', text_elements: [] }] })).rejects.toThrow(/activat/i);
                    }
                }
                expect(record(await frontends[0].request('thread/queue/list', { threadId })).data).toEqual([]);
                release(true);
                const child = await Promise.race([childReadiness, childRunning.then(() => { throw new Error('Pending fork stopped before ready'); })]);
                for (const client of frontends) {
                    expect(await client.request('hapi/attach', { sessionId: pending.sessionId })).toEqual({ threadId });
                    expect(record(record(await client.request('thread/resume', { threadId })).thread).id).toBe(threadId);
                }
                const queued = record(record(await frontends[1].request('thread/queue/add', { threadId, clientUserMessageId: 'after-ack',
                    input: [{ type: 'text', text: 'AFTER ACK', text_elements: [] }] })).queuedSubmission);
                expect(queued.id).toBeTruthy();
                await frontends[1].request('thread/queue/delete', { threadId, queuedSubmissionId: queued.id });
                expect(child.sessionId).toBe(pending.sessionId);
                expect(pending.metadata.codexSessionId).not.toBe(initial);
                expect(pending.metadata.codexForkRequest).toBeUndefined();
                expect(web.metadata.codexSessionId).toBe(initial); expect(web.dead).toBe(false);
                pending.user?.({ content: { text: 'PENDING CHILD' } }, 'pending-1');
                await vi.waitFor(() => expect(pending.consumed).toContain('pending-1'), { timeout: 15_000 });
            } finally { release?.(false); childAbort.abort(); await childRunning.catch(() => {}); flush.mockRestore(); }
            expect(pending.dead).toBe(true); expect(web.dead).toBe(false);
            const newResponse = record(await first.request('thread/start', { cwd }));
            const next = String(record(newResponse.thread).id); roots.push(next);
            expect(next).not.toBe(initial); expect(state.sessions.size).toBe(3);
            const nextSession = [...state.sessions.values()].find(session => session.metadata.codexSessionId === next)!;
            expect(web.metadata.codexSessionId).toBe(initial);
            expect(process.env.HAPI_SESSION_ID).toBe('parent-must-not-leak');
            await first.request('thread/archive', { threadId: next }); roots = [initial];
            await vi.waitFor(() => expect(nextSession.dead).toBe(true)); expect(web.dead).toBe(false);
            await second.request('turn/start', { threadId: initial, model: 'second-mock', input: [{ type: 'text', text: 'HELLO FROM TERMINAL', text_elements: [] }], clientUserMessageId: 'native-1' });
            await vi.waitFor(() => expect(web.messages).toContainEqual({ user: 'HELLO FROM TERMINAL' }), { timeout: 15_000 });
            await vi.waitFor(() => {
                const usageModels = web.messages.map(record).filter(body => body.type === 'token_count').map(body => body.model);
                expect(usageModels).toContain('mock-model');
                expect(usageModels).toContain('second-mock');
            }, { timeout: 15_000 });
            const priorIds = new Set(state.sessions.keys());
            const failedFlush = vi.spyOn(MockSession.prototype, 'flush').mockResolvedValueOnce(false);
            try {
                await expect(first.request('thread/start', { cwd })).rejects.toThrow(/activat/i);
                const failed = [...state.sessions.values()].find(session => !priorIds.has(session.sessionId))!;
                const threadId = failed.metadata.codexSessionId;
                await expect(second.request('hapi/attach', { sessionId: failed.sessionId })).rejects.toThrow(/activat/i);
                await expect(second.request('thread/resume', { threadId })).rejects.toThrow(/activat/i);
                await expect(second.request('turn/start', { threadId, input: [{ type: 'text', text: 'FAILED ACTIVATION', text_elements: [] }] })).rejects.toThrow(/activat/i);
                expect(failed.consumed).toEqual([]);
                // Cleanup may still stop a root whose activation never completed.
                await second.request('hapi/stopSession', { sessionId: failed.sessionId });
                await vi.waitFor(() => expect(failed.dead).toBe(true));
            } finally { failedFlush.mockRestore(); }
            const ephemeral = record(record(await first.request('thread/start', { cwd, ephemeral: true })).thread).id;
            await expect(second.request('turn/start', { threadId: ephemeral,
                input: [{ type: 'text', text: 'UNBOUND INPUT', text_elements: [] }] })).rejects.toThrow(/activat/i);
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
});

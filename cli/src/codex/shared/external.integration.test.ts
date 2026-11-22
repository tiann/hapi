import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Metadata, AgentState } from '@/api/types';
import type { ApiSessionClient } from '@/api/apiSession';
import type { SessionBootstrapResult } from '@/agent/sessionFactory';
import { CodexAppServerClient } from '../codexAppServerClient';
import { initializeSharedClient } from './launch';
import { record } from './gateway';

type Packet = { method: string; params: unknown };
type ServerRequest = Packet & { id: string | number };
type Peer = { client: CodexAppServerClient; notifications: Packet[]; requests: ServerRequest[] };

const hub = vi.hoisted(() => ({ home: '', stripRuntime: false, sessions: new Map<string, BridgeSession>() }));
class BridgeSession extends EventEmitter {
    readonly sessionId: string; metadata: Metadata; state: AgentState = {};
    messages: unknown[]; private seen: Set<string>; dead = false;
    user?: (message: { content: { text: string } }, id?: string) => void;
    rpc = new Map<string, (params: unknown) => Promise<unknown>>();
    rpcHandlerManager = { registerHandler: (method: string, handler: (params: unknown) => Promise<unknown>) => { this.rpc.set(method, handler); } };
    constructor(cwd: string, overrides: Partial<Metadata>, previous?: BridgeSession) {
        super(); this.sessionId = previous?.sessionId ?? randomUUID(); this.messages = previous?.messages ?? []; this.seen = previous?.seen ?? new Set();
        this.metadata = { path: cwd, host: 'test', machineId: 'test', hostPid: process.pid, ...previous?.metadata, ...overrides };
    }
    getMetadata() { return this.metadata; }
    updateMetadata(fn: (value: Metadata) => Metadata) { this.metadata = fn(this.metadata); }
    updateAgentState(fn: (value: AgentState) => AgentState) { this.state = fn(this.state); }
    onUserMessage(fn: BridgeSession['user']) { this.user = fn; }
    onCancelQueuedMessage() {} onRetryQueuedMessage() {} onReconnect() {}
    sendAgentMessage(body: unknown, id?: string) { if (!id || !this.seen.has(id)) this.messages.push(body); if (id) this.seen.add(id); }
    sendUserMessage(text: string) { this.messages.push({ user: text }); }
    sendSessionEvent() {} emitMessagesConsumed() {} emitSteerIndeterminate() {} syncNativeQueuedMessage() {}
    async setSteerDeliveryState() { return true; }
    keepAlive() {} emitSessionReady() {} isPending() { return false; }
    sendSessionDeath() { this.dead = true; } async flush() { return true; } async flushMetadata() { return true; } close() {}
}
vi.mock('@/configuration', () => ({ resolveHapiHomeDir: () => hub.home,
    configuration: { get happyHomeDir() { return hub.home; }, apiUrl: 'http://mock-hub', cliApiToken: 'test' } }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn((...args: unknown[]) => { if (process.env.HAPI_TEST_DEBUG) console.error(...args); }), warn: vi.fn(), info: vi.fn() } }));
vi.mock('@/runner/controlClient', () => ({ notifyRunnerSessionStarted: vi.fn(async () => ({})) }));
vi.mock('@/api/api', () => ({ ApiClient: { create: async () => ({ getSession: async (id: string) => {
    const session = hub.sessions.get(id); if (!session) throw new Error('Session not found');
    return { id, namespace: 'test', metadata: hub.stripRuntime ? { ...session.metadata, codexRuntime: undefined } : session.metadata };
} }) } }));
vi.mock('@/agent/sessionFactory', () => {
    const bootstrap = async (options: { workingDirectory: string; metadataOverrides: Partial<Metadata>; sessionId?: string }): Promise<SessionBootstrapResult> => {
        const session = new BridgeSession(options.workingDirectory, options.metadataOverrides, options.sessionId ? hub.sessions.get(options.sessionId) : undefined);
        hub.sessions.set(session.sessionId, session);
        return { session: session as unknown as ApiSessionClient, workingDirectory: options.workingDirectory, metadata: session.metadata,
            sessionInfo: { id: session.sessionId, namespace: 'test' } } as SessionBootstrapResult;
    };
    return { bootstrapSession: bootstrap, bootstrapExistingSession: bootstrap };
});

// P0 for externally owned engines: neither client goes through HAPI's gateway.
// This verifies the native multi-client protocol, NOT the ChatGPT GUI. The real
// binary uses a blank home and a local Responses mock, never user credentials.
describe.skipIf(process.env.HAPI_RUN_SHARED_CODEX_TESTS !== '1' || process.platform === 'win32')('external Codex engine protocol', () => {
    let home: string;
    let cwd: string;
    let endpoint: string;
    let engine: ChildProcess | undefined;
    let model: Server | undefined;
    let engineLog: string;
    let peers: Peer[];
    let modelRequests: Record<string, unknown>[];
    let answer: (request: Record<string, unknown>) => Promise<Record<string, unknown>>;
    const releases: Array<() => void> = [];
    const workers: Array<{ abort: AbortController; running: Promise<void> }> = [];

    const message = (text: string) => ({ type: 'message', role: 'assistant', id: `msg_${randomUUID()}`,
        content: [{ type: 'output_text', text }] });
    const gate = () => {
        let release!: () => void;
        const waiting = new Promise<void>(resolve => { release = resolve; });
        releases.push(release);
        return { waiting, release };
    };
    const connect = async (): Promise<Peer> => {
        const peer: Peer = { client: new CodexAppServerClient({ endpoint }), notifications: [], requests: [] };
        peers.push(peer);
        peer.client.setNotificationHandler((method, params) => { peer.notifications.push({ method, params }); });
        // Observe without automatically replying: any error response would also
        // compete with the actual desktop/mobile answer upstream.
        peer.client.setServerRequestHandler(request => { peer.requests.push(request); });
        await initializeSharedClient(peer.client);
        return peer;
    };
    const start = async (peer: Peer) => {
        const response = record(await peer.client.request('thread/start', { cwd, developerInstructions: 'EXTERNAL_OWNER_SENTINEL' }));
        const threadId = String(record(response.thread).id);
        // The owning frontend persists an empty thread's metadata before it can
        // be resumed by another client. The bridge must not inject this itself.
        await peer.client.request('thread/metadata/update', { threadId, gitInfo: { sha: null } });
        return threadId;
    };
    const turn = async (peer: Peer, threadId: string, text: string) => {
        const response = record(await peer.client.request('turn/start', { threadId, input: [{ type: 'text', text }] }));
        return String(record(response.turn).id);
    };
    const completed = async (peer: Peer, turnId: string) => {
        await vi.waitFor(() => expect(peer.notifications).toContainEqual(expect.objectContaining({ method: 'turn/completed',
            params: expect.objectContaining({ turn: expect.objectContaining({ id: turnId, status: 'completed' }) }) })), { timeout: 15_000 });
    };
    const attach = async (threadId: string, newView = false) => {
        const { runAttachedRuntime } = await import('./attached');
        const abort = new AbortController();
        let ready!: (value: import('./attached').AttachedReady) => void;
        const readiness = new Promise<import('./attached').AttachedReady>(resolve => { ready = resolve; });
        const running = runAttachedRuntime({ endpoint, threadId, newView }, ready, abort.signal);
        void running.catch(() => {});
        workers.push({ abort, running });
        const result = await Promise.race([readiness, running.then(() => { throw new Error('Bridge stopped before readiness'); })]);
        return { ...result, abort, running, web: hub.sessions.get(result.sessionId)! };
    };

    beforeEach(async () => {
        peers = []; modelRequests = []; engineLog = '';
        home = await mkdtemp('/tmp/hapi-external-');
        hub.home = join(home, 'hapi'); hub.sessions.clear(); hub.stripRuntime = false;
        await chmod(home, 0o700);
        cwd = join(home, 'work');
        const codexHome = join(home, 'codex');
        await Promise.all([mkdir(cwd), mkdir(codexHome)]);
        endpoint = `unix://${join(home, 'engine.sock')}`;
        answer = async () => message('EXTERNAL_MOCK_DONE');
        model = createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on('data', chunk => { chunks.push(Buffer.from(chunk)); });
            request.on('end', () => {
                void (async () => {
                    if (!request.url?.endsWith('/responses')) { response.writeHead(404).end(); return; }
                    const body = record(JSON.parse(Buffer.concat(chunks).toString()));
                    modelRequests.push(body);
                    const item = await answer(body);
                    const id = `resp_${randomUUID()}`;
                    const events = [{ type: 'response.created', response: { id } }, { type: 'response.output_item.done', item },
                        { type: 'response.completed', response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
                    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
                    response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
                })().catch(error => { response.writeHead(500).end(String(error)); });
            });
        });
        await new Promise<void>(resolve => model!.listen(0, '127.0.0.1', resolve));
        const port = (model.address() as { port: number }).port;
        await writeFile(join(codexHome, 'config.toml'), `model = "mock-model"
model_provider = "isolated_mock"
approval_policy = "on-request"
sandbox_mode = "read-only"
check_for_update_on_startup = false
[model_providers.isolated_mock]
name = "Isolated external protocol mock"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
[analytics]
enabled = false
[feedback]
enabled = false
[projects."${cwd}"]
trust_level = "trusted"
`);
        engine = spawn(process.env.HAPI_CODEX_APP_SERVER_BIN ?? 'codex', ['app-server', '--listen', endpoint], {
            cwd, stdio: ['ignore', 'pipe', 'pipe'],
            env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome, LANG: 'en_US.UTF-8', RUST_LOG: 'warn',
                NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' }
        });
        engine.stdout?.on('data', data => { engineLog += data.toString(); });
        engine.stderr?.on('data', data => { engineLog += data.toString(); });
        engine.on('error', error => { engineLog += String(error); });
        await vi.waitFor(async () => {
            if (engine?.exitCode !== null || engine?.signalCode !== null) throw new Error(`External engine exited: ${engineLog}`);
            await access(join(home, 'engine.sock'));
        }, { timeout: 15_000 });
    });

    afterEach(async () => {
        for (const release of releases.splice(0)) release();
        for (const worker of workers) worker.abort.abort();
        await Promise.allSettled(workers.splice(0).map(worker => worker.running));
        await Promise.all(peers.map(peer => peer.client.disconnect()));
        // Only the fixture owns this PID. An attached runtime must never do this.
        if (engine?.pid && engine.exitCode === null && engine.signalCode === null) {
            engine.kill('SIGTERM');
            try { await vi.waitFor(() => expect(engine!.exitCode !== null || engine!.signalCode !== null).toBe(true), { timeout: 5_000 }); }
            catch { engine.kill('SIGKILL'); await new Promise<void>(resolve => engine!.once('exit', () => resolve())); }
        }
        engine = undefined;
        if (model) { model.closeAllConnections(); await new Promise<void>(resolve => model!.close(() => resolve())); }
        model = undefined;
        await rm(home, { recursive: true, force: true, maxRetries: 3 });
    });

    it('attaches to a loaded thread, detaches during generation, reconnects and exchanges native turns', async () => {
        const desktop = await connect();
        const threadId = await start(desktop);
        const bridge = await connect();
        const loaded = record(await bridge.client.request('thread/loaded/list', {}));
        expect(loaded.data).toContain(threadId);
        const settings = record(await bridge.client.request('thread/resume', { threadId }));
        expect(settings.approvalPolicy).toBe('on-request');
        expect(settings.sandbox).toMatchObject({ type: 'readOnly' });
        expect(modelRequests).toHaveLength(0);

        const hold = gate();
        answer = async () => { await hold.waiting; return message('EXTERNAL_MOCK_DONE'); };
        const firstTurn = await turn(desktop, threadId, 'FROM_DESKTOP');
        await vi.waitFor(() => expect(modelRequests).toHaveLength(1), { timeout: 15_000 });
        await bridge.client.disconnect();
        expect(engine!.exitCode).toBeNull();
        hold.release();
        await completed(desktop, firstTurn);

        await initializeSharedClient(bridge.client);
        const history = record(await bridge.client.request('thread/resume', { threadId }));
        expect(record(history.thread).id).toBe(threadId);
        const turns = record(history.thread).turns as Array<{ id: string }>;
        expect(turns.map(value => value.id)).toEqual([firstTurn]);
        expect(JSON.stringify(history)).toContain('EXTERNAL_MOCK_DONE');
        const secondTurn = await turn(bridge, threadId, 'FROM_BRIDGE');
        await Promise.all([completed(desktop, secondTurn), completed(bridge, secondTurn)]);
        expect(modelRequests).toHaveLength(2);
        expect(JSON.stringify(modelRequests)).toContain('EXTERNAL_OWNER_SENTINEL');
    }, 45_000);

    it('broadcasts pending questions and accepts one native answer without a gateway arbiter', async () => {
        const desktop = await connect(); const bridge = await connect();
        const threadId = await start(desktop);
        await bridge.client.request('thread/resume', { threadId });
        await desktop.client.request('thread/settings/update', { threadId, collaborationMode: {
            mode: 'plan', settings: { model: 'mock-model', reasoning_effort: null, developer_instructions: null }
        } });
        answer = async () => modelRequests.length === 1 ? { type: 'function_call', call_id: 'external_question', name: 'request_user_input',
            arguments: JSON.stringify({ questions: [{ id: 'client', header: 'Client', question: 'Which client answers?', options: [
                { label: 'Desktop', description: 'Desktop wins' }, { label: 'Bridge', description: 'Bridge wins' }
            ] }] }) } : message('QUESTION_DONE');
        const turnId = await turn(desktop, threadId, 'ASK_EXTERNAL_QUESTION');
        await vi.waitFor(() => {
            expect(desktop.requests).toHaveLength(1); expect(bridge.requests).toHaveLength(1);
        }, { timeout: 15_000 });
        const pending = desktop.requests[0];
        expect(pending.method).toBe('item/tool/requestUserInput');
        expect(bridge.requests[0].id).toBe(pending.id);
        desktop.client.respond(pending.id, { answers: { client: { answers: ['Desktop'] } } });
        await vi.waitFor(() => expect(bridge.notifications).toContainEqual({ method: 'serverRequest/resolved',
            params: { threadId, requestId: pending.id } }));
        // A late losing answer must not re-execute the tool or start a new turn.
        bridge.client.respond(pending.id, { answers: { client: { answers: ['Bridge'] } } });
        await Promise.all([completed(desktop, turnId), completed(bridge, turnId)]);
        expect(modelRequests).toHaveLength(2);
        const outputs = (modelRequests[1].input as Array<Record<string, unknown>>).filter(item => item.type === 'function_call_output');
        expect(JSON.stringify(outputs)).toContain('Desktop');
        expect(JSON.stringify(outputs)).not.toContain('Bridge');
    }, 45_000);

    it('replays a pending command approval on reconnect and accepts a bridge denial', async () => {
        const desktop = await connect(); const bridge = await connect();
        const threadId = await start(desktop);
        await bridge.client.request('thread/resume', { threadId });
        answer = async () => modelRequests.length === 1 ? { type: 'function_call', call_id: 'external_approval', name: 'exec_command',
            arguments: JSON.stringify({ cmd: 'printf EXTERNAL_SHOULD_NOT_RUN', sandbox_permissions: 'require_escalated',
                justification: 'Isolated approval replay test; decline this command' }) } : message('APPROVAL_DONE');
        const turnId = await turn(desktop, threadId, 'ASK_EXTERNAL_APPROVAL');
        await vi.waitFor(() => {
            expect(desktop.requests).toHaveLength(1); expect(bridge.requests).toHaveLength(1);
        }, { timeout: 15_000 });
        const pending = bridge.requests[0];
        expect(pending.method).toBe('item/commandExecution/requestApproval');
        await bridge.client.disconnect();
        bridge.requests = [];
        await initializeSharedClient(bridge.client);
        await bridge.client.request('thread/resume', { threadId });
        await vi.waitFor(() => expect(bridge.requests).toContainEqual(pending));
        bridge.client.respond(pending.id, { decision: 'decline' });
        await vi.waitFor(() => expect(desktop.notifications).toContainEqual({ method: 'serverRequest/resolved',
            params: { threadId, requestId: pending.id } }));
        await Promise.all([completed(desktop, turnId), completed(bridge, turnId)]);
        expect(modelRequests).toHaveLength(2);
        const outputs = (modelRequests[1].input as Array<Record<string, unknown>>).filter(item => item.type === 'function_call_output');
        expect(JSON.stringify(outputs)).toMatch(/reject|deni|declin/i);
    }, 45_000);

    it('keeps native queued input when the submitting bridge disconnects', async () => {
        const desktop = await connect(); const bridge = await connect();
        const threadId = await start(desktop);
        await bridge.client.request('thread/resume', { threadId });
        const hold = gate();
        answer = async () => { await hold.waiting; return message('QUEUE_DONE'); };
        const firstTurn = await turn(desktop, threadId, 'DESKTOP_GENERATING');
        await vi.waitFor(() => expect(modelRequests).toHaveLength(1), { timeout: 15_000 });
        const clientUserMessageId = randomUUID();
        await bridge.client.request('thread/queue/add', { threadId, clientUserMessageId, input: [{ type: 'text', text: 'BRIDGE_QUEUED' }] });
        await bridge.client.disconnect();
        const queued = record(await desktop.client.request('thread/queue/list', { threadId }));
        expect(queued.data).toContainEqual(expect.objectContaining({ clientUserMessageId }));
        hold.release();
        await completed(desktop, firstTurn);
        await vi.waitFor(() => expect(modelRequests).toHaveLength(2), { timeout: 15_000 });
        await vi.waitFor(() => expect(desktop.notifications.filter(packet => packet.method === 'turn/completed')).toHaveLength(2), { timeout: 15_000 });
        expect(JSON.stringify(modelRequests[1])).toContain('BRIDGE_QUEUED');
        expect(record(await desktop.client.request('thread/queue/list', { threadId })).data).toEqual([]);
        await initializeSharedClient(bridge.client);
        const history = record(await bridge.client.request('thread/resume', { threadId }));
        expect(record(history.thread).turns).toHaveLength(2);
        expect(engine!.exitCode).toBeNull();
    }, 45_000);

    it('observes desktop forks and archives made directly on the native endpoint', async () => {
        const desktop = await connect(); const bridge = await connect();
        const threadId = await start(desktop);
        await bridge.client.request('thread/resume', { threadId });
        const turnId = await turn(desktop, threadId, 'BEFORE_FORK');
        await completed(bridge, turnId);
        const fork = record(await desktop.client.request('thread/fork', { threadId }));
        const childId = String(record(fork.thread).id);
        expect(childId).not.toBe(threadId);
        await vi.waitFor(() => expect(bridge.notifications).toContainEqual(expect.objectContaining({ method: 'thread/started',
            params: expect.objectContaining({ thread: expect.objectContaining({ id: childId }) }) })));
        await desktop.client.request('thread/archive', { threadId: childId });
        await vi.waitFor(() => expect(bridge.notifications).toContainEqual({ method: 'thread/archived', params: { threadId: childId } }));
        const loaded = record(await bridge.client.request('thread/loaded/list', {}));
        expect(loaded.data).toContain(threadId);
        expect(loaded.data).not.toContain(childId);
        expect(engine!.exitCode).toBeNull();
    }, 45_000);

    it('bridges an external engine without injection, preserves native work on detach and reuses the HAPI identity', async () => {
        const desktop = await connect(); const threadId = await start(desktop);
        const calls = vi.spyOn(CodexAppServerClient.prototype, 'request');
        try {
            const bridge = await attach(threadId);
            expect(bridge.runtime).toMatchObject({ kind: 'attached', command: '', args: [] });
            expect(bridge.runtime.serverPid).toBeUndefined();
            expect(bridge.web.metadata.capabilities).toMatchObject({ terminal: false, concurrentClients: true,
                conversationHistory: { forkCurrent: false, forkAtMessage: false, forkLatestCompleted: false, rewindToMessage: false } });
            expect(calls.mock.calls.some(([method]) => ['thread/start', 'thread/metadata/update'].includes(method))).toBe(false);
            // Invalid-ID capability probes do not carry settings, MCP or instructions.
            expect(calls.mock.calls.filter(([method]) => method === 'thread/settings/update')
                .every(([, params]) => record(params).threadId === '__hapi_capability_probe__')).toBe(true);
            expect(calls.mock.calls.filter(([method]) => method === 'thread/resume')
                .every(([, params]) => Object.keys(record(params)).every(key => ['threadId', 'excludeTurns'].includes(key)))).toBe(true);
            expect(modelRequests).toHaveLength(0);

            const hold = gate(); answer = async () => { await hold.waiting; return message('BRIDGED_DONE'); };
            const turnId = await turn(desktop, threadId, 'DESKTOP_ACTIVE');
            await vi.waitFor(() => expect(modelRequests).toHaveLength(1), { timeout: 15_000 });
            bridge.web.user?.({ content: { text: 'MOBILE_QUEUED' } }, 'mobile-queued');
            await vi.waitFor(async () => expect(JSON.stringify(await desktop.client.request('thread/queue/list', { threadId }))).toContain('MOBILE_QUEUED'));
            const { runtimeControl } = await import('./frontend');
            await runtimeControl(bridge.runtime, 'hapi/detach', bridge.sessionId);
            await bridge.running;
            expect(bridge.web.dead).toBe(true);
            expect(bridge.web.metadata.codexRuntime?.state).toBe('detached');
            expect(JSON.stringify(await desktop.client.request('thread/queue/list', { threadId }))).toContain('MOBILE_QUEUED');
            expect(engine!.exitCode).toBeNull();
            hold.release(); await completed(desktop, turnId);
            await vi.waitFor(() => expect(desktop.notifications.filter(packet => packet.method === 'turn/completed')).toHaveLength(2), { timeout: 15_000 });

            const reattached = await attach(threadId);
            expect(reattached.sessionId).toBe(bridge.sessionId);
            expect(reattached.web.messages).toContainEqual(expect.objectContaining({ type: 'message', message: 'BRIDGED_DONE' }));
            expect(reattached.web.metadata.codexRuntime?.bindingId).toBe(bridge.web.metadata.codexRuntime?.bindingId);
            const lastTurn = await turn(desktop, threadId, 'DESKTOP_AFTER_REATTACH');
            await completed(desktop, lastTurn);
            await vi.waitFor(() => expect(reattached.web.messages.filter(value => record(value).type === 'message')).toHaveLength(3));
            expect(modelRequests).toHaveLength(3);
        } finally { calls.mockRestore(); }
    }, 60_000);

    it('refuses an unloaded external thread before creating a HAPI session or sending resume', async () => {
        const { runAttachedRuntime } = await import('./attached');
        const calls = vi.spyOn(CodexAppServerClient.prototype, 'request');
        try {
            await expect(runAttachedRuntime({ endpoint, threadId: randomUUID() })).rejects.toThrow('not loaded');
            expect(hub.sessions.size).toBe(0);
            expect(calls.mock.calls.some(([method]) => method === 'thread/resume')).toBe(false);
            expect(modelRequests).toHaveLength(0);
        } finally { calls.mockRestore(); }
    }, 30_000);

    it('fails before exposing the native ID if an old Hub strips the attached marker', async () => {
        const desktop = await connect(); const threadId = await start(desktop);
        hub.stripRuntime = true;
        const { runAttachedRuntime } = await import('./attached');
        const calls = vi.spyOn(CodexAppServerClient.prototype, 'request');
        try {
            await expect(runAttachedRuntime({ endpoint, threadId })).rejects.toThrow('does not preserve');
            const session = [...hub.sessions.values()][0];
            expect(session.dead).toBe(true);
            expect(session.metadata.codexSessionId).toBeUndefined();
            expect(calls.mock.calls.some(([method]) => method === 'thread/resume')).toBe(false);
            expect(modelRequests).toHaveLength(0);
        } finally { calls.mockRestore(); }
    }, 30_000);

    it('ends only the bridge when the desktop archives its root, keeping sibling threads and engine alive', async () => {
        const desktop = await connect(); const threadId = await start(desktop); const sibling = await start(desktop);
        const bridge = await attach(threadId);
        await desktop.client.request('thread/archive', { threadId });
        await bridge.running;
        expect(bridge.web.metadata.lifecycleState).toBe('archived');
        expect(engine!.exitCode).toBeNull();
        expect(record(await desktop.client.request('thread/loaded/list', {})).data).toContain(sibling);
    }, 30_000);

    it('freezes a mismatched durable view and only --new-view creates a distinct, reusable projection', async () => {
        const desktop = await connect(); const threadId = await start(desktop);
        const bridge = await attach(threadId);
        const turnId = await turn(desktop, threadId, 'CHECKPOINT_BASELINE'); await completed(desktop, turnId);
        const checkpoint = join(hub.home, 'codex-runtimes', 'attached-history', `${bridge.sessionId}-${createHash('sha256').update(threadId).digest('hex')}.json`);
        await vi.waitFor(async () => expect(JSON.parse(await readFile(checkpoint, 'utf8'))).toContainEqual(expect.objectContaining({ id: turnId, hash: expect.any(String) })));
        bridge.abort.abort(); await bridge.running;
        // Simulate a durable checkpoint whose native prefix no longer exists
        // (the same admission path as a rewrite missed while detached).
        await writeFile(checkpoint, JSON.stringify([{ id: 'previous-native-turn', hash: 'previous-content' }]));
        const { runAttachedRuntime } = await import('./attached');
        await expect(runAttachedRuntime({ endpoint, threadId })).rejects.toThrow('Native history changed');
        expect(hub.sessions.get(bridge.sessionId)!.metadata).toMatchObject({ conversationHistoryDiverged: true,
            codexRuntime: { state: 'history-changed' } });
        const replacement = await attach(threadId, true);
        expect(replacement.sessionId).not.toBe(bridge.sessionId);
        expect(replacement.web.metadata.codexRuntime?.bindingId).not.toBe(bridge.web.metadata.codexRuntime?.bindingId);
        expect(replacement.web.messages).toContainEqual(expect.objectContaining({ type: 'message', message: 'EXTERNAL_MOCK_DONE' }));
        replacement.abort.abort(); await replacement.running;
        const again = await attach(threadId);
        expect(again.sessionId).toBe(replacement.sessionId);
        expect(modelRequests).toHaveLength(1); expect(engine!.exitCode).toBeNull();
    }, 45_000);

    it('freezes immediately on a real native revert while leaving the external engine alive', async context => {
        const desktop = await connect(); const threadId = await start(desktop);
        const turnId = await turn(desktop, threadId, 'BEFORE_NATIVE_REVERT'); await completed(desktop, turnId);
        const native = record(record(await desktop.client.request('thread/read', { threadId, includeTurns: false })).thread);
        if (native.historyMode !== 'paginated') context.skip('Native binary predates paginated thread/revert');
        const bridge = await attach(threadId);
        await desktop.client.request('thread/revert', { threadId, beforeTurnId: turnId });
        await bridge.running;
        expect(bridge.web.metadata).toMatchObject({ conversationHistoryDiverged: true, codexRuntime: { state: 'history-changed' } });
        expect(bridge.web.messages).toContainEqual(expect.objectContaining({ type: 'message', message: 'EXTERNAL_MOCK_DONE' }));
        expect(engine!.exitCode).toBeNull();
    }, 30_000);
});

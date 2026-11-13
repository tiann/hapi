import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentMessage, FormElicitationRequest, FormElicitationResponse, PermissionRequest, PromptContent } from '@/agent/types';
import type { AcpSdkBackend } from '@/agent/backends/acp';
import { ACP_INDETERMINATE_SYMBOL } from '@/agent/backends/acp/AcpStdioTransport';
import agySteeredTurn from '@/agent/backends/acp/__fixtures__/agy-steered-turn.json';
import { AgySession } from './session';
import * as agyNativeTitle from './agyNativeTitle';
import type { AgyMode } from './types';
import {
    AgyAcpRemoteLauncher,
    addAgyUsage,
    agyAcpModeForPermission,
    agyRoundSummary,
    resolveAgyAcpModelId
} from './agyAcpRemoteLauncher';
import { generationTimeMs } from '@/agent/generationClock';

vi.mock('@/ui/ink/RemoteModeDisplay', () => ({ RemoteModeDisplay: () => null }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

type PromptScript = (onUpdate: (message: AgentMessage) => void) => Promise<void>;

class FakeAgyBackend {
    readonly calls: string[] = [];
    readonly prompts: PromptContent[][] = [];
    readonly setModeCalls: string[] = [];
    readonly setModelCalls: string[] = [];
    readonly resumeCalls: string[] = [];
    readonly cancelCalls: string[] = [];
    currentModelId = 'gemini-4-argon-medium';
    resumeError: Error | null = null;
    setModelError: Error | null = null;
    promptScripts: PromptScript[] = [];
    disconnected = false;

    initializeGate: Promise<void> | null = null;
    async initialize(): Promise<void> {
        this.calls.push('initialize');
        if (this.initializeGate) await this.initializeGate;
    }
    alive = true;
    isTransportAlive(): boolean {
        return this.alive;
    }
    supportsSessionResume(): boolean {
        return true;
    }
    newSessionError: Error | null = null;
    async newSession(): Promise<string> {
        this.calls.push('newSession');
        if (this.newSessionError) throw this.newSessionError;
        return 'agy-conv-new';
    }
    async resumeSession(config: { sessionId: string }): Promise<string> {
        this.resumeCalls.push(config.sessionId);
        if (this.resumeError) throw this.resumeError;
        return config.sessionId;
    }
    getSessionModelsMetadata() {
        return { availableModels: [], currentModelId: this.currentModelId };
    }
    async setMode(_sessionId: string, modeId: string): Promise<void> {
        this.setModeCalls.push(modeId);
    }
    setModelGate: Promise<void> | null = null;
    async setModel(_sessionId: string, modelId: string): Promise<void> {
        if (this.setModelGate) await this.setModelGate;
        if (this.setModelError) throw this.setModelError;
        this.setModelCalls.push(modelId);
    }
    promptInFlight = false;
    // Like AcpSdkBackend: prompt() waits for the previous turn's output before
    // it sends, and drains late output after the answer while still counting
    // as an open request (a steer is accepted then).
    preSendDelayMs = 0;
    postResponseDrainMs = 0;
    private draining = false;
    private openSteers = 0;
    isPromptRequestInFlight(): boolean {
        return this.promptInFlight;
    }
    get processingMessage(): boolean {
        return this.promptInFlight || this.draining || this.openSteers > 0;
    }
    async prompt(
        _sessionId: string,
        content: PromptContent[],
        onUpdate: (message: AgentMessage) => void,
        timing?: { onSent?: () => void; onAnswered?: () => void }
    ): Promise<void> {
        if (this.preSendDelayMs) await new Promise((resolve) => setTimeout(resolve, this.preSendDelayMs));
        if (this.disconnected) {
            const error = new Error('ACP transport closed');
            Object.defineProperty(error, ACP_INDETERMINATE_SYMBOL, { value: true });
            throw error;
        }
        this.prompts.push(content);
        this.promptInFlight = true;
        timing?.onSent?.();
        try {
            const script = this.promptScripts.shift();
            if (script) {
                await script(onUpdate);
            } else {
                onUpdate({ type: 'text', text: 'answer' });
                onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
            }
        } finally {
            this.promptInFlight = false;
            timing?.onAnswered?.();
        }
        if (this.postResponseDrainMs) {
            this.draining = true;
            await new Promise((resolve) => setTimeout(resolve, this.postResponseDrainMs));
            this.draining = false;
        }
    }
    async cancelPrompt(sessionId: string): Promise<void> {
        this.cancelCalls.push(sessionId);
        this.onCancel?.();
    }
    onCancel: (() => void) | null = null;
    readonly steerPrompts: PromptContent[][] = [];
    steerDispatchError: Error | null = null;
    steerStartError: Error | null = null;
    steerCompletions: Array<{
        resolve: (stopReason: string | null) => void;
        reject: (error: unknown) => void;
        // agy answered, but HAPI is still draining late output.
        answer: () => void;
        onUsage?: (usage: Extract<AgentMessage, { type: 'usage' }>) => void;
    }> = [];
    abortSoftSteersCalls = 0;
    beginSoftSteerPrompt(
        _sessionId: string,
        content: PromptContent[],
        options?: { onUsage?: (usage: Extract<AgentMessage, { type: 'usage' }>) => void }
    ) {
        if (this.steerStartError) throw this.steerStartError;
        if (!this.processingMessage) throw new Error('No active ACP prompt to soft-steer into');
        this.steerPrompts.push(content);
        this.openSteers += 1;
        let resolve!: (stopReason: string | null) => void;
        let reject!: (error: unknown) => void;
        const completed = new Promise<string | null>((res, rej) => { resolve = res; reject = rej; });
        void completed.then(() => { this.openSteers -= 1; }, () => { this.openSteers -= 1; });
        let answer!: () => void;
        const answered = new Promise<void>((res) => { answer = res; });
        void completed.then(answer, answer);
        this.steerCompletions.push({ resolve, reject, answer, onUsage: options?.onUsage });
        const dispatched = this.steerDispatchError ? Promise.reject(this.steerDispatchError) : Promise.resolve();
        void dispatched.catch(() => {});
        return { dispatched, answered, completed };
    }
    abortSoftSteers(): void {
        this.abortSoftSteersCalls += 1;
    }
    async refreshSessionInfo(): Promise<void> {}
    setSessionInfoUpdateListener(): void {}
    echo: ((text: string) => void) | null = null;
    setUserMessageChunkListener(listener: ((text: string) => void) | null): void {
        this.echo = listener;
    }
    onStderrError(): void {}
    formElicitationHandler: ((request: FormElicitationRequest) => Promise<FormElicitationResponse>) | null = null;
    onFormElicitation(handler: (request: FormElicitationRequest) => Promise<FormElicitationResponse>): void {
        this.formElicitationHandler = handler;
    }
    /** agy's `elicitation/create`, as the ACP backend hands it to the handler. */
    elicit(params: { sessionId: string; toolCallId?: string; message: string; requestedSchema: unknown }): Promise<FormElicitationResponse> {
        const { sessionId, toolCallId, message, requestedSchema } = params;
        return this.formElicitationHandler!({ sessionId, ...(toolCallId ? { toolCallId } : {}), message, requestedSchema });
    }
    permissionHandler: ((request: PermissionRequest) => void) | null = null;
    readonly permissionResponses: unknown[] = [];
    onPermissionRequest(handler: (request: PermissionRequest) => void): void {
        this.permissionHandler = handler;
    }
    async respondToPermission(_sessionId: string, _request: PermissionRequest, response: unknown): Promise<void> {
        this.permissionResponses.push(response);
    }
    onDisconnect: (() => void) | null = null;
    async disconnect(): Promise<void> {
        this.disconnected = true;
        this.onDisconnect?.();
    }
}

const REVIEW: AgyMode = { permissionMode: 'request-review' };

function makeClient() {
    const handlers = new Map<string, (payload?: unknown) => Promise<unknown>>();
    return {
        sessionId: 'hapi-session',
        rpcHandlerManager: {
            handlers,
            registerHandler: vi.fn((method: string, handler: (payload?: unknown) => Promise<unknown>) => {
                handlers.set(method, handler);
            }),
            unregisterHandler: vi.fn()
        },
        updateMetadata: vi.fn(),
        updateAgentState: vi.fn(),
        sendSessionEvent: vi.fn(),
        sendAgentMessage: vi.fn(),
        sendClaudeSessionMessage: vi.fn(),
        emitMessagesConsumed: vi.fn(),
        emitSteerIndeterminate: vi.fn(),
        setSteerDeliveryState: vi.fn(async () => true),
        getMetadata: vi.fn(() => null),
        keepAlive: vi.fn(),
        emitSessionReady: vi.fn()
    };
}

function makeSession(sessionId: string | null = null) {
    const queue = new MessageQueue2<AgyMode>((mode) => hashObject(mode));
    const client = makeClient();
    const session = new AgySession({
        api: {} as never,
        client: client as unknown as ApiSessionClient,
        path: '/tmp/agy-project',
        logPath: '/tmp/agy.log',
        sessionId,
        messageQueue: queue,
        onModeChange: vi.fn(),
        mode: 'remote',
        startedBy: 'runner',
        permissionMode: 'request-review'
    });
    return { session, queue, client };
}

function launch(session: AgySession, backends: FakeAgyBackend[], opts: { cancelHardStopMs?: number; killSettleMs?: number } = {}) {
    const created: FakeAgyBackend[] = [];
    const launcher = new AgyAcpRemoteLauncher(session, {
        steerCancelGraceMs: 50,
        cancelHardStopMs: opts.cancelHardStopMs ?? 2_000,
        killSettleMs: opts.killSettleMs,
        createBackend: () => {
            const backend = backends.shift() ?? new FakeAgyBackend();
            created.push(backend);
            return backend as unknown as AcpSdkBackend;
        }
    });
    return { run: launcher.launch(), created };
}

function steeringStates(client: ReturnType<typeof makeClient>): boolean[] {
    return client.updateAgentState.mock.calls
        .map(([update]) => (update as (state: object) => { steeringActive?: boolean })({}))
        .filter((state) => 'steeringActive' in state)
        .map((state) => state.steeringActive === true);
}

function agentState(client: ReturnType<typeof makeClient>): { requests?: Record<string, unknown> } {
    return client.updateAgentState.mock.calls
        .reduce((state, [update]) => (update as (s: object) => object)(state), {} as object);
}

function sessionEvents(client: ReturnType<typeof makeClient>): unknown[] {
    return client.sendSessionEvent.mock.calls.map(([event]) => event);
}

function roundSummaries(client: ReturnType<typeof makeClient>): Array<Record<string, unknown> & { agy_usage: Record<string, number> }> {
    return client.sendAgentMessage.mock.calls
        .map(([message]) => message as { type: string; summary: Record<string, unknown> & { agy_usage: Record<string, number> } })
        .filter((message) => message.type === 'round-summary')
        .map((message) => message.summary);
}

describe('AgyAcpRemoteLauncher', () => {
    beforeEach(() => {
        process.stdin.isTTY = false;
        process.stdout.isTTY = false;
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('opens a new conversation, sends text prompts, and reports ready', async () => {
        const { session, queue, client } = makeSession();
        const backend = new FakeAgyBackend();
        queue.push('hello', REVIEW, 'local-1');
        queue.close();

        await launch(session, [backend]).run;

        expect(backend.calls).toEqual(['initialize', 'newSession']);
        expect(session.sessionId).toBe('agy-conv-new');
        const metadata = client.updateMetadata.mock.calls
            .reduce((current, [update]) => (update as (m: object) => object)(current), {});
        expect(metadata).toMatchObject({ agySessionId: 'agy-conv-new', agyProtocol: 'acp', summary: { text: 'hello' } });
        expect(backend.prompts).toEqual([[{ type: 'text', text: 'hello' }]]);
        expect(client.sendAgentMessage).toHaveBeenCalledWith({ type: 'message', message: 'answer' });
        expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['local-1']);
        expect(sessionEvents(client)).toContainEqual({ type: 'ready' });
        expect(backend.disconnected).toBe(true);
    });

    it('tells the user why agy could not start', async () => {
        const { session, queue, client } = makeSession();
        const backend = new FakeAgyBackend();
        backend.initialize = async () => { throw new Error('unknown command "acp"'); };
        queue.push('hello', REVIEW, 'a');

        await expect(launch(session, [backend]).run).rejects.toThrow('requires Antigravity CLI 1.5.0 or newer');

        expect(sessionEvents(client)).toContainEqual({
            type: 'error',
            message: 'Failed to start agy acp (requires Antigravity CLI 1.5.0 or newer): unknown command "acp"'
        });
        expect(client.emitMessagesConsumed).not.toHaveBeenCalled();
        queue.close();
    });

    it('resumes the stored conversation without replay', async () => {
        const { session, queue } = makeSession('agy-conv-old');
        const backend = new FakeAgyBackend();
        queue.close();

        await launch(session, [backend]).run;

        expect(backend.resumeCalls).toEqual(['agy-conv-old']);
        expect(backend.calls).toEqual(['initialize']);
        expect(session.sessionId).toBe('agy-conv-old');
    });

    it('restores a missing title from the native conversation when resuming', async () => {
        const readTitle = vi.spyOn(agyNativeTitle, 'readAgyConversationTitle').mockResolvedValue('Original task');
        const { session, queue, client } = makeSession('agy-conv-old');
        const backend = new FakeAgyBackend();
        queue.close();
        try {
            await launch(session, [backend]).run;
            const metadata = client.updateMetadata.mock.calls
                .reduce((current, [update]) => (update as (m: object) => object)(current), {});
            expect(metadata).toMatchObject({ summary: { text: 'Original task' } });
            expect(readTitle).toHaveBeenCalledWith('agy-conv-old');
        } finally {
            readTitle.mockRestore();
        }
    });

    it('starts a new conversation when resume fails and says so', async () => {
        const { session, queue, client } = makeSession('agy-conv-gone');
        const backend = new FakeAgyBackend();
        backend.resumeError = new Error('conversation not found');
        queue.close();

        await launch(session, [backend]).run;

        expect(backend.calls).toEqual(['initialize', 'newSession']);
        expect(session.sessionId).toBe('agy-conv-new');
        expect(sessionEvents(client)).toContainEqual({
            type: 'message',
            message: 'Antigravity could not resume the conversation; starting a new one.'
        });
    });

    it('applies the ACP mode every turn and the model only when it changes', async () => {
        const { session, queue } = makeSession();
        const backend = new FakeAgyBackend();
        const flashLow: AgyMode = { permissionMode: 'request-review', model: 'gemini-3.8-flash', effort: 'low' };
        queue.push('one', flashLow, 'a');
        queue.push('two', { ...flashLow, permissionMode: 'always-proceed' }, 'b');
        queue.push('three', { ...flashLow, effort: 'high' }, 'c');
        queue.push('four', { ...flashLow, effort: 'high', permissionMode: 'plan' }, 'd');
        queue.push('five', { ...flashLow, effort: 'high', permissionMode: 'acceptEdits' }, 'e');
        queue.close();

        await launch(session, [backend]).run;

        expect(backend.prompts).toHaveLength(5);
        expect(backend.setModeCalls).toEqual(['default', 'default', 'default', 'plan', 'accept-edits']);
        expect(backend.setModelCalls).toEqual(['gemini-3.8-flash-low', 'gemini-3.8-flash-high']);
    });

    it('switches back to agy default model when the selection is cleared', async () => {
        const { session, queue } = makeSession();
        const backend = new FakeAgyBackend();
        queue.push('one', { permissionMode: 'request-review', model: 'gemini-3.8-flash', effort: 'low' }, 'a');
        queue.push('two', { permissionMode: 'request-review', model: null, effort: null }, 'b');
        queue.close();

        await launch(session, [backend]).run;

        expect(backend.setModelCalls).toEqual(['gemini-3.8-flash-low', 'gemini-4-argon-medium']);
    });

    it('restores the prompt instead of running it on the wrong model', async () => {
        const { session, queue, client } = makeSession();
        const backend = new FakeAgyBackend();
        backend.setModelError = new Error('unknown model');
        queue.push('hello', { permissionMode: 'request-review', model: 'gemini-9-ultra' }, 'a');
        queue.close();

        await launch(session, [backend]).run;

        expect(backend.prompts).toEqual([]);
        expect(sessionEvents(client)).toContainEqual({
            type: 'error',
            message: 'Failed to switch Antigravity model to gemini-9-ultra: unknown model'
        });
        expect(sessionEvents(client)).toContainEqual({ type: 'abort-restore', text: 'hello' });
    });

    it('reports one usage total per turn after the turn output', async () => {
        const { session, queue, client } = makeSession();
        const backend = new FakeAgyBackend();
        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({ type: 'text', text: 'done' });
            onUpdate({ type: 'usage', inputTokens: 100, outputTokens: 5, totalTokens: 105, cacheReadTokens: 10 });
            onUpdate({ type: 'usage', inputTokens: 50, outputTokens: 2, totalTokens: 52 });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
        });
        queue.push('hello', REVIEW, 'a');
        queue.close();

        await launch(session, [backend]).run;

        const sent = client.sendAgentMessage.mock.calls.map(([message]) => message as { type: string });
        // No token_count: agy's usage is not a context size.
        expect(sent.map((message) => message.type)).toEqual(['message', 'round-summary']);
        expect(sent[1]).toMatchObject({
            type: 'round-summary',
            summary: {
                provider: 'agy',
                model: 'gemini-4-argon-medium',
                agy_usage: { input_tokens: 150, output_tokens: 7, cache_read_tokens: 10, total_tokens: 157 },
                duration_ms: expect.any(Number)
            }
        });
    });

    it('restores a prompt agy never started and relaunches after the process dies', async () => {
        const { session, queue, client } = makeSession();
        const first = new FakeAgyBackend();
        first.promptScripts.push(async () => {
            const error = new Error('ACP transport closed');
            Object.defineProperty(error, ACP_INDETERMINATE_SYMBOL, { value: true });
            throw error;
        });
        const second = new FakeAgyBackend();
        queue.push('first try', REVIEW, 'a');
        queue.push('second try', { permissionMode: 'always-proceed' }, 'b');
        queue.close();

        const { run, created } = launch(session, [first, second]);
        await run;

        expect(created).toHaveLength(2);
        expect(first.disconnected).toBe(true);
        expect(second.resumeCalls).toEqual(['agy-conv-new']);
        expect(second.prompts).toEqual([[{ type: 'text', text: 'second try' }]]);
        expect(sessionEvents(client)).toContainEqual({ type: 'abort-restore', text: 'first try' });
    });

    it('restarts and resumes agy before a turn when the process died while idle', async () => {
        const { session, queue, client } = makeSession();
        const first = new FakeAgyBackend();
        const second = new FakeAgyBackend();
        queue.push('first', REVIEW, 'a');
        const { run, created } = launch(session, [first, second]);
        await vi.waitFor(() => expect(sessionEvents(client)).toContainEqual({ type: 'ready' }));

        first.alive = false;
        queue.push('after the crash', { permissionMode: 'always-proceed' }, 'b');
        await vi.waitFor(() => expect(second.prompts).toHaveLength(1));
        queue.close();
        await run;

        expect(created).toHaveLength(2);
        expect(second.resumeCalls).toEqual(['agy-conv-new']);
        expect(second.setModeCalls).toEqual(['default']);
        expect(second.prompts).toEqual([[{ type: 'text', text: 'after the crash' }]]);
        expect(sessionEvents(client)).not.toContainEqual({ type: 'abort-restore', text: 'after the crash' });
    });

    it('does not restore a prompt that already produced output', async () => {
        const { session, queue, client } = makeSession();
        const backend = new FakeAgyBackend();
        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({ type: 'tool_call', id: 't1', name: 'run_command', input: {}, status: 'in_progress' });
            throw new Error('quota exhausted');
        });
        queue.push('hello', REVIEW, 'a');
        queue.close();

        await launch(session, [backend]).run;

        expect(sessionEvents(client)).toContainEqual({
            type: 'error',
            message: 'Antigravity prompt failed: quota exhausted'
        });
        expect(sessionEvents(client)).not.toContainEqual({ type: 'abort-restore', text: 'hello' });
    });

    it('cancels the running turn on Stop and keeps serving the queue', async () => {
        const { session, queue, client } = makeSession();
        const backend = new FakeAgyBackend();
        let release!: () => void;
        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({ type: 'text', text: 'working' });
            await new Promise<void>((resolve) => { release = resolve; });
        });
        queue.push('long task', REVIEW, 'a');

        const { run } = launch(session, [backend]);
        await vi.waitFor(() => expect(backend.prompts).toHaveLength(1));
        const abort = client.rpcHandlerManager.handlers.get(RPC_METHODS.Abort)!;
        const aborted = abort();
        await vi.waitFor(() => expect(backend.cancelCalls).toEqual(['agy-conv-new']));
        release();
        await aborted;
        queue.push('next', REVIEW, 'b');
        await vi.waitFor(() => expect(backend.prompts).toHaveLength(2));
        queue.close();
        await run;

        expect(sessionEvents(client)).toContainEqual({ type: 'message', message: 'Turn aborted' });
        // Without steers, Stop leaves the handler running so agy's final
        // updates for the cancelled tool calls still render.
        expect(backend.abortSoftSteersCalls).toBe(0);
    });
});

describe('AgyAcpRemoteLauncher Stop', () => {
    it('keeps the session when Stop arrives while no turn is running', async () => {
        const { session, queue, client } = makeSession();
        const backend = new FakeAgyBackend();
        const { run } = launch(session, [backend]);
        await vi.waitFor(() => expect(client.rpcHandlerManager.handlers.has(RPC_METHODS.Abort)).toBe(true));

        // A late or repeated Stop after the turn already ended.
        await client.rpcHandlerManager.handlers.get(RPC_METHODS.Abort)!();
        await client.rpcHandlerManager.handlers.get(RPC_METHODS.Abort)!();
        queue.push('next', REVIEW, 'a');
        await vi.waitFor(() => expect(backend.prompts).toEqual([[{ type: 'text', text: 'next' }]]));
        expect(backend.disconnected).toBe(false);

        queue.close();
        await run;
    });

    it('restores a prompt that Stop cancelled before agy answered anything', async () => {
        const { session, queue, client } = makeSession();
        const backend = new FakeAgyBackend();
        let cancelled!: () => void;
        backend.onCancel = () => cancelled?.();
        backend.promptScripts.push(async (onUpdate) => {
            // agy 1.5.2 echoes the prompt, then answers a cancel with a normal
            // `cancelled` result rather than an error.
            backend.echo!('build it');
            await new Promise<void>((resolve) => { cancelled = resolve; });
            onUpdate({ type: 'turn_complete', stopReason: 'cancelled' });
        });
        queue.push('build it', REVIEW, 'a');
        const { run } = launch(session, [backend]);
        await vi.waitFor(() => expect(backend.prompts).toHaveLength(1));

        await client.rpcHandlerManager.handlers.get(RPC_METHODS.Abort)!();
        await vi.waitFor(() => expect(sessionEvents(client)).toContainEqual({ type: 'ready' }));
        queue.close();
        await run;

        expect(sessionEvents(client)).toContainEqual({ type: 'abort-restore', text: 'build it' });
    });

    it('keeps a cancelled turn that already produced output', async () => {
        const { session, queue, client } = makeSession();
        const backend = new FakeAgyBackend();
        let cancelled!: () => void;
        backend.onCancel = () => cancelled?.();
        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({ type: 'text', text: 'starting' });
            await new Promise<void>((resolve) => { cancelled = resolve; });
            onUpdate({ type: 'turn_complete', stopReason: 'cancelled' });
        });
        queue.push('build it', REVIEW, 'a');
        const { run } = launch(session, [backend]);
        await vi.waitFor(() => expect(backend.prompts).toHaveLength(1));

        await client.rpcHandlerManager.handlers.get(RPC_METHODS.Abort)!();
        await vi.waitFor(() => expect(sessionEvents(client)).toContainEqual({ type: 'ready' }));
        queue.close();
        await run;

        expect(sessionEvents(client)).not.toContainEqual({ type: 'abort-restore', text: 'build it' });
        expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['a']);
    });

    it('does not send a prompt when Stop arrives while agy switches the model', async () => {
        const { session, queue, client } = makeSession();
        const backend = new FakeAgyBackend();
        let openGate!: () => void;
        backend.setModelGate = new Promise((resolve) => { openGate = resolve; });
        queue.push('build it', { permissionMode: 'request-review', model: 'gemini-3.8-flash', effort: 'low' }, 'a');
        const { run } = launch(session, [backend]);
        await vi.waitFor(() => expect(client.rpcHandlerManager.handlers.has(RPC_METHODS.Abort)).toBe(true));
        await vi.waitFor(() => expect(session.thinking).toBe(true));

        await client.rpcHandlerManager.handlers.get(RPC_METHODS.Abort)!();
        openGate();
        await vi.waitFor(() => expect(sessionEvents(client)).toContainEqual({ type: 'ready' }));
        queue.close();
        await run;

        expect(backend.prompts).toEqual([]);
        expect(sessionEvents(client)).toContainEqual({ type: 'abort-restore', text: 'build it' });
        expect(sessionEvents(client)).toContainEqual({ type: 'message', message: 'Turn aborted' });
    });

    it('cancels again once a prompt that was still waiting to send reaches agy', async () => {
        const { session, queue, client } = makeSession();
        const backend = new FakeAgyBackend();
        backend.preSendDelayMs = 150;
        let release!: () => void;
        backend.promptScripts.push(async () => {
            await new Promise<void>((resolve) => { release = resolve; });
        });
        backend.onCancel = () => { if (backend.promptInFlight) release(); };
        queue.push('long task', REVIEW, 'a');
        const { run } = launch(session, [backend]);
        await vi.waitFor(() => expect(backend.setModeCalls).toEqual(['default']));

        await client.rpcHandlerManager.handlers.get(RPC_METHODS.Abort)!();
        await vi.waitFor(() => expect(sessionEvents(client)).toContainEqual({ type: 'ready' }));
        queue.close();
        await run;

        expect(backend.prompts).toHaveLength(1);
        expect(backend.cancelCalls).toHaveLength(2);
    });

    it('restarts agy when it ignores the cancel', async () => {
        const { session, queue, client } = makeSession();
        const first = new FakeAgyBackend();
        first.promptScripts.push(async () => {
            await new Promise<void>((_resolve, reject) => {
                first.onDisconnect = () => {
                    const error = new Error('ACP transport closed');
                    Object.defineProperty(error, ACP_INDETERMINATE_SYMBOL, { value: true });
                    reject(error);
                };
            });
        });
        const second = new FakeAgyBackend();
        queue.push('stuck', REVIEW, 'a');
        const { run, created } = launch(session, [first, second], { cancelHardStopMs: 50 });
        await vi.waitFor(() => expect(first.prompts).toHaveLength(1));

        await client.rpcHandlerManager.handlers.get(RPC_METHODS.Abort)!();
        await vi.waitFor(() => expect(sessionEvents(client)).toContainEqual({ type: 'ready' }));
        expect(first.disconnected).toBe(true);
        expect(sessionEvents(client)).toContainEqual({ type: 'message', message: 'Antigravity did not stop; restarting it.' });
        expect(sessionEvents(client).filter((event) => (event as { type: string }).type === 'error')).toEqual([]);

        queue.push('next', REVIEW, 'b');
        await vi.waitFor(() => expect(second.prompts).toHaveLength(1));
        queue.close();
        await run;
        expect(created).toHaveLength(2);
        expect(second.resumeCalls).toEqual(['agy-conv-new']);
    });
});

describe('AgyAcpRemoteLauncher steer', () => {
    type Handlers = Map<string, (payload?: unknown) => Promise<unknown>>;

    async function startHeldTurn(backend: FakeAgyBackend, mode: AgyMode = REVIEW) {
        const { session, queue, client } = makeSession();
        let releaseFirst!: () => void;
        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({ type: 'tool_call', id: 't1', name: 'run_command', input: {}, status: 'in_progress' });
            await new Promise<void>((resolve) => { releaseFirst = resolve; });
            onUpdate({ type: 'usage', inputTokens: 100, outputTokens: 4, totalTokens: 104 });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
        });
        queue.push('run the tests', mode, 'first');
        const { run, created } = launch(session, [backend]);
        await vi.waitFor(() => expect(backend.prompts).toHaveLength(1));
        const handlers = client.rpcHandlerManager.handlers as Handlers;
        return { session, queue, client, run, created, handlers, releaseFirst: () => releaseFirst() };
    }

    it('injects a queued message into the running turn and ends the turn with the steer', async () => {
        const backend = new FakeAgyBackend();
        const { queue, client, run, handlers, releaseFirst } = await startHeldTurn(backend);

        queue.push('also lint', REVIEW, 'steer-1');
        const result = await handlers.get(RPC_METHODS.SteerQueuedMessage)!({ localId: 'steer-1' });

        expect(result).toEqual({ steered: true });
        expect(backend.steerPrompts).toEqual([[{ type: 'text', text: 'also lint' }]]);
        expect(client.setSteerDeliveryState).toHaveBeenCalledWith(['steer-1'], 'dispatching');
        expect(queue.size()).toBe(0);

        // agy answers the interrupted request at once; the turn goes on.
        releaseFirst();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(sessionEvents(client)).not.toContainEqual({ type: 'ready' });
        expect(steeringStates(client).at(-1)).toBe(true);

        const steer = backend.steerCompletions[0]!;
        steer.onUsage?.({ type: 'usage', inputTokens: 50, outputTokens: 6, totalTokens: 56 });
        steer.resolve('end_turn');
        await vi.waitFor(() => expect(sessionEvents(client)).toContainEqual({ type: 'ready' }));
        queue.close();
        await run;

        expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['steer-1'], { steered: true });
        const summaries = roundSummaries(client);
        expect(summaries).toHaveLength(1);
        expect(summaries[0]!.agy_usage).toMatchObject({ input_tokens: 150, output_tokens: 10 });
        expect(steeringStates(client).at(-1)).toBe(false);
    });

    it('places the steer in the transcript when agy folds it in, not when the turn ends', async () => {
        const backend = new FakeAgyBackend();
        const { queue, client, run, handlers, releaseFirst } = await startHeldTurn(backend);
        queue.push('also lint', REVIEW, 'steer-1');
        await handlers.get(RPC_METHODS.SteerQueuedMessage)!({ localId: 'steer-1' });
        expect(client.emitMessagesConsumed).not.toHaveBeenCalledWith(['steer-1'], { steered: true });

        backend.echo!('run the tests');
        backend.echo!('also lint');

        expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['steer-1'], { steered: true });
        releaseFirst();
        backend.steerCompletions[0]!.resolve('end_turn');
        await vi.waitFor(() => expect(sessionEvents(client)).toContainEqual({ type: 'ready' }));
        queue.close();
        await run;
        expect(client.emitMessagesConsumed.mock.calls.filter(([ids]) => (ids as string[])[0] === 'steer-1')).toHaveLength(1);
    });

    it('keeps an echoed steer delivered when Stop cancels the turn afterwards', async () => {
        const backend = new FakeAgyBackend();
        const { queue, client, run, handlers, releaseFirst } = await startHeldTurn(backend);
        queue.push('also lint', REVIEW, 'steer-1');
        await handlers.get(RPC_METHODS.SteerQueuedMessage)!({ localId: 'steer-1' });
        backend.echo!('also lint');
        backend.onCancel = () => {
            releaseFirst();
            backend.steerCompletions[0]!.resolve('cancelled');
        };

        await handlers.get(RPC_METHODS.Abort)!();

        await vi.waitFor(() => expect(sessionEvents(client)).toContainEqual({ type: 'ready' }));
        expect(client.emitSteerIndeterminate).not.toHaveBeenCalled();
        expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['steer-1'], { steered: true });
        queue.close();
        await run;
    });

    it('tells the hub the session runs on agy acp before agy has started', async () => {
        const { session, queue, client } = makeSession();
        const backend = new FakeAgyBackend();
        let started!: () => void;
        backend.initializeGate = new Promise((resolve) => { started = resolve; });
        const { run } = launch(session, [backend]);
        await vi.waitFor(() => expect(backend.calls).toEqual(['initialize']));

        const metadata = client.updateMetadata.mock.calls
            .reduce((current, [update]) => (update as (m: object) => object)(current), {});
        expect(metadata).toMatchObject({ agyProtocol: 'acp' });
        queue.push('early', REVIEW, 'early-1');
        const steer = (client.rpcHandlerManager.handlers as Handlers).get(RPC_METHODS.SteerQueuedMessage);
        expect(await steer?.({ localId: 'early-1' })).toEqual({ steered: false, error: 'No active steerable turn' });

        started();
        await vi.waitFor(() => expect(backend.prompts).toEqual([[{ type: 'text', text: 'early' }]]));
        queue.close();
        await run;
    });

    it('refuses to steer when no turn is running and keeps the message queued', async () => {
        const { session, queue, client } = makeSession();
        const backend = new FakeAgyBackend();
        const { run } = launch(session, [backend]);
        await vi.waitFor(() => expect(client.rpcHandlerManager.handlers.has(RPC_METHODS.SteerQueuedMessage)).toBe(true));

        queue.push('later', REVIEW, 'idle-1');
        const result = await (client.rpcHandlerManager.handlers as Handlers).get(RPC_METHODS.SteerQueuedMessage)!({ localId: 'idle-1' });

        expect(result).toEqual({ steered: false, error: 'No active steerable turn' });
        expect(backend.steerPrompts).toEqual([]);
        await vi.waitFor(() => expect(backend.prompts).toEqual([[{ type: 'text', text: 'later' }]]));
        queue.close();
        await run;
    });

    it('does not steer a message queued under a different mode', async () => {
        const backend = new FakeAgyBackend();
        const { queue, run, handlers, releaseFirst } = await startHeldTurn(backend);

        queue.push('plan it instead', { permissionMode: 'plan' }, 'other-mode');
        const result = await handlers.get(RPC_METHODS.SteerQueuedMessage)!({ localId: 'other-mode' });

        expect(result).toEqual({ steered: false, error: 'Queued message mode differs from the active turn' });
        expect(backend.steerPrompts).toEqual([]);
        expect(queue.size()).toBe(1);
        releaseFirst();
        await vi.waitFor(() => expect(backend.prompts).toHaveLength(2));
        queue.close();
        await run;
    });

    it('puts the message back when agy cannot take the steer', async () => {
        const backend = new FakeAgyBackend();
        backend.steerDispatchError = new Error('stdin closed');
        const { queue, client, run, handlers, releaseFirst } = await startHeldTurn(backend);

        queue.push('also lint', REVIEW, 'steer-1');
        const result = await handlers.get(RPC_METHODS.SteerQueuedMessage)!({ localId: 'steer-1' });

        expect(result).toEqual({ steered: false, error: 'Failed to steer into the active turn' });
        expect(client.setSteerDeliveryState).toHaveBeenLastCalledWith(['steer-1'], 'queued');
        expect(queue.size()).toBe(1);
        releaseFirst();
        await vi.waitFor(() => expect(backend.prompts).toHaveLength(2));
        expect(backend.prompts[1]).toEqual([{ type: 'text', text: 'also lint' }]);
        queue.close();
        await run;
    });

    it('Stop cancels the turn, releases an open steer, and holds it for Retry', async () => {
        const backend = new FakeAgyBackend();
        const { queue, client, run, handlers, releaseFirst } = await startHeldTurn(backend);
        queue.push('also lint', REVIEW, 'steer-1');
        await handlers.get(RPC_METHODS.SteerQueuedMessage)!({ localId: 'steer-1' });
        backend.onCancel = () => {
            releaseFirst();
            backend.steerCompletions[0]!.resolve('cancelled');
        };

        await handlers.get(RPC_METHODS.Abort)!();

        await vi.waitFor(() => expect(sessionEvents(client)).toContainEqual({ type: 'ready' }));
        expect(backend.cancelCalls).toEqual(['agy-conv-new']);
        // agy answered the steer, so this turn's handler keeps running.
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(backend.abortSoftSteersCalls).toBe(0);
        expect(client.emitSteerIndeterminate).toHaveBeenCalledWith(['steer-1']);
        expect(client.emitMessagesConsumed).not.toHaveBeenCalledWith(['steer-1'], { steered: true });
        queue.close();
        await run;
    });

    it('Stop drops a steer agy never answers and stops agy (no late approvals)', async () => {
        const backend = new FakeAgyBackend();
        const { session, queue, client, run, created, handlers, releaseFirst } = await startHeldTurn(backend);
        session.setPermissionMode('always-proceed');
        queue.push('also lint', REVIEW, 'steer-1');
        await handlers.get(RPC_METHODS.SteerQueuedMessage)!({ localId: 'steer-1' });
        releaseFirst();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(sessionEvents(client)).not.toContainEqual({ type: 'ready' });

        await handlers.get(RPC_METHODS.Abort)!();

        await vi.waitFor(() => expect(sessionEvents(client)).toContainEqual({ type: 'ready' }));
        await vi.waitFor(() => expect(backend.disconnected).toBe(true));
        // A late request from the stopped process is cancelled, not auto-approved.
        backend.permissionHandler!({
            id: 'late', sessionId: 'agy-conv-new', toolCallId: 'call_late', title: 'rm -rf build', kind: 'execute',
            rawInput: { CommandLine: 'rm -rf build' },
            options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
        });
        await vi.waitFor(() => expect(backend.permissionResponses.at(-1)).toEqual({ outcome: 'cancelled' }));
        expect(backend.permissionResponses).not.toContainEqual({ outcome: 'selected', optionId: 'allow' });
        // Usage the dropped steer reports later is not a new turn.
        const usageEvents = () => roundSummaries(client).length;
        const before = usageEvents();
        backend.steerCompletions[0]!.onUsage?.({ type: 'usage', inputTokens: 9, outputTokens: 9 });
        expect(usageEvents()).toBe(before);
        // The row is held for Retry/Cancel instead of staying "dispatching".
        expect(client.emitSteerIndeterminate).toHaveBeenCalledWith(['steer-1']);
        expect(client.emitMessagesConsumed).not.toHaveBeenCalledWith(['steer-1'], { steered: true });
        // agy restarts before the next turn so the abandoned request cannot leak into it.
        queue.push('next', REVIEW, 'next');
        await vi.waitFor(() => expect(created).toHaveLength(2));
        queue.close();
        await run;
    });

    it('acknowledges a steer once when it is retried after a failed dispatch', async () => {
        const backend = new FakeAgyBackend();
        backend.steerDispatchError = new Error('stdin closed');
        const { queue, client, run, handlers, releaseFirst } = await startHeldTurn(backend);
        queue.push('also lint', REVIEW, 'steer-1');
        expect(await handlers.get(RPC_METHODS.SteerQueuedMessage)!({ localId: 'steer-1' }))
            .toEqual({ steered: false, error: 'Failed to steer into the active turn' });

        backend.steerDispatchError = null;
        expect(await handlers.get(RPC_METHODS.SteerQueuedMessage)!({ localId: 'steer-1' })).toEqual({ steered: true });
        backend.echo!('also lint');
        // The failed first attempt must not swallow the retried steer's echo.
        expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['steer-1'], { steered: true });
        releaseFirst();
        backend.steerCompletions[1]!.resolve('end_turn');
        await vi.waitFor(() => expect(sessionEvents(client)).toContainEqual({ type: 'ready' }));
        queue.close();
        await run;

        expect(client.emitMessagesConsumed.mock.calls.filter(([ids]) => (ids as string[])[0] === 'steer-1')).toHaveLength(1);
    });
});

describe('AgyAcpRemoteLauncher delivery and recovery', () => {
    type Handlers = Map<string, (payload?: unknown) => Promise<unknown>>;
    const steerRpc = (client: ReturnType<typeof makeClient>) =>
        (client.rpcHandlerManager.handlers as Handlers).get(RPC_METHODS.SteerQueuedMessage)!;
    const abortRpc = (client: ReturnType<typeof makeClient>) =>
        (client.rpcHandlerManager.handlers as Handlers).get(RPC_METHODS.Abort)!;
    const indeterminate = () => {
        const error = new Error('ACP transport closed');
        Object.defineProperty(error, ACP_INDETERMINATE_SYMBOL, { value: true });
        return error;
    };

    async function heldTurn(backend: FakeAgyBackend, mode: AgyMode = REVIEW) {
        const { session, queue, client } = makeSession();
        let release!: () => void;
        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({ type: 'tool_call', id: 't1', name: 'run_command', input: {}, status: 'in_progress' });
            await new Promise<void>((resolve) => { release = resolve; });
        });
        queue.push('run the tests', mode, 'first');
        const { run, created } = launch(session, [backend]);
        await vi.waitFor(() => expect(backend.prompts).toHaveLength(1));
        return { session, queue, client, run, created, release: () => release() };
    }

    const rejected = () => Object.assign(
        new Error("Can't add this prompt to session: the running prompt is waiting for a permission or question answer"),
        { code: -32603 }
    );

    it('keeps a rejected steer queued and runs it next', async () => {
        const backend = new FakeAgyBackend();
        const { queue, client, run, release } = await heldTurn(backend);
        queue.push('also lint', REVIEW, 'steer-1');
        expect(await steerRpc(client)({ localId: 'steer-1' })).toEqual({ steered: true });

        backend.steerCompletions[0]!.reject(rejected());
        await vi.waitFor(() => expect(queue.size()).toBe(1));
        expect(client.emitMessagesConsumed).not.toHaveBeenCalledWith(['steer-1'], { steered: true });

        release();
        await vi.waitFor(() => expect(backend.prompts).toEqual([
            [{ type: 'text', text: 'run the tests' }],
            [{ type: 'text', text: 'also lint' }]
        ]));
        queue.close();
        await run;
    });

    it("does not take the prompt's own echo for a steer whose text it contains", async () => {
        const { session, queue, client } = makeSession();
        const backend = new FakeAgyBackend();
        let release!: () => void;
        backend.promptScripts.push(async () => {
            await new Promise<void>((resolve) => { release = resolve; });
        });
        queue.push('run the tests and then lint', REVIEW, 'first');
        const { run } = launch(session, [backend]);
        await vi.waitFor(() => expect(backend.prompts).toHaveLength(1));

        // The steer is sent before agy echoes the prompt.
        queue.push('lint', REVIEW, 'steer-1');
        expect(await steerRpc(client)({ localId: 'steer-1' })).toEqual({ steered: true });
        backend.echo!('run the tests and then lint');
        expect(client.emitMessagesConsumed).not.toHaveBeenCalledWith(['steer-1'], { steered: true });

        backend.steerCompletions[0]!.reject(rejected());
        await vi.waitFor(() => expect(queue.size()).toBe(1));
        release();
        await vi.waitFor(() => expect(backend.prompts).toHaveLength(2));
        queue.close();
        await run;
    });

    it('credits an echo to the steer it spells out when another steer is a substring of it', async () => {
        const backend = new FakeAgyBackend();
        const { queue, client, run, release } = await heldTurn(backend);
        queue.push('lint', REVIEW, 'short');
        queue.push('fix lint errors', REVIEW, 'long');
        expect(await steerRpc(client)({ localId: 'short' })).toEqual({ steered: true });
        expect(await steerRpc(client)({ localId: 'long' })).toEqual({ steered: true });

        backend.echo!('fix lint errors');
        expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['long'], { steered: true });
        expect(client.emitMessagesConsumed).not.toHaveBeenCalledWith(['short'], { steered: true });
        backend.echo!('lint');
        expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['short'], { steered: true });

        release();
        for (const steer of backend.steerCompletions) steer.resolve('end_turn');
        await vi.waitFor(() => expect(sessionEvents(client)).toContainEqual({ type: 'ready' }));
        queue.close();
        await run;
    });

    it('restores the prompt after Stop when the only steer was rejected', async () => {
        const backend = new FakeAgyBackend();
        const { session, queue, client } = makeSession();
        let cancelled!: () => void;
        backend.onCancel = () => cancelled?.();
        backend.promptScripts.push(async (onUpdate) => {
            await new Promise<void>((resolve) => { cancelled = resolve; });
            onUpdate({ type: 'turn_complete', stopReason: 'cancelled' });
        });
        queue.push('build it', REVIEW, 'first');
        const { run } = launch(session, [backend]);
        await vi.waitFor(() => expect(backend.prompts).toHaveLength(1));
        queue.push('also lint', REVIEW, 'steer-1');
        expect(await steerRpc(client)({ localId: 'steer-1' })).toEqual({ steered: true });
        backend.steerCompletions[0]!.reject(rejected());
        await vi.waitFor(() => expect(queue.size()).toBe(1));

        await abortRpc(client)();
        await vi.waitFor(() => expect(sessionEvents(client)).toContainEqual({ type: 'abort-restore', text: 'build it' }));
        queue.close();
        await run;
    });

    it('does not drop a steer agy answered while HAPI still drains its output', async () => {
        const backend = new FakeAgyBackend();
        const { queue, client, run, release, created } = await heldTurn(backend);
        queue.push('also lint', REVIEW, 'steer-1');
        expect(await steerRpc(client)({ localId: 'steer-1' })).toEqual({ steered: true });
        backend.onCancel = () => {
            release();
            // agy answers the steer at once; its late output keeps HAPI busy
            // past the steer grace period.
            backend.steerCompletions[0]!.answer();
        };

        await abortRpc(client)();
        await new Promise((resolve) => setTimeout(resolve, 120));
        expect(client.emitSteerIndeterminate).not.toHaveBeenCalled();
        expect(backend.disconnected).toBe(false);

        backend.steerCompletions[0]!.resolve('end_turn');
        await vi.waitFor(() => expect(sessionEvents(client)).toContainEqual({ type: 'ready' }));
        queue.close();
        await run;
        expect(created).toHaveLength(1);
    });

    it('leaves the tool run and the wait for an approval out of tok/s', async () => {
        const { session, queue, client } = makeSession();
        const backend = new FakeAgyBackend();
        let approvalAnswered!: () => void;
        backend.promptScripts.push(async (onUpdate) => {
            await new Promise((resolve) => setTimeout(resolve, 40));
            onUpdate({ type: 'tool_call', id: 't1', name: 'run_command', input: {}, status: 'in_progress' });
            await new Promise((resolve) => setTimeout(resolve, 200));
            onUpdate({ type: 'tool_result', id: 't1', output: 'ok', status: 'completed' });
            backend.permissionHandler!({
                id: 'p1', sessionId: 'agy-conv-new', toolCallId: 'call_p1', title: 'rm -rf build', kind: 'execute',
                rawInput: { CommandLine: 'rm -rf build' },
                options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
            });
            await new Promise<void>((resolve) => { approvalAnswered = resolve; });
            onUpdate({ type: 'text', text: 'done' });
            await new Promise((resolve) => setTimeout(resolve, 40));
            onUpdate({ type: 'usage', inputTokens: 10, outputTokens: 30, thoughtTokens: 10 });
        });
        queue.push('clean up', REVIEW, 'a');
        const { run } = launch(session, [backend]);
        await vi.waitFor(() => expect(Object.keys(agentState(client).requests ?? {})).toEqual(['p1']));
        await new Promise((resolve) => setTimeout(resolve, 200));
        await client.rpcHandlerManager.handlers.get(RPC_METHODS.Permission)!({ id: 'p1', approved: true });
        approvalAnswered();
        queue.close();
        await run;

        const summary = client.sendAgentMessage.mock.calls
            .map(([message]) => message as { type: string; summary?: { duration_ms?: number; generation_ms?: number; generation_output_tokens?: number } })
            .find((message) => message.type === 'round-summary')!.summary!;
        expect(summary.duration_ms).toBeGreaterThanOrEqual(480);
        // About 80 ms of generation: the 200 ms tool run and the ~200 ms
        // approval wait are left out.
        expect(summary.generation_ms).toBeGreaterThanOrEqual(60);
        expect(summary.generation_ms).toBeLessThan(200);
        expect(summary.generation_output_tokens).toBe(40);
    });

    it('times the round from sending the prompt to agy answering', async () => {
        const { session, queue, client } = makeSession();
        const backend = new FakeAgyBackend();
        backend.preSendDelayMs = 150;
        backend.postResponseDrainMs = 150;
        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({ type: 'text', text: 'done' });
            onUpdate({ type: 'usage', inputTokens: 10, outputTokens: 1 });
        });
        queue.push('hello', REVIEW, 'a');
        queue.close();

        await launch(session, [backend]).run;

        const summary = client.sendAgentMessage.mock.calls
            .map(([message]) => message as { type: string; summary?: { duration_ms?: number } })
            .find((message) => message.type === 'round-summary')!.summary!;
        expect(summary.duration_ms).toBeLessThan(100);
    });

    it('does not report a start failure or fall back when the session is killed while agy starts', async () => {
        const { session, queue, client } = makeSession();
        const backend = new FakeAgyBackend();
        let failStart!: (error: Error) => void;
        backend.initializeGate = new Promise((_resolve, reject) => { failStart = reject; });
        backend.onDisconnect = () => failStart(new Error('ACP transport closed'));
        const { run } = launch(session, [backend]);
        await vi.waitFor(() => expect(backend.calls).toEqual(['initialize']));

        await session.kill();
        queue.close();

        await expect(run).resolves.toBe('exit');
        expect(sessionEvents(client).filter((event) => (event as { type: string }).type === 'error')).toEqual([]);
    });

    it('holds steers that a later steer answered early when Stop comes before their echo', async () => {
        const backend = new FakeAgyBackend();
        const { queue, client, run, release } = await heldTurn(backend);
        let cancelled = false;
        backend.onCancel = () => {
            if (cancelled) return;
            cancelled = true;
            release();
            for (const steer of backend.steerCompletions) steer.resolve('cancelled');
        };
        queue.push('also lint', REVIEW, 'steer-1');
        queue.push('and format', REVIEW, 'steer-2');
        expect(await steerRpc(client)({ localId: 'steer-1' })).toEqual({ steered: true });
        expect(await steerRpc(client)({ localId: 'steer-2' })).toEqual({ steered: true });
        // The second steer interrupts the first one's request: agy answers it
        // at once, while the tool call and the turn go on.
        backend.steerCompletions[0]!.resolve('end_turn');
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(client.emitMessagesConsumed).not.toHaveBeenCalledWith(['steer-1'], { steered: true });

        await abortRpc(client)();
        await vi.waitFor(() => expect(sessionEvents(client)).toContainEqual({ type: 'ready' }));
        expect(client.emitSteerIndeterminate).toHaveBeenCalledWith(['steer-1']);
        expect(client.emitSteerIndeterminate).toHaveBeenCalledWith(['steer-2']);
        expect(client.emitMessagesConsumed).not.toHaveBeenCalledWith(['steer-1'], { steered: true });
        queue.close();
        await run;
    });

    it('holds an early-answered steer when agy dies before its echo', async () => {
        const backend = new FakeAgyBackend();
        const { queue, client, run, release } = await heldTurn(backend);
        queue.push('also lint', REVIEW, 'steer-1');
        queue.push('and format', REVIEW, 'steer-2');
        expect(await steerRpc(client)({ localId: 'steer-1' })).toEqual({ steered: true });
        expect(await steerRpc(client)({ localId: 'steer-2' })).toEqual({ steered: true });
        // The second steer answers the first one's request at once; then agy
        // exits before echoing either.
        release();
        backend.steerCompletions[0]!.resolve('end_turn');
        await new Promise((resolve) => setTimeout(resolve, 20));
        backend.alive = false;
        backend.steerCompletions[1]!.reject(indeterminate());
        await vi.waitFor(() => expect(sessionEvents(client)).toContainEqual({ type: 'ready' }));

        expect(client.emitSteerIndeterminate).toHaveBeenCalledWith(['steer-1']);
        expect(client.emitSteerIndeterminate).toHaveBeenCalledWith(['steer-2']);
        expect(client.emitMessagesConsumed).not.toHaveBeenCalledWith(['steer-1'], { steered: true });
        queue.close();
        await run;
    });

    it('confirms an early-answered steer at its echo, or when the turn ends without one', async () => {
        const backend = new FakeAgyBackend();
        const { queue, client, run, release } = await heldTurn(backend);
        queue.push('also lint', REVIEW, 'steer-1');
        queue.push('and format', REVIEW, 'steer-2');
        expect(await steerRpc(client)({ localId: 'steer-1' })).toEqual({ steered: true });
        expect(await steerRpc(client)({ localId: 'steer-2' })).toEqual({ steered: true });
        backend.steerCompletions[0]!.resolve('end_turn');

        backend.echo!('run the tests');
        backend.echo!('also lint');
        expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['steer-1'], { steered: true });
        expect(client.emitMessagesConsumed).not.toHaveBeenCalledWith(['steer-2'], { steered: true });

        // agy never echoes the second steer; the turn still ends normally.
        release();
        backend.steerCompletions[1]!.resolve('end_turn');
        await vi.waitFor(() => expect(sessionEvents(client)).toContainEqual({ type: 'ready' }));
        expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['steer-2'], { steered: true });
        expect(client.emitSteerIndeterminate).not.toHaveBeenCalled();
        queue.close();
        await run;
    });

    it('refuses a steer that arrives after Stop and stops offering Steer at once', async () => {
        const backend = new FakeAgyBackend();
        const { queue, client, run, release } = await heldTurn(backend);

        await abortRpc(client)();
        // agy has not answered the cancel yet.
        expect(steeringStates(client).at(-1)).toBe(false);
        queue.push('also lint', REVIEW, 'late');
        const result = await steerRpc(client)({ localId: 'late' });

        expect(result).toEqual({ steered: false, error: 'No active steerable turn' });
        expect(backend.steerPrompts).toEqual([]);
        expect(queue.size()).toBe(1);
        release();
        await vi.waitFor(() => expect(backend.prompts).toHaveLength(2));
        queue.close();
        await run;
    });

    it('restarts agy again after a relaunch that failed half-way', async () => {
        const { session, queue, client } = makeSession();
        const first = new FakeAgyBackend();
        const broken = new FakeAgyBackend();
        broken.resumeError = new Error('conversation not found');
        broken.newSessionError = new Error('session/new failed');
        const third = new FakeAgyBackend();
        queue.push('one', REVIEW, 'a');
        const { run, created } = launch(session, [first, broken, third]);
        await vi.waitFor(() => expect(first.prompts).toHaveLength(1));
        await vi.waitFor(() => expect(sessionEvents(client)).toContainEqual({ type: 'ready' }));

        first.alive = false;
        queue.push('two', REVIEW, 'b');
        await vi.waitFor(() => expect(sessionEvents(client)).toContainEqual({ type: 'abort-restore', text: 'two' }));
        expect(broken.disconnected).toBe(true);
        queue.push('three', REVIEW, 'c');
        await vi.waitFor(() => expect(third.prompts).toHaveLength(1));
        queue.close();
        await run;

        expect(created).toHaveLength(3);
        expect(broken.prompts).toEqual([]);
        expect(third.resumeCalls).toEqual(['agy-conv-new']);
        expect(third.setModeCalls).toEqual(['default']);
        expect(sessionEvents(client)).toContainEqual({
            type: 'error',
            message: 'Failed to restart Antigravity: session/new failed'
        });
    });

    it('approves once in always-proceed even when agy offers a standing grant', async () => {
        const { session, queue } = makeSession();
        const backend = new FakeAgyBackend();
        backend.promptScripts.push(async () => {
            backend.permissionHandler!({
                id: 'p1', sessionId: 'agy-conv-new', toolCallId: 'call_p1', title: 'git push', kind: 'execute',
                rawInput: { CommandLine: 'git push' },
                options: [
                    { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
                    { optionId: 'once', name: 'Allow', kind: 'allow_once' }
                ]
            });
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        queue.push('push it', { permissionMode: 'always-proceed' }, 'a');
        queue.close();

        await launch(session, [backend]).run;

        expect(backend.permissionResponses).toEqual([{ outcome: 'selected', optionId: 'once' }]);
    });

    it('leaves an agy question permission request to the user in always-proceed', async () => {
        const { session, queue, client } = makeSession();
        const backend = new FakeAgyBackend();
        backend.promptScripts.push(async () => {
            backend.permissionHandler!({
                id: 'q1', sessionId: 'agy-conv-new', toolCallId: 'call_q', title: 'Run ask_question', kind: 'other',
                rawInput: { questions: [{ question: 'RED or BLUE?', options: ['RED', 'BLUE'] }] },
                options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
            });
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        queue.push('ask me', { permissionMode: 'always-proceed' }, 'a');
        queue.close();

        await launch(session, [backend]).run;

        // Pending for the user during the turn; the turn end answers it `cancelled`.
        expect(backend.permissionResponses).toEqual([{ outcome: 'cancelled' }]);
        const requested = client.updateAgentState.mock.calls
            .map(([update]) => (update as (state: object) => { requests?: Record<string, unknown> })({}).requests)
            .some((requests) => requests?.q1 !== undefined);
        expect(requested).toBe(true);
    });

    it('matches a steer echo split across chunks and spacing', async () => {
        const backend = new FakeAgyBackend();
        const { queue, client, run, release } = await heldTurn(backend);
        queue.push('Additional instructions:\n- End with BANANA.\n-   Keep it short.  ', REVIEW, 'steer-1');
        await steerRpc(client)({ localId: 'steer-1' });

        backend.echo!('Additional instructions:\n- End with');
        expect(client.emitMessagesConsumed).not.toHaveBeenCalledWith(['steer-1'], { steered: true });
        backend.echo!(' BANANA.\n- Keep it short.');

        expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['steer-1'], { steered: true });
        release();
        backend.steerCompletions[0]!.resolve('end_turn');
        queue.close();
        await run;
    });

    it('confirms delivery only once agy takes the prompt', async () => {
        const { session, queue, client } = makeSession();
        const backend = new FakeAgyBackend();
        let openGate!: () => void;
        backend.setModelGate = new Promise((resolve) => { openGate = resolve; });
        backend.promptScripts.push(async (onUpdate) => {
            backend.echo!('build it');
            onUpdate({ type: 'text', text: 'done' });
        });
        queue.push('build it', { permissionMode: 'request-review', model: 'gemini-3.8-flash', effort: 'low' }, 'a');
        const { run } = launch(session, [backend]);
        await vi.waitFor(() => expect(backend.setModeCalls).toEqual(['default']));

        expect(client.emitMessagesConsumed).not.toHaveBeenCalled();
        openGate();
        await vi.waitFor(() => expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['a']));
        queue.close();
        await run;
        expect(client.emitMessagesConsumed).toHaveBeenCalledTimes(1);
    });

    it('keeps a steer queued when the prompt has not reached agy yet', async () => {
        const { session, queue, client } = makeSession();
        const backend = new FakeAgyBackend();
        backend.preSendDelayMs = 150;
        queue.push('first', REVIEW, 'a');
        const { run } = launch(session, [backend]);
        await vi.waitFor(() => expect(backend.setModeCalls).toEqual(['default']));

        queue.push('early steer', REVIEW, 'early');
        const result = await steerRpc(client)({ localId: 'early' });

        expect(result).toEqual({ steered: false, error: 'Failed to steer into the active turn' });
        expect(queue.size()).toBe(1);
        await vi.waitFor(() => expect(backend.prompts).toHaveLength(2));
        queue.close();
        await run;
    });

    it('keeps the HAPI turn open for a steer sent while the answer drains', async () => {
        const { session, queue, client } = makeSession();
        const backend = new FakeAgyBackend();
        backend.postResponseDrainMs = 200;
        queue.push('first', REVIEW, 'a');
        const { run } = launch(session, [backend]);
        await vi.waitFor(() => expect(backend.prompts).toHaveLength(1));
        await vi.waitFor(() => expect(backend.promptInFlight).toBe(false));

        queue.push('one more thing', REVIEW, 'late');
        expect(await steerRpc(client)({ localId: 'late' })).toEqual({ steered: true });
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(sessionEvents(client)).not.toContainEqual({ type: 'ready' });

        backend.steerCompletions[0]!.resolve('end_turn');
        await vi.waitFor(() => expect(sessionEvents(client)).toContainEqual({ type: 'ready' }));
        expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['late'], { steered: true });
        queue.close();
        await run;
    });

    it('holds a steer when agy dies after the interrupted request returned', async () => {
        const backend = new FakeAgyBackend();
        const { queue, client, run, release } = await heldTurn(backend);
        queue.push('also lint', REVIEW, 'steer-1');
        await steerRpc(client)({ localId: 'steer-1' });
        release();
        await new Promise((resolve) => setTimeout(resolve, 20));

        backend.alive = false;
        backend.steerCompletions[0]!.reject(indeterminate());

        await vi.waitFor(() => expect(sessionEvents(client)).toContainEqual({ type: 'ready' }));
        expect(client.emitSteerIndeterminate).toHaveBeenCalledWith(['steer-1']);
        expect(sessionEvents(client)).not.toContainEqual({ type: 'abort-restore', text: 'run the tests' });
        queue.close();
        await run;
    });

    it('totals the usage agy 1.5.2 reported for a steered turn', async () => {
        const results = agySteeredTurn.frames
            .filter((frame) => frame.direction === 'agy->client' && 'result' in frame.message)
            .map((frame) => (frame.message as unknown as { result: { usage: Record<string, number> } }).result.usage);
        const toUsage = (u: Record<string, number>) => ({
            type: 'usage' as const, inputTokens: u.inputTokens!, outputTokens: u.outputTokens!,
            totalTokens: u.totalTokens, thoughtTokens: u.thoughtTokens, cacheReadTokens: u.cachedReadTokens
        });
        const backend = new FakeAgyBackend();
        let steered!: () => void;
        const steerSent = new Promise<void>((resolve) => { steered = resolve; });
        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({ type: 'tool_call', id: 't1', name: 'run_command', input: {}, status: 'in_progress' });
            // agy answers the interrupted request as soon as the steer arrives.
            await steerSent;
            onUpdate(toUsage(results[0]!));
        });
        const { session, queue, client } = makeSession();
        queue.push('run the tests', REVIEW, 'first');
        const { run } = launch(session, [backend]);
        await vi.waitFor(() => expect(backend.prompts).toHaveLength(1));
        queue.push('also lint', REVIEW, 'steer-1');
        expect(await steerRpc(client)({ localId: 'steer-1' })).toEqual({ steered: true });
        steered();
        await vi.waitFor(() => expect(backend.promptInFlight).toBe(false));
        backend.steerCompletions[0]!.onUsage?.(toUsage(results[1]!));
        backend.steerCompletions[0]!.resolve('end_turn');
        await vi.waitFor(() => expect(sessionEvents(client)).toContainEqual({ type: 'ready' }));
        queue.close();
        await run;

        const summaries = roundSummaries(client);
        expect(summaries).toHaveLength(1);
        expect(summaries[0]).toMatchObject({
            provider: 'agy',
            model: 'gemini-4-argon-medium',
            agy_usage: {
                input_tokens: 15172 + 15286,
                output_tokens: 44 + 14,
                thinking_tokens: 0,
                cache_read_tokens: 0,
                total_tokens: 15216 + 15300
            },
            duration_ms: expect.any(Number)
        });
    });
});

describe('AgyAcpRemoteLauncher permissions', () => {
    const commandRequest = (id: string): PermissionRequest => ({
        id,
        sessionId: 'agy-conv-new',
        toolCallId: `call_${id}`,
        title: 'grep -n think notes.md',
        kind: 'execute',
        rawInput: { CommandLine: 'grep -n think notes.md' },
        options: [
            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
            { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
        ]
    });

    it.each([
        ['request-review' as const, []],
        ['always-proceed' as const, [{ outcome: 'selected', optionId: 'allow' }]]
    ])('in %s, a command mentioning a HAPI tool hint gets %j', async (permissionMode, expected) => {
        const { session, queue } = makeSession();
        const backend = new FakeAgyBackend();
        backend.promptScripts.push(async () => {
            backend.permissionHandler!(commandRequest('p1'));
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        queue.push('hello', { permissionMode }, 'a');
        queue.close();

        await launch(session, [backend]).run;

        // The turn-end cancelAll answers anything still pending with cancelled.
        expect(backend.permissionResponses.filter((response) =>
            (response as { outcome: string }).outcome === 'selected')).toEqual(expected);
    });
    it('refuses a steer while agy waits for an approval, keeping the message queued', async () => {
        const { session, queue, client } = makeSession();
        const backend = new FakeAgyBackend();
        let finish!: () => void;
        backend.promptScripts.push(async () => {
            backend.permissionHandler!(commandRequest('p1'));
            await new Promise<void>((resolve) => { finish = resolve; });
        });
        queue.push('run it', REVIEW, 'a');
        const { run } = launch(session, [backend]);
        await vi.waitFor(() => expect(Object.keys(agentState(client).requests ?? {})).toEqual(['p1']));

        queue.push('also lint', REVIEW, 'steer-1');
        const steer = client.rpcHandlerManager.handlers.get(RPC_METHODS.SteerQueuedMessage)!;
        // agy rejects a prompt while an approval is open (-32603).
        expect(await steer({ localId: 'steer-1' })).toEqual({
            steered: false,
            error: 'Antigravity is waiting for your approval or answer; respond to it, then steer'
        });
        expect(backend.steerPrompts).toEqual([]);
        expect(client.setSteerDeliveryState).not.toHaveBeenCalled();
        expect(queue.size()).toBe(1);

        finish();
        await vi.waitFor(() => expect(backend.prompts).toHaveLength(2));
        queue.close();
        await run;
    });
});

describe('AgyAcpRemoteLauncher questions', () => {
    it('never answers an agy question, even in always-proceed', async () => {
        const { session, queue, client } = makeSession();
        const backend = new FakeAgyBackend();
        // agy 1.5.2 asks without an elicitation capability like this: an
        // ask_question tool call left pending, the question as text, end_turn.
        // The user answers with the next message.
        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({
                type: 'tool_call', id: 'call_q', name: 'Run ask_question', kind: 'other', status: 'pending',
                input: { questions: [{ question: 'RED or BLUE?', options: ['RED', 'BLUE'], is_multi_select: false }] }
            });
            onUpdate({ type: 'text', text: 'RED or BLUE?\n- [1] RED\n- [2] BLUE' });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
        });
        queue.push('ask me', { permissionMode: 'always-proceed' }, 'a');
        queue.close();

        await launch(session, [backend]).run;

        expect(backend.permissionResponses).toEqual([]);
        expect(client.sendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'message', message: 'RED or BLUE?\n- [1] RED\n- [2] BLUE'
        }));
        expect(sessionEvents(client)).toContainEqual({ type: 'ready' });
    });
});

describe('AgyAcpRemoteLauncher tool cards', () => {
    const toolMessages = (client: ReturnType<typeof makeClient>) => client.sendAgentMessage.mock.calls
        .map(([message]) => message as Record<string, unknown>)
        .filter((message) => message.type === 'tool-call' || message.type === 'tool-call-result');

    it('shows agy tools as their canonical cards and cleans the command result', async () => {
        const { session, queue, client } = makeSession();
        const backend = new FakeAgyBackend();
        backend.promptScripts.push(async (onUpdate) => {
            const args = { CommandLine: 'ls', WaitMsBeforeAsync: 5000, toolSummary: 'List files' };
            onUpdate({
                type: 'tool_call', id: 'c1', name: 'ls', input: args, status: 'in_progress',
                title: 'ls', kind: 'execute', nativeName: 'run_command', nativeArgs: args
            });
            onUpdate({
                type: 'tool_result', id: 'c1', status: 'completed',
                output: { output: 'Command exited with code 0.\n\nCommand output:\na\r\nb\r\n', exit_code: 0 }
            });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
        });
        queue.push('go', REVIEW, 'a');
        queue.close();

        await launch(session, [backend]).run;

        expect(toolMessages(client)).toMatchObject([
            { type: 'tool-call', callId: 'c1', name: 'Bash', input: { command: 'ls', description: 'List files' } },
            { type: 'tool-call-result', callId: 'c1', output: { stdout: 'a\nb', exit_code: 0 } }
        ]);
    });

    it('closes a command agy moved to the background at the end of the turn, and the real result replaces it', async () => {
        const { session, queue, client } = makeSession();
        const backend = new FakeAgyBackend();
        const args = { CommandLine: 'sleep 30', WaitMsBeforeAsync: 5000 };
        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({
                type: 'tool_call', id: 'bg', name: 'sleep 30', input: args, status: 'in_progress',
                kind: 'execute', nativeName: 'run_command', nativeArgs: args
            });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
        });
        backend.promptScripts.push(async (onUpdate) => {
            // agy reports the completion inside the next prompt's stream.
            onUpdate({
                type: 'tool_call', id: 'bg', name: 'sleep 30', input: args, status: 'in_progress',
                kind: 'execute', nativeName: 'run_command', nativeArgs: args
            });
            onUpdate({
                type: 'tool_result', id: 'bg', status: 'completed',
                output: { output: 'Command exited with code 0.\n\nCommand output:\ndone', exit_code: 0 }
            });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
        });
        queue.push('start it', REVIEW, 'a');
        const { run } = launch(session, [backend]);
        await vi.waitFor(() => expect(sessionEvents(client)).toContainEqual({ type: 'ready' }));
        expect(toolMessages(client).filter((m) => m.type === 'tool-call-result')).toMatchObject([
            { callId: 'bg', output: { stdout: expect.stringContaining('background') }, is_error: false }
        ]);

        queue.push('next', REVIEW, 'b');
        await vi.waitFor(() => expect(backend.prompts).toHaveLength(2));
        queue.close();
        await run;

        const results = toolMessages(client).filter((m) => m.type === 'tool-call-result');
        expect(results).toHaveLength(2);
        expect(results[1]).toMatchObject({ callId: 'bg', output: { stdout: 'done', exit_code: 0 } });
    });

    it('does not call a command that never started a background command', async () => {
        const { session, queue, client } = makeSession();
        const backend = new FakeAgyBackend();
        backend.promptScripts.push(async (onUpdate) => {
            const args = { CommandLine: 'rm -rf x' };
            onUpdate({
                type: 'tool_call', id: 'd', name: 'rm -rf x', input: args, status: 'in_progress',
                kind: 'execute', nativeName: 'run_command', nativeArgs: args
            });
            // Waiting for approval; the user denies and agy ends the turn.
            onUpdate({
                type: 'tool_call', id: 'd', name: 'rm -rf x', input: args, status: 'pending',
                kind: 'execute', nativeName: 'run_command', nativeArgs: args
            });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
        });
        queue.push('go', REVIEW, 'a');
        queue.close();

        await launch(session, [backend]).run;

        expect(toolMessages(client).filter((m) => m.type === 'tool-call-result')).toEqual([]);
    });

    it('does not close a command that finished or a turn that was cancelled', async () => {
        const { session, queue, client } = makeSession();
        const backend = new FakeAgyBackend();
        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({
                type: 'tool_call', id: 'x', name: 'x', input: {}, status: 'in_progress',
                kind: 'execute', nativeName: 'run_command', nativeArgs: { CommandLine: 'x' }
            });
            onUpdate({ type: 'turn_complete', stopReason: 'cancelled' });
        });
        queue.push('go', REVIEW, 'a');
        queue.close();

        await launch(session, [backend]).run;

        expect(toolMessages(client).filter((m) => m.type === 'tool-call-result')).toEqual([]);
    });
});

describe('agy ACP helpers', () => {
    it('maps HAPI permission modes to agy ACP modes', () => {
        expect(agyAcpModeForPermission('request-review')).toBe('default');
        expect(agyAcpModeForPermission('always-proceed')).toBe('default');
        expect(agyAcpModeForPermission('acceptEdits')).toBe('accept-edits');
        expect(agyAcpModeForPermission('plan')).toBe('plan');
        expect(agyAcpModeForPermission(undefined)).toBe('default');
    });

    it('builds agy model ids from the stored model and effort', () => {
        expect(resolveAgyAcpModelId('gemini-3.8-flash', 'low', null)).toBe('gemini-3.8-flash-low');
        expect(resolveAgyAcpModelId('gpt-oss-120b-medium', null, null)).toBe('gpt-oss-120b-medium');
        expect(resolveAgyAcpModelId('gemini-3.8-flash-high', 'low', null)).toBe('gemini-3.8-flash-high');
        expect(resolveAgyAcpModelId(null, null, 'gemini-4-argon-medium')).toBe('gemini-4-argon-medium');
        expect(resolveAgyAcpModelId(null, 'high', 'gemini-4-argon-medium')).toBe('gemini-4-argon-high');
        expect(resolveAgyAcpModelId(undefined, undefined, null)).toBeNull();
    });

    it('takes tool runs and waits for the user out of the generation time', () => {
        // A tool run and, separately, a wait for an approval.
        expect(generationTimeMs(0, 10_000, [{ start: 1_000, end: 4_000 }, { start: 6_000, end: 7_000 }])).toBe(6_000);
        // A steered turn: windows from both requests, in any order.
        expect(generationTimeMs(0, 20_000, [{ start: 12_000, end: 15_000 }, { start: 2_000, end: 8_000 }])).toBe(11_000);
        // An approval wait inside a tool's span counts once.
        expect(generationTimeMs(0, 10_000, [{ start: 1_000, end: 6_000 }, { start: 2_000, end: 3_000 }, { start: 5_000, end: 8_000 }])).toBe(3_000);
        // Cancelled mid-tool: the open window ends with the round; spans
        // outside the round do not count.
        expect(generationTimeMs(1_000, 5_000, [{ start: 0, end: 2_000 }, { start: 3_000, end: null }])).toBe(1_000);
        // No answer, or nothing left but tools.
        expect(generationTimeMs(0, null, [])).toBeNull();
        expect(generationTimeMs(null, 5_000, [])).toBeNull();
        expect(generationTimeMs(0, 5_000, [{ start: 0, end: 5_000 }])).toBe(0);
    });

    it('reports generation tokens, thinking included, only with a positive generation time', () => {
        const usage = { type: 'usage' as const, inputTokens: 100, outputTokens: 40, thoughtTokens: 20 };
        expect(agyRoundSummary(usage, 9_000, null, 3_000.4).summary).toMatchObject({
            generation_ms: 3_000,
            generation_output_tokens: 60
        });
        for (const generationMs of [null, 0, -5]) {
            const summary = agyRoundSummary(usage, 9_000, null, generationMs).summary;
            expect(summary).not.toHaveProperty('generation_ms');
            expect(summary).not.toHaveProperty('generation_output_tokens');
        }
        expect(agyRoundSummary({ ...usage, outputTokens: 0, thoughtTokens: 0 }, 9_000, null, 3_000).summary)
            .not.toHaveProperty('generation_ms');
    });

    it('totals usage across the requests of one turn', () => {
        const first = { type: 'usage' as const, inputTokens: 10, outputTokens: 1, thoughtTokens: 2 };
        const second = { type: 'usage' as const, inputTokens: 20, outputTokens: 3, cacheReadTokens: 4 };
        expect(addAgyUsage(null, first)).toBe(first);
        expect(addAgyUsage(first, second)).toEqual({
            type: 'usage',
            inputTokens: 30,
            outputTokens: 4,
            totalTokens: undefined,
            thoughtTokens: 2,
            cacheReadTokens: 4,
            cacheCreationTokens: undefined
        });
    });
});

describe('AgyAcpRemoteLauncher steer state matrix', () => {
    type Handlers = Map<string, (payload?: unknown) => Promise<unknown>>;
    const rpc = (client: ReturnType<typeof makeClient>, method: string) =>
        (client.rpcHandlerManager.handlers as Handlers).get(method)!;
    const lost = () => {
        const error = new Error('ACP transport closed');
        Object.defineProperty(error, ACP_INDETERMINATE_SYMBOL, { value: true });
        return error;
    };
    const consumedSteer = (client: ReturnType<typeof makeClient>, localId: string) =>
        client.emitMessagesConsumed.mock.calls.some(([ids, opts]) =>
            (ids as string[])[0] === localId && (opts as { steered?: boolean } | undefined)?.steered === true);

    async function heldTurn(backend: FakeAgyBackend, prompt = 'run the tests') {
        const { session, queue, client } = makeSession();
        let release!: () => void;
        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({ type: 'tool_call', id: 't1', name: 'run_command', input: {}, status: 'in_progress' });
            await new Promise<void>((resolve) => { release = resolve; });
        });
        queue.push(prompt, REVIEW, 'first');
        const { run, created } = launch(session, [backend]);
        await vi.waitFor(() => expect(backend.prompts).toHaveLength(1));
        return { session, queue, client, run, created, release: () => release() };
    }

    it('refuses to steer a control command and keeps it queued', async () => {
        const backend = new FakeAgyBackend();
        const { queue, client, run, release } = await heldTurn(backend);
        queue.pushIsolated('/compact', REVIEW, 'control');
        expect(await rpc(client, RPC_METHODS.SteerQueuedMessage)({ localId: 'control' }))
            .toEqual({ steered: false, error: 'Control commands cannot be steered' });
        expect(backend.steerPrompts).toEqual([]);
        expect(queue.size()).toBe(1);
        release();
        queue.close();
        await run;
    });

    it('refuses to steer a message that is no longer queued', async () => {
        const backend = new FakeAgyBackend();
        const { queue, client, run, release } = await heldTurn(backend);
        expect(await rpc(client, RPC_METHODS.SteerQueuedMessage)({ localId: 'gone' }))
            .toEqual({ steered: false, error: 'Message not in queue' });
        expect(backend.steerPrompts).toEqual([]);
        release();
        queue.close();
        await run;
    });

    it('holds a steer whose delivery state the hub could not record, without sending it', async () => {
        const backend = new FakeAgyBackend();
        const { queue, client, run, release } = await heldTurn(backend);
        client.setSteerDeliveryState.mockResolvedValueOnce(false);
        queue.push('also lint', REVIEW, 'steer-1');
        expect(await rpc(client, RPC_METHODS.SteerQueuedMessage)({ localId: 'steer-1' }))
            .toEqual({ steered: false, error: 'Steer state is indeterminate' });
        expect(backend.steerPrompts).toEqual([]);
        expect(client.emitSteerIndeterminate).toHaveBeenCalledWith(['steer-1']);
        release();
        queue.close();
        await run;
    });

    it.each([
        ['starting the request', 'start'],
        ['writing the request', 'dispatch']
    ])('holds a steer when agy is lost while %s', async (_label, stage) => {
        const backend = new FakeAgyBackend();
        const { queue, client, run, release } = await heldTurn(backend);
        if (stage === 'start') backend.steerStartError = lost();
        else backend.steerDispatchError = lost();
        queue.push('also lint', REVIEW, 'steer-1');
        expect(await rpc(client, RPC_METHODS.SteerQueuedMessage)({ localId: 'steer-1' }))
            .toEqual({ steered: false, error: 'Steer outcome is being reconciled' });
        expect(client.emitSteerIndeterminate).toHaveBeenCalledWith(['steer-1']);
        expect(consumedSteer(client, 'steer-1')).toBe(false);
        expect(queue.size()).toBe(0);
        release();
        queue.close();
        await run;
    });

    it('keeps a steer queued that arrives while agy restarts', async () => {
        const { session, queue, client } = makeSession();
        const first = new FakeAgyBackend();
        const second = new FakeAgyBackend();
        let started!: () => void;
        const { run } = launch(session, [first, second]);
        queue.push('one', REVIEW, 'a');
        await vi.waitFor(() => expect(sessionEvents(client)).toContainEqual({ type: 'ready' }));
        first.alive = false;
        second.initializeGate = new Promise((resolve) => { started = resolve; });
        queue.push('two', REVIEW, 'b');
        await vi.waitFor(() => expect(second.calls).toEqual(['initialize']));

        queue.push('also lint', REVIEW, 'steer-1');
        const result = await rpc(client, RPC_METHODS.SteerQueuedMessage)({ localId: 'steer-1' }) as { steered: boolean };
        expect(result.steered).toBe(false);
        expect(second.steerPrompts).toEqual([]);
        expect(queue.size()).toBe(1);

        started();
        await vi.waitFor(() => expect(second.prompts).toEqual([
            [{ type: 'text', text: 'two' }],
            [{ type: 'text', text: 'also lint' }]
        ]));
        queue.close();
        await run;
    });

    it('confirms two steers that agy echoes in one chunk', async () => {
        const backend = new FakeAgyBackend();
        const { queue, client, run, release } = await heldTurn(backend);
        queue.push('lint', REVIEW, 'short');
        queue.push('fix the types', REVIEW, 'other');
        expect(await rpc(client, RPC_METHODS.SteerQueuedMessage)({ localId: 'short' })).toEqual({ steered: true });
        expect(await rpc(client, RPC_METHODS.SteerQueuedMessage)({ localId: 'other' })).toEqual({ steered: true });
        backend.echo!('run the tests');
        backend.echo!('lint\nfix the types');
        expect(consumedSteer(client, 'short')).toBe(true);
        expect(consumedSteer(client, 'other')).toBe(true);

        // Stop afterwards does not undo either.
        backend.onCancel = () => {
            release();
            for (const steer of backend.steerCompletions) steer.resolve('cancelled');
        };
        await rpc(client, RPC_METHODS.Abort)();
        await vi.waitFor(() => expect(sessionEvents(client)).toContainEqual({ type: 'ready' }));
        expect(client.emitSteerIndeterminate).not.toHaveBeenCalled();
        queue.close();
        await run;
    });

    it('does not let a late echo from the previous turn expose the next prompt to a steer match', async () => {
        const backend = new FakeAgyBackend();
        const { session, queue, client } = makeSession();
        let release!: () => void;
        backend.promptScripts.push(async () => {});
        backend.promptScripts.push(async () => {
            await new Promise<void>((resolve) => { release = resolve; });
        });
        queue.push('first task', REVIEW, 'a');
        const { run } = launch(session, [backend]);
        await vi.waitFor(() => expect(sessionEvents(client)).toContainEqual({ type: 'ready' }));

        queue.push('run the tests and then lint', REVIEW, 'b');
        await vi.waitFor(() => expect(backend.prompts).toHaveLength(2));
        // A stray echo from the previous turn arrives first.
        backend.echo!('an earlier steer');
        queue.push('lint', REVIEW, 'steer-1');
        expect(await rpc(client, RPC_METHODS.SteerQueuedMessage)({ localId: 'steer-1' })).toEqual({ steered: true });
        backend.echo!('run the tests and then lint');
        expect(consumedSteer(client, 'steer-1')).toBe(false);

        backend.echo!('lint');
        expect(consumedSteer(client, 'steer-1')).toBe(true);
        release();
        backend.steerCompletions[0]!.resolve('end_turn');
        queue.close();
        await run;
    });

    it('keeps an early-answered steer confirmed once echoed, even after a Stop', async () => {
        const backend = new FakeAgyBackend();
        const { queue, client, run, release } = await heldTurn(backend);
        queue.push('also lint', REVIEW, 'steer-1');
        queue.push('and format', REVIEW, 'steer-2');
        expect(await rpc(client, RPC_METHODS.SteerQueuedMessage)({ localId: 'steer-1' })).toEqual({ steered: true });
        expect(await rpc(client, RPC_METHODS.SteerQueuedMessage)({ localId: 'steer-2' })).toEqual({ steered: true });
        backend.steerCompletions[0]!.resolve('end_turn');
        backend.echo!('run the tests');
        backend.echo!('also lint');
        backend.onCancel = () => {
            release();
            backend.steerCompletions[1]!.resolve('cancelled');
        };
        await rpc(client, RPC_METHODS.Abort)();
        await vi.waitFor(() => expect(sessionEvents(client)).toContainEqual({ type: 'ready' }));
        expect(consumedSteer(client, 'steer-1')).toBe(true);
        expect(client.emitSteerIndeterminate).not.toHaveBeenCalledWith(['steer-1']);
        expect(client.emitSteerIndeterminate).toHaveBeenCalledWith(['steer-2']);
        queue.close();
        await run;
    });

    it('keeps a steer that agy rejects after a Stop queued', async () => {
        const backend = new FakeAgyBackend();
        const { queue, client, run, release } = await heldTurn(backend);
        queue.push('also lint', REVIEW, 'steer-1');
        expect(await rpc(client, RPC_METHODS.SteerQueuedMessage)({ localId: 'steer-1' })).toEqual({ steered: true });
        backend.onCancel = () => {
            release();
            backend.steerCompletions[0]!.reject(Object.assign(new Error('Invalid params'), { code: -32602 }));
        };
        await rpc(client, RPC_METHODS.Abort)();
        // Back in the queue, it runs as the next turn.
        await vi.waitFor(() => expect(backend.prompts).toEqual([
            [{ type: 'text', text: 'run the tests' }],
            [{ type: 'text', text: 'also lint' }]
        ]));
        expect(consumedSteer(client, 'steer-1')).toBe(false);
        expect(client.emitSteerIndeterminate).not.toHaveBeenCalled();
        queue.close();
        await run;
    });

    it('keeps the main prompt when Stop leaves a steer agy may have taken', async () => {
        const backend = new FakeAgyBackend();
        const { session, queue, client } = makeSession();
        let cancelled!: () => void;
        backend.promptScripts.push(async (onUpdate) => {
            await new Promise<void>((resolve) => { cancelled = resolve; });
            onUpdate({ type: 'turn_complete', stopReason: 'cancelled' });
        });
        queue.push('build it', REVIEW, 'first');
        const { run } = launch(session, [backend]);
        await vi.waitFor(() => expect(backend.prompts).toHaveLength(1));
        queue.push('also lint', REVIEW, 'steer-1');
        expect(await rpc(client, RPC_METHODS.SteerQueuedMessage)({ localId: 'steer-1' })).toEqual({ steered: true });
        backend.onCancel = () => {
            cancelled();
            backend.steerCompletions[0]!.resolve('cancelled');
        };
        await rpc(client, RPC_METHODS.Abort)();
        await vi.waitFor(() => expect(sessionEvents(client)).toContainEqual({ type: 'ready' }));
        // agy may have folded the steer into the main prompt, so neither goes
        // back to the composer: the steer is held, the prompt stays delivered.
        expect(sessionEvents(client)).not.toContainEqual({ type: 'abort-restore', text: 'build it' });
        expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['first']);
        expect(client.emitSteerIndeterminate).toHaveBeenCalledWith(['steer-1']);
        queue.close();
        await run;
    });

    it('holds an open steer when agy ignores the cancel and is restarted', async () => {
        const backend = new FakeAgyBackend();
        const { session, queue, client } = makeSession();
        backend.promptScripts.push(async () => {
            await new Promise<void>((_resolve, reject) => {
                backend.onDisconnect = () => reject(lost());
            });
        });
        queue.push('stuck', REVIEW, 'first');
        const { run } = launch(session, [backend], { cancelHardStopMs: 80 });
        await vi.waitFor(() => expect(backend.prompts).toHaveLength(1));
        queue.push('also lint', REVIEW, 'steer-1');
        expect(await rpc(client, RPC_METHODS.SteerQueuedMessage)({ localId: 'steer-1' })).toEqual({ steered: true });
        backend.steerCompletions[0]!.answer();

        await rpc(client, RPC_METHODS.Abort)();
        await vi.waitFor(() => expect(sessionEvents(client)).toContainEqual({ type: 'ready' }));
        expect(client.emitSteerIndeterminate).toHaveBeenCalledWith(['steer-1']);
        expect(consumedSteer(client, 'steer-1')).toBe(false);
        queue.close();
        await run;
    });

    it.each([
        ['still waiting to send', 'waiting'],
        ['draining its cancelled answer', 'draining']
    ])('puts a prompt back before the session ends when it is killed while %s', async (_label, stage) => {
        const { session, queue, client } = makeSession();
        const backend = new FakeAgyBackend();
        if (stage === 'waiting') {
            backend.preSendDelayMs = 150;
        } else {
            backend.promptScripts.push(async () => {
                await new Promise<void>((resolve) => { backend.onDisconnect = resolve; });
                // HAPI still drains late output before the request fails.
                await new Promise((resolve) => setTimeout(resolve, 150));
                const error = new Error('ACP transport closed');
                Object.defineProperty(error, ACP_INDETERMINATE_SYMBOL, { value: true });
                throw error;
            });
        }
        queue.push('build it', REVIEW, 'first');
        const { run } = launch(session, [backend]);
        if (stage === 'waiting') await vi.waitFor(() => expect(session.thinking).toBe(true));
        else await vi.waitFor(() => expect(backend.prompts).toHaveLength(1));

        await session.kill();
        // The runner ends the session and closes the client right after kill().
        const eventsAtKill = sessionEvents(client).length;
        const consumedAtKill = client.emitMessagesConsumed.mock.calls.length;
        expect(sessionEvents(client)).toContainEqual({ type: 'abort-restore', text: 'build it' });
        expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['first']);

        queue.close();
        await run;
        expect(sessionEvents(client)).toHaveLength(eventsAtKill);
        expect(client.emitMessagesConsumed.mock.calls).toHaveLength(consumedAtKill);
    });

    it('does not let an agy that never settles hold the session end forever', async () => {
        const { session, queue } = makeSession();
        const backend = new FakeAgyBackend();
        backend.promptScripts.push(() => new Promise<void>(() => {}));
        queue.push('build it', REVIEW, 'first');
        launch(session, [backend], { killSettleMs: 50 });
        await vi.waitFor(() => expect(backend.prompts).toHaveLength(1));

        const startedAt = Date.now();
        await session.kill();
        expect(Date.now() - startedAt).toBeLessThan(1_000);
        expect(backend.disconnected).toBe(true);
    });

    it('holds an open steer when the session is killed mid-turn', async () => {
        const backend = new FakeAgyBackend();
        const { session, queue, client, run, release } = await heldTurn(backend);
        queue.push('also lint', REVIEW, 'steer-1');
        expect(await rpc(client, RPC_METHODS.SteerQueuedMessage)({ localId: 'steer-1' })).toEqual({ steered: true });
        backend.onCancel = () => release();
        backend.onDisconnect = () => backend.steerCompletions[0]!.reject(lost());

        await session.kill();
        // Settled before kill() returns, since the runner ends the session then.
        expect(client.emitSteerIndeterminate).toHaveBeenCalledWith(['steer-1']);
        expect(consumedSteer(client, 'steer-1')).toBe(false);
        queue.close();
        await run;
    });
});

describe('AgyAcpRemoteLauncher questions (agy ask_question)', () => {
    type Handlers = Map<string, (payload?: unknown) => Promise<unknown>>;
    // Recorded from agy 1.5.3 with form elicitation advertised.
    const questionCall = {
        type: 'tool_call' as const, id: 'call_q', name: 'Run ask_question', kind: 'other', status: 'pending' as const, title: 'Run ask_question',
        input: { questions: [{ is_multi_select: false, options: ['(Recommended) RED', 'BLUE'], question: 'Do you prefer RED or BLUE?' }] }
    };
    const elicitation = {
        sessionId: 'agy-conv-new', toolCallId: 'call_q', mode: 'form', message: 'The agent has a question.',
        requestedSchema: { type: 'object', properties: {
            q1: { type: 'string', title: 'Do you prefer RED or BLUE?', oneOf: [{ const: '1', title: '(Recommended) RED' }, { const: '2', title: 'BLUE' }] },
            q1_other: { type: 'string', title: 'Other', description: 'Optional free-form answer to: Do you prefer RED or BLUE?' }
        } }
    };
    const card = {
        questions: [{
            question: 'Do you prefer RED or BLUE?', header: null, multiSelect: false,
            options: [{ label: '(Recommended) RED', description: null }, { label: 'BLUE', description: null }]
        }]
    };

    async function askedTurn(permissionMode: AgyMode['permissionMode'] = 'request-review') {
        const { session, queue, client } = makeSession();
        const backend = new FakeAgyBackend();
        let answer!: Promise<unknown>;
        let finish!: () => void;
        backend.promptScripts.push(async (onUpdate) => {
            onUpdate(questionCall);
            answer = backend.elicit(elicitation);
            await new Promise<void>((resolve) => { finish = resolve; });
        });
        queue.push('ask me', { permissionMode }, 'first');
        const { run } = launch(session, [backend]);
        await vi.waitFor(() => expect(Object.keys(agentState(client).requests ?? {})).toEqual(['call_q']));
        const rpc = (method: string) => (client.rpcHandlerManager.handlers as Handlers).get(method)!;
        return { session, queue, client, backend, run, rpc, answer: () => answer, finish: () => finish() };
    }

    it('shows agy\'s question as the question card on its own tool call', async () => {
        const { queue, client, run, finish } = await askedTurn();
        expect(agentState(client).requests).toMatchObject({ call_q: { tool: 'AskUserQuestion', arguments: card } });
        expect(client.sendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'tool-call', callId: 'call_q', name: 'AskUserQuestion', input: card
        }));
        finish();
        queue.close();
        await run;
    });

    it('answers agy with the chosen option only', async () => {
        const { queue, run, rpc, answer, finish } = await askedTurn();
        await rpc(RPC_METHODS.Permission)({ id: 'call_q', approved: true, answers: { '0': ['BLUE'] } });
        await expect(answer()).resolves.toEqual({ action: 'accept', content: { q1: '2' } });
        finish();
        queue.close();
        await run;
    });

    it('declines when the user denies the question', async () => {
        const { queue, run, rpc, answer, finish } = await askedTurn();
        await rpc(RPC_METHODS.Permission)({ id: 'call_q', approved: false, decision: 'denied' });
        await expect(answer()).resolves.toEqual({ action: 'decline' });
        finish();
        queue.close();
        await run;
    });

    it.each(['always-proceed', 'acceptEdits', 'plan'] as const)('waits for the user even in %s', async (mode) => {
        const { queue, run, answer, finish } = await askedTurn(mode);
        let settled = false;
        void answer().then(() => { settled = true; });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(settled).toBe(false);
        finish();
        queue.close();
        await run;
    });

    it('refuses a steer while the question is open', async () => {
        const { queue, run, rpc, finish } = await askedTurn();
        queue.push('also lint', REVIEW, 'steer-1');
        expect(await rpc(RPC_METHODS.SteerQueuedMessage)({ localId: 'steer-1' })).toEqual({
            steered: false,
            error: 'Antigravity is waiting for your approval or answer; respond to it, then steer'
        });
        expect(queue.size()).toBe(1);
        finish();
        queue.close();
        await run;
    });

    it('cancels the question on Stop', async () => {
        const { queue, run, rpc, answer, backend, finish } = await askedTurn();
        backend.onCancel = () => finish();
        await rpc(RPC_METHODS.Abort)();
        await expect(answer()).resolves.toEqual({ action: 'cancel' });
        queue.close();
        await run;
    });

    it('cancels the question when the session ends', async () => {
        const { session, queue, client, run, answer, backend, finish } = await askedTurn();
        backend.onDisconnect = () => finish();
        await session.kill();
        await expect(answer()).resolves.toEqual({ action: 'cancel' });
        // A question the stopped process still sends is not shown.
        await expect(backend.elicit({ ...elicitation, toolCallId: 'call_late' })).resolves.toEqual({ action: 'cancel' });
        expect(agentState(client).requests ?? {}).toEqual({});
        queue.close();
        await run;
    });

    it('declines rather than sending an empty answer when an approval carries none', async () => {
        const { queue, run, rpc, answer, finish } = await askedTurn();
        await rpc(RPC_METHODS.Permission)({ id: 'call_q', approved: true });
        await expect(answer()).resolves.toEqual({ action: 'decline' });
        finish();
        queue.close();
        await run;
    });

    it('asks under a fresh id when agy\'s tool call id is already waiting for the user', async () => {
        const { client, queue, run, rpc, backend, answer, finish } = await askedTurn();
        const second = backend.elicit(elicitation);
        await vi.waitFor(() => expect(Object.keys(agentState(client).requests ?? {})).toHaveLength(2));
        const freshId = Object.keys(agentState(client).requests ?? {}).find((id) => id !== 'call_q')!;
        await rpc(RPC_METHODS.Permission)({ id: freshId, approved: true, answers: { '0': ['BLUE'] } });
        await expect(second).resolves.toEqual({ action: 'accept', content: { q1: '2' } });
        await rpc(RPC_METHODS.Permission)({ id: 'call_q', approved: true, answers: { '0': ['(Recommended) RED'] } });
        await expect(answer()).resolves.toEqual({ action: 'accept', content: { q1: '1' } });
        finish();
        queue.close();
        await run;
    });

    it('asks under a fresh id when agy\'s tool call id was already answered', async () => {
        const { client, queue, run, rpc, backend, answer, finish } = await askedTurn();
        await rpc(RPC_METHODS.Permission)({ id: 'call_q', approved: true, answers: { '0': ['BLUE'] } });
        await expect(answer()).resolves.toEqual({ action: 'accept', content: { q1: '2' } });

        const again = backend.elicit(elicitation);
        await vi.waitFor(() => expect(Object.keys(agentState(client).requests ?? {})).toHaveLength(1));
        const id = Object.keys(agentState(client).requests ?? {})[0]!;
        // Clients hide a pending request whose id is already completed.
        expect(id).not.toBe('call_q');
        await rpc(RPC_METHODS.Permission)({ id, approved: true, answers: { '0': ['(Recommended) RED'] } });
        await expect(again).resolves.toEqual({ action: 'accept', content: { q1: '1' } });
        finish();
        queue.close();
        await run;
    });

    it('cancels a question that arrives after Stop', async () => {
        const { queue, run, rpc, answer, backend, finish } = await askedTurn();
        backend.onCancel = () => {};
        await rpc(RPC_METHODS.Abort)();
        await expect(answer()).resolves.toEqual({ action: 'cancel' });
        // At once, not when agy is restarted after the hard-stop timeout.
        const late = backend.elicit({ ...elicitation, toolCallId: 'call_late' });
        await expect(Promise.race([late, new Promise((resolve) => setTimeout(() => resolve('still open'), 200))]))
            .resolves.toEqual({ action: 'cancel' });
        finish();
        queue.close();
        await run;
    });

    it('cancels a question that arrives after the stopped turn has finished', async () => {
        const { client, queue, run, rpc, answer, backend, finish } = await askedTurn();
        backend.onCancel = () => finish();
        await rpc(RPC_METHODS.Abort)();
        await expect(answer()).resolves.toEqual({ action: 'cancel' });
        await new Promise((resolve) => setTimeout(resolve, 100));
        const late = backend.elicit({ ...elicitation, toolCallId: 'call_late2' });
        await expect(Promise.race([late, new Promise((resolve) => setTimeout(() => resolve('still open'), 300))]))
            .resolves.toEqual({ action: 'cancel' });
        expect(Object.keys(agentState(client).requests ?? {})).not.toContain('call_late2');
        queue.close();
        await run;
    });

    it('cancels a form that is not a question', async () => {
        const { queue, run, backend, finish } = await askedTurn();
        await expect(backend.elicit({
            sessionId: 'agy-conv-new', message: 'Sign in', requestedSchema: { type: 'object', properties: { name: { type: 'string' } } }
        })).resolves.toEqual({ action: 'cancel' });
        finish();
        queue.close();
        await run;
    });
});

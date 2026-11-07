import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentMessage, PermissionRequest, PromptContent } from '@/agent/types';
import type { AcpSdkBackend } from '@/agent/backends/acp';
import { ACP_INDETERMINATE_SYMBOL } from '@/agent/backends/acp/AcpStdioTransport';
import { AgySession } from './session';
import type { AgyMode } from './types';
import {
    AgyAcpRemoteLauncher,
    addAgyUsage,
    agyAcpModeForPermission,
    resolveAgyAcpModelId
} from './agyAcpRemoteLauncher';

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

    async initialize(): Promise<void> {
        this.calls.push('initialize');
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
    async prompt(_sessionId: string, content: PromptContent[], onUpdate: (message: AgentMessage) => void): Promise<void> {
        if (this.preSendDelayMs) await new Promise((resolve) => setTimeout(resolve, this.preSendDelayMs));
        this.prompts.push(content);
        this.promptInFlight = true;
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
    steerCompletions: Array<{ resolve: (stopReason: string | null) => void; reject: (error: unknown) => void; onUsage?: (usage: Extract<AgentMessage, { type: 'usage' }>) => void }> = [];
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
        this.steerCompletions.push({ resolve, reject, onUsage: options?.onUsage });
        const dispatched = this.steerDispatchError ? Promise.reject(this.steerDispatchError) : Promise.resolve();
        void dispatched.catch(() => {});
        return { dispatched, completed };
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

function launch(session: AgySession, backends: FakeAgyBackend[]) {
    const created: FakeAgyBackend[] = [];
    const launcher = new AgyAcpRemoteLauncher(session, {
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

function sessionEvents(client: ReturnType<typeof makeClient>): unknown[] {
    return client.sendSessionEvent.mock.calls.map(([event]) => event);
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
        expect(metadata).toMatchObject({ agySessionId: 'agy-conv-new', agyProtocol: 'acp' });
        expect(backend.prompts).toEqual([[{ type: 'text', text: 'hello' }]]);
        expect(client.sendAgentMessage).toHaveBeenCalledWith({ type: 'message', message: 'answer' });
        expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['local-1']);
        expect(sessionEvents(client)).toContainEqual({ type: 'ready' });
        expect(backend.disconnected).toBe(true);
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
        expect(sent.map((message) => message.type)).toEqual(['message', 'token_count']);
        expect(sent[1]).toMatchObject({
            type: 'token_count',
            model: 'gemini-4-argon-medium',
            info: { total: { inputTokens: 160, outputTokens: 7, totalTokens: 157, cachedInputTokens: 10 } }
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

    it('confirms delivery only once agy takes the prompt', async () => {
        const { session, queue, client } = makeSession();
        const backend = new FakeAgyBackend();
        let openGate!: () => void;
        backend.setModelGate = new Promise((resolve) => { openGate = resolve; });
        backend.promptScripts.push(async (onUpdate) => {
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
            cacheCreationTokens: undefined,
            contextTokens: 24,
            contextWindow: undefined
        });
        expect(addAgyUsage(first, { ...second, contextTokens: 50, contextWindow: 1000 }))
            .toMatchObject({ contextTokens: 50, contextWindow: 1000 });
    });
});

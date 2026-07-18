import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import type { AgentMessage, AgentSessionConfig, PromptContent } from '@/agent/types';
import type { GrokMode } from './types';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

const harness = vi.hoisted(() => ({
    connected: true,
    terminalHandler: null as ((error: Error) => void) | null,
    prompt: null as ReturnType<typeof deferred<unknown>> | null,
    promptCalls: [] as Array<{ sessionId: string; content: PromptContent[] }>,
    disconnectCalls: 0
}));

const createGrokBackendMock = vi.hoisted(() => vi.fn());

vi.mock('@/codex/utils/buildHapiMcpBridge', () => ({
    buildHapiMcpBridge: async () => ({ server: { stop: () => {} }, mcpServers: {} })
}));

vi.mock('./utils/grokBackend', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./utils/grokBackend')>();
    return { ...actual, createGrokBackend: createGrokBackendMock };
});

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn(), warn: vi.fn() }
}));

function createBackendStub() {
    return {
        onTerminalError(handler: (error: Error) => void) {
            harness.terminalHandler = handler;
        },
        onStderrError: vi.fn(),
        onUnknownExtension: vi.fn(),
        onConfigChanged: vi.fn(),
        onCapabilitiesChanged: vi.fn(),
        onStatus: vi.fn(),
        onPermissionRequest: vi.fn(),
        onAskUserQuestion: vi.fn(),
        onPlanApproval: vi.fn(),
        initialize: vi.fn(async () => {}),
        newSession: vi.fn(async (_config: AgentSessionConfig) => 'grok-session-1'),
        resumeSession: vi.fn(async (sessionId: string) => ({ sessionId })),
        getCapabilities: vi.fn(() => null),
        requestExtension: vi.fn(async () => null),
        setSessionConfig: vi.fn(async () => ({})),
        prompt: vi.fn(async (sessionId: string, content: PromptContent[], _onUpdate: (message: AgentMessage) => void) => {
            harness.promptCalls.push({ sessionId, content });
            return harness.prompt!.promise;
        }),
        isConnected: vi.fn(() => harness.connected),
        cancelPrompt: vi.fn(async () => {}),
        respondToPermission: vi.fn(async () => {}),
        disconnect: vi.fn(async () => { harness.disconnectCalls += 1; })
    };
}

function createSessionStub() {
    const queue = new MessageQueue2<GrokMode>((mode) => JSON.stringify(mode));
    queue.push('hello Grok', { permissionMode: 'default', model: null, effort: null });
    queue.close();
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    const rpcHandlers = new Map<string, () => Promise<void> | void>();
    let agentState: any = { controlledByUser: false, requests: {}, completedRequests: {} };
    let metadata: Record<string, unknown> = {};
    const client = {
        rpcHandlerManager: {
            registerHandler(method: string, handler: () => Promise<void> | void) {
                rpcHandlers.set(method, handler);
            }
        },
        updateMetadata(handler: (value: Record<string, unknown>) => Record<string, unknown>) {
            metadata = handler(metadata);
        },
        updateAgentState(handler: (value: any) => any) {
            agentState = handler(agentState);
        },
        sendAgentMessage: vi.fn(),
        sendUserMessage: vi.fn(),
        sendSessionEvent(event: { type: string; [key: string]: unknown }) {
            events.push(event);
        }
    };
    const session = {
        path: '/tmp/hapi-grok-lifecycle-test',
        logPath: '/tmp/hapi-grok-lifecycle-test/test.log',
        client,
        queue,
        sessionId: null as string | null,
        getPermissionMode: () => 'default',
        getModel: () => null,
        getEffort: () => null,
        onSessionFound: vi.fn(async (sessionId: string) => { session.sessionId = sessionId; }),
        setRuntimeConfigHandler: vi.fn(),
        setRuntime: vi.fn(),
        onThinkingChange: vi.fn(),
        sendAgentMessage: client.sendAgentMessage,
        sendUserMessage: client.sendUserMessage,
        sendSessionEvent: client.sendSessionEvent
    };
    return { session, queue, events, rpcHandlers };
}

describe('GrokRemoteLauncher terminal lifecycle', () => {
    afterEach(() => {
        harness.connected = true;
        harness.terminalHandler = null;
        harness.prompt = null;
        harness.promptCalls = [];
        harness.disconnectCalls = 0;
        createGrokBackendMock.mockReset();
        vi.restoreAllMocks();
    });

    it('terminalizes an unexpected ACP exit and never advertises the dead session as ready', async () => {
        harness.prompt = deferred<unknown>();
        const backend = createBackendStub();
        createGrokBackendMock.mockReturnValue(backend);
        const { session, events } = createSessionStub();
        const { grokRemoteLauncher } = await import('./grokRemoteLauncher');
        const launch = grokRemoteLauncher(session as never);

        await vi.waitFor(() => expect(backend.prompt).toHaveBeenCalledTimes(1));
        expect(harness.terminalHandler).toBeTypeOf('function');
        const terminalError = new Error('ACP process exited (code=23, signal=null)');
        harness.connected = false;
        harness.terminalHandler!(terminalError);
        harness.prompt.reject(terminalError);

        await expect(launch).resolves.toBe('exit');
        expect(events.some((event) => event.type === 'ready')).toBe(false);
        expect(events).toContainEqual(expect.objectContaining({
            type: 'message',
            message: expect.stringContaining('ACP process exited')
        }));
        expect(harness.disconnectCalls).toBe(1);
    });

    it('suppresses ready and completes RPC abort cleanup while force-close is still settling', async () => {
        harness.prompt = deferred<unknown>();
        const closeGate = deferred<void>();
        const backend = createBackendStub();
        createGrokBackendMock.mockReturnValue(backend);
        const { session, queue, events, rpcHandlers } = createSessionStub();
        const resetQueue = vi.spyOn(queue, 'reset');
        const { GrokCancelTimeoutError } = await import('./utils/grokBackend');
        backend.cancelPrompt.mockImplementation(async () => {
            const terminalError = new Error('ACP transport closed by timeout');
            harness.terminalHandler?.(terminalError);
            harness.prompt!.reject(terminalError);
            await closeGate.promise;
            harness.connected = false;
            throw new GrokCancelTimeoutError(10);
        });
        const { grokRemoteLauncher } = await import('./grokRemoteLauncher');
        const launch = grokRemoteLauncher(session as never);

        await vi.waitFor(() => expect(backend.prompt).toHaveBeenCalledTimes(1));
        const abortHandler = rpcHandlers.get('abort');
        expect(abortHandler).toBeTypeOf('function');
        const abort = Promise.resolve(abortHandler!());
        await vi.waitFor(() => expect(events.some((event) => event.type === 'turn-duration')).toBe(true));

        expect(events.some((event) => event.type === 'ready')).toBe(false);
        closeGate.resolve();
        await expect(abort).resolves.toBeUndefined();
        await expect(launch).resolves.toBe('exit');
        expect(resetQueue).toHaveBeenCalledTimes(1);
        expect(session.onThinkingChange).toHaveBeenLastCalledWith(false);
        expect(events.filter((event) => (
            event.type === 'message' && String(event.message).includes('transport')
        ))).toHaveLength(1);
    });

    it('wakes an idle queue wait on terminal transport failure without sending another prompt', async () => {
        const backend = createBackendStub();
        createGrokBackendMock.mockReturnValue(backend);
        const { session, queue } = createSessionStub();
        queue.reset();
        const { grokRemoteLauncher } = await import('./grokRemoteLauncher');
        const launch = grokRemoteLauncher(session as never);

        await vi.waitFor(() => expect(backend.setSessionConfig).toHaveBeenCalledTimes(1));
        expect(backend.prompt).not.toHaveBeenCalled();
        const terminalError = new Error('ACP process exited while idle');
        harness.connected = false;
        harness.terminalHandler!(terminalError);
        queue.push('must not reach Grok', { permissionMode: 'default', model: null, effort: null });

        await expect(launch).resolves.toBe('exit');
        expect(backend.prompt).not.toHaveBeenCalled();
    });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import type { AgyMode, PermissionMode } from './types';
import type { AgentMessage, AgentSessionConfig, PermissionRequest, PermissionResponse, PromptContent } from '@/agent/types';

type PromptRuntimeOptions = { model?: string; permissionMode?: string };

const BROWSER_OAUTH_TIMEOUT = [
    'Authentication required. Please visit the URL to log in:',
    'https://accounts.google.com/o/oauth2/auth?secret=do-not-leak',
    'Error: authentication failed or timed out'
].join('\n');

const harness = vi.hoisted(() => ({
    nowMs: 1_700_000_000_000,
    promptDurationMs: 0,
    promptErrors: [] as string[],
    lastNativeConversationId: null as string | null,
    promptCalls: [] as Array<{ sessionId: string; content: PromptContent[]; runtimeOptions?: PromptRuntimeOptions }>,
    metadata: { path: '/tmp/hapi-agy-test', host: 'test-host' } as Record<string, unknown>,
    metadataUpdates: [] as Array<Record<string, unknown>>,
    summaryMessages: [] as unknown[],
    newSessionCalls: [] as AgentSessionConfig[],
    loadSessionCalls: [] as Array<AgentSessionConfig & { sessionId: string }>,
    disconnectCalls: 0,
    stderrHandler: null as ((error: Error) => void) | null,
    permissionHandler: null as ((request: PermissionRequest) => void) | null
}));

const createAgyBackendMock = vi.hoisted(() => vi.fn());
const resolveAgyRuntimeConfigMock = vi.hoisted(() => vi.fn());


vi.mock('./utils/config', () => ({
    resolveAgyRuntimeConfig: resolveAgyRuntimeConfigMock
}));

vi.mock('./utils/agyBackend', () => ({
    createAgyBackend: createAgyBackendMock,
    isNativeAgyConversationId: vi.fn((id) => typeof id === 'string' && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id))
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        warn: vi.fn()
    }
}));

function createBackendStub() {
    return {
        onStderrError(handler: (error: Error) => void) {
            harness.stderrHandler = handler;
        },
        onPermissionRequest(handler: (request: PermissionRequest) => void) {
            harness.permissionHandler = handler;
        },
        initialize: vi.fn(async () => {}),
        newSession: vi.fn(async (config: AgentSessionConfig) => {
            harness.newSessionCalls.push(config);
            return 'agy-session-1';
        }),
        loadSession: vi.fn(async (config: AgentSessionConfig & { sessionId: string }) => {
            harness.loadSessionCalls.push(config);
            return config.sessionId;
        }),
        getLastNativeConversationId: vi.fn(() => harness.lastNativeConversationId),
        prompt: vi.fn(async (sessionId: string, content: PromptContent[], onUpdate: (message: AgentMessage) => void, runtimeOptions?: PromptRuntimeOptions) => {
            harness.promptCalls.push({ sessionId, content, runtimeOptions });
            harness.nowMs += harness.promptDurationMs;
            const errorMessage = harness.promptErrors.shift();
            if (errorMessage) {
                throw new Error(errorMessage);
            }
            onUpdate({ type: 'turn_complete', stopReason: 'stop' });
        }),
        cancelPrompt: vi.fn(async () => {}),
        respondToPermission: vi.fn(async (_sessionId: string, _request: PermissionRequest, _response: PermissionResponse) => {}),
        disconnect: vi.fn(async () => {
            harness.disconnectCalls += 1;
        })
    };
}

function createMode(): AgyMode {
    return {
        permissionMode: 'default' as PermissionMode,
        model: 'Gemini 3.5 Flash (High)'
    };
}

function createSessionStub(message: string | string[] = 'hello Antigravity agy') {
    const messages = Array.isArray(message) ? message : [message];
    const queue = new MessageQueue2<AgyMode>((mode) => JSON.stringify(mode));
    messages.forEach((msg, idx) => {
        const mode = createMode();
        if (messages.length > 1) {
            mode.model = idx === 0 ? 'Gemini 3.5 Flash (High)' : 'Gemini 3.5 Flash (Medium)';
        }
        queue.push(msg, mode);
    });
    queue.close();

    const sessionEvents: Array<{ type: string; [key: string]: unknown }> = [];
    const agentMessages: unknown[] = [];
    const thinkingChanges: boolean[] = [];
    const foundSessionIds: string[] = [];
    const rpcHandlers = new Map<string, (params: unknown) => unknown>();

    const client = {
        rpcHandlerManager: {
            registerHandler(method: string, handler: (params: unknown) => unknown) {
                rpcHandlers.set(method, handler);
            }
        },
        getMetadataSnapshot() {
            return { ...harness.metadata };
        },
        sendClaudeSessionMessage(message: unknown) {
            harness.summaryMessages.push(message);
        },
        updateMetadata(handler: (metadata: Record<string, unknown>) => Record<string, unknown>) {
            harness.metadata = handler({ ...harness.metadata });
            harness.metadataUpdates.push({ ...harness.metadata });
        },
        sendAgentMessage(message: unknown) {
            agentMessages.push(message);
        },
        sendUserMessage(_text: string) {},
        sendSessionEvent(event: { type: string; [key: string]: unknown }) {
            sessionEvents.push(event);
        },
        updateAgentState: vi.fn()
    };

    const session = {
        path: '/tmp/hapi-agy-test',
        logPath: '/tmp/hapi-agy-test/test.log',
        client,
        queue,
        sessionId: null as string | null,
        thinking: false,
        getPermissionMode() {
            return 'default' as PermissionMode;
        },
        onThinkingChange(nextThinking: boolean) {
            session.thinking = nextThinking;
            thinkingChanges.push(nextThinking);
        },
        onSessionFound(id: string) {
            session.sessionId = id;
            foundSessionIds.push(id);
        },
        sendAgentMessage(message: unknown) {
            client.sendAgentMessage(message);
        },
        sendSessionEvent(event: { type: string; [key: string]: unknown }) {
            client.sendSessionEvent(event);
        }
    };

    return {
        session,
        sessionEvents,
        agentMessages,
        thinkingChanges,
        foundSessionIds,
        rpcHandlers
    };
}

describe('agyRemoteLauncher', () => {
    afterEach(() => {
        harness.nowMs = 1_700_000_000_000;
        harness.promptDurationMs = 0;
        harness.promptErrors = [];
        harness.lastNativeConversationId = null;
        harness.promptCalls = [];
        harness.metadata = { path: '/tmp/hapi-agy-test', host: 'test-host' };
        harness.metadataUpdates = [];
        harness.summaryMessages = [];
        harness.newSessionCalls = [];
        harness.loadSessionCalls = [];
        harness.disconnectCalls = 0;
        harness.stderrHandler = null;
        harness.permissionHandler = null;
        createAgyBackendMock.mockReset();
        resolveAgyRuntimeConfigMock.mockReset();
        vi.restoreAllMocks();
    });

    it('prepends TITLE_INSTRUCTION to the first prompt only', async () => {
        vi.spyOn(Date, 'now').mockImplementation(() => harness.nowMs);
        resolveAgyRuntimeConfigMock.mockReturnValue({
            model: 'Gemini 3.5 Flash (High)',
            token: undefined
        });
        createAgyBackendMock.mockReturnValue(createBackendStub());
        const { session } = createSessionStub(['first message', 'second message']);
        const { agyRemoteLauncher } = await import('./agyRemoteLauncher');

        await agyRemoteLauncher(session as never, {
            model: 'Gemini 3.5 Flash (High)',
        });

        expect(harness.promptCalls).toHaveLength(2);

        const firstContent = harness.promptCalls[0].content[0];
        const secondContent = harness.promptCalls[1].content[0];
        if (firstContent.type !== 'text' || secondContent.type !== 'text') {
            throw new Error('expected text prompt content');
        }

        expect(firstContent.text).toContain('HAPI_TITLE:');
        expect(firstContent.text).toContain('handoff review');
        expect(firstContent.text).toContain('foreground');
        expect(firstContent.text).toContain('assistant_text_path');
        expect(firstContent.text).toContain('never end your turn with only a progress update');
        expect(firstContent.text).toContain('first message');
        expect(secondContent.text).not.toContain('change_title');
        expect(secondContent.text).not.toContain('handoff review');
        expect(secondContent.text).toContain('Continue this HAPI Antigravity agy session');
        expect(secondContent.text).toContain('Latest user message:\nsecond message');


        expect(harness.promptCalls[0].runtimeOptions).toEqual({
            model: 'Gemini 3.5 Flash (High)',
            permissionMode: 'default'
        });
        expect(harness.promptCalls[1].runtimeOptions).toEqual({
            model: 'Gemini 3.5 Flash (Medium)',
            permissionMode: 'default'
        });
    });

    it('emits a HAPI-only turn-duration event after an Antigravity agy prompt settles', async () => {
        harness.promptDurationMs = 12_345;
        vi.spyOn(Date, 'now').mockImplementation(() => harness.nowMs);
        resolveAgyRuntimeConfigMock.mockReturnValue({
            model: 'Gemini 3.5 Flash (High)',
            token: undefined
        });
        createAgyBackendMock.mockReturnValue(createBackendStub());
        const { session, sessionEvents, foundSessionIds } = createSessionStub();
        const { agyRemoteLauncher } = await import('./agyRemoteLauncher');

        const exitReason = await agyRemoteLauncher(session as never, {
            model: 'Gemini 3.5 Flash (High)',
        });

        expect(exitReason).toBe('exit');
        expect(foundSessionIds).toEqual(['agy-session-1']);
        expect(sessionEvents).toContainEqual(expect.objectContaining({
            type: 'turn-duration',
            durationMs: 12_345
        }));
        expect(sessionEvents.at(-1)).toEqual({ type: 'ready' });
    });

    it('awaits runner acknowledgement of the provider conversation id before the first user prompt', async () => {
        resolveAgyRuntimeConfigMock.mockReturnValue({
            model: 'Gemini 3.5 Flash (High)',
            token: undefined
        });
        const backend = createBackendStub();
        backend.newSession.mockResolvedValue('de582684-d186-4170-81ba-982809b4e28a');
        createAgyBackendMock.mockReturnValue(backend);
        const { session } = createSessionStub();
        let acknowledge!: () => void;
        session.onSessionFound = vi.fn(() => new Promise<void>((resolve) => { acknowledge = resolve })) as never;
        const { agyRemoteLauncher } = await import('./agyRemoteLauncher');

        const launch = agyRemoteLauncher(session as never, { model: 'Gemini 3.5 Flash (High)' });
        await vi.waitFor(() => expect(session.onSessionFound).toHaveBeenCalledWith('de582684-d186-4170-81ba-982809b4e28a'));
        expect(harness.promptCalls).toHaveLength(0);
        acknowledge();
        await launch;
        expect(harness.promptCalls).toHaveLength(1);
    });

    it('persists a native Antigravity conversation id discovered from the agy log', async () => {
        harness.lastNativeConversationId = 'de582684-d186-4170-81ba-982809b4e28a';
        vi.spyOn(Date, 'now').mockImplementation(() => harness.nowMs);
        resolveAgyRuntimeConfigMock.mockReturnValue({
            model: 'Gemini 3.5 Flash (High)',
            token: undefined
        });
        createAgyBackendMock.mockReturnValue(createBackendStub());
        const { session, foundSessionIds } = createSessionStub(['first message', 'second message']);
        const { agyRemoteLauncher } = await import('./agyRemoteLauncher');

        await agyRemoteLauncher(session as never, {
            model: 'Gemini 3.5 Flash (High)',
        });

        expect(foundSessionIds).toEqual([
            'agy-session-1',
            'de582684-d186-4170-81ba-982809b4e28a'
        ]);
        expect(harness.promptCalls[0].sessionId).toBe('agy-session-1');
        expect(harness.promptCalls[1].sessionId).toBe('de582684-d186-4170-81ba-982809b4e28a');

        const secondContent = harness.promptCalls[1].content[0];
        if (secondContent.type !== 'text') {
            throw new Error('expected text prompt content');
        }
        expect(secondContent.text).not.toContain('Prior transcript:');
        expect(secondContent.text).toBe('second message');
    });

    it('stops before another prompt when a rotated native identity is rejected', async () => {
        const rotatedId = 'de582684-d186-4170-81ba-982809b4e28a';
        harness.lastNativeConversationId = rotatedId;
        resolveAgyRuntimeConfigMock.mockReturnValue({
            model: 'Gemini 3.5 Flash (High)',
            token: undefined
        });
        createAgyBackendMock.mockReturnValue(createBackendStub());
        const { session } = createSessionStub(['first message', 'must not be sent']);
        session.onSessionFound = vi.fn(async (id: string) => {
            if (id === rotatedId) throw new Error('runner rejected rotated identity');
            session.sessionId = id;
        }) as never;
        const { agyRemoteLauncher } = await import('./agyRemoteLauncher');

        const exitReason = await agyRemoteLauncher(session as never, {
            model: 'Gemini 3.5 Flash (High)'
        });

        expect(exitReason).toBe('exit');
        expect(session.onSessionFound).toHaveBeenCalledWith(rotatedId);
        expect(harness.promptCalls.map((call) => call.sessionId)).toEqual(['agy-session-1']);
    });

    it('strips an agy title marker, writes HAPI metadata title, and sends only clean text', async () => {
        vi.spyOn(Date, 'now').mockImplementation(() => harness.nowMs);
        resolveAgyRuntimeConfigMock.mockReturnValue({
            model: 'Gemini 3.5 Flash (High)',
            token: undefined
        });
        const backend = createBackendStub();
        backend.prompt = vi.fn(async (sessionId: string, content: PromptContent[], onUpdate: (message: AgentMessage) => void, runtimeOptions?: PromptRuntimeOptions) => {
            harness.promptCalls.push({ sessionId, content, runtimeOptions });
            onUpdate({ type: 'text', text: 'HAPI_TITLE: agy乱码修复 · 实测\n\n这是干净正文。' });
            onUpdate({ type: 'turn_complete', stopReason: 'stop' });
        });
        createAgyBackendMock.mockReturnValue(backend);
        const { session, agentMessages } = createSessionStub('为什么会乱码？');
        const { agyRemoteLauncher } = await import('./agyRemoteLauncher');

        await agyRemoteLauncher(session as never, {
            model: 'Gemini 3.5 Flash (High)',
        });

        expect(harness.metadata.title).toBe('agy乱码修复 · 实测');
        expect(harness.summaryMessages).toContainEqual(expect.objectContaining({
            type: 'summary',
            summary: 'agy乱码修复 · 实测'
        }));
        expect(agentMessages).toContainEqual({
            type: 'message',
            message: '这是干净正文。'
        });
    });

    it('falls back to a first-user-message title when agy omits the marker', async () => {
        vi.spyOn(Date, 'now').mockImplementation(() => harness.nowMs);
        resolveAgyRuntimeConfigMock.mockReturnValue({
            model: 'Gemini 3.5 Flash (High)',
            token: undefined
        });
        const backend = createBackendStub();
        backend.prompt = vi.fn(async (sessionId: string, content: PromptContent[], onUpdate: (message: AgentMessage) => void, runtimeOptions?: PromptRuntimeOptions) => {
            harness.promptCalls.push({ sessionId, content, runtimeOptions });
            onUpdate({ type: 'text', text: '没有标题标记的正文' });
            onUpdate({ type: 'turn_complete', stopReason: 'stop' });
        });
        createAgyBackendMock.mockReturnValue(backend);
        const { session } = createSessionStub('@/tmp/file.png\n请调四家审查 agy handoff 问题');
        const { agyRemoteLauncher } = await import('./agyRemoteLauncher');

        await agyRemoteLauncher(session as never, {
            model: 'Gemini 3.5 Flash (High)',
        });

        expect(harness.metadata.title).toBe('请调四家审查 agy handoff 问题');
    });

    it('emits turn-duration even when an Antigravity agy prompt fails', async () => {
        harness.promptDurationMs = 7_890;
        harness.promptErrors = ['prompt exploded'];
        vi.spyOn(Date, 'now').mockImplementation(() => harness.nowMs);
        resolveAgyRuntimeConfigMock.mockReturnValue({
            model: 'Gemini 3.5 Flash (High)',
            token: undefined
        });
        createAgyBackendMock.mockReturnValue(createBackendStub());
        const { session, sessionEvents } = createSessionStub();
        const { agyRemoteLauncher } = await import('./agyRemoteLauncher');

        const exitReason = await agyRemoteLauncher(session as never, {
            model: 'Gemini 3.5 Flash (High)',
        });

        expect(exitReason).toBe('exit');
        expect(sessionEvents).toContainEqual(expect.objectContaining({
            type: 'turn-duration',
            durationMs: 7_890
        }));
        expect(sessionEvents.at(-1)).toEqual({ type: 'ready' });
    });

    it('retries the exact browser OAuth authentication timeout once and succeeds silently', async () => {
        harness.promptErrors = [BROWSER_OAUTH_TIMEOUT];
        vi.spyOn(Date, 'now').mockImplementation(() => harness.nowMs);
        resolveAgyRuntimeConfigMock.mockReturnValue({
            model: 'Gemini 3.5 Flash (High)',
            token: undefined
        });
        createAgyBackendMock.mockReturnValue(createBackendStub());
        const { session, sessionEvents } = createSessionStub();
        const { agyRemoteLauncher } = await import('./agyRemoteLauncher');

        await agyRemoteLauncher(session as never, {
            model: 'Gemini 3.5 Flash (High)',
            authRetryDelayMs: 0
        });

        expect(harness.promptCalls).toHaveLength(2);
        expect(sessionEvents).not.toContainEqual(expect.objectContaining({
            type: 'message',
            message: expect.stringContaining('Antigravity agy prompt failed')
        }));
    });

    it('does not retry when the user aborts during the OAuth retry delay', async () => {
        harness.promptErrors = [BROWSER_OAUTH_TIMEOUT];
        vi.spyOn(Date, 'now').mockImplementation(() => harness.nowMs);
        resolveAgyRuntimeConfigMock.mockReturnValue({
            model: 'Gemini 3.5 Flash (High)',
            token: undefined
        });
        createAgyBackendMock.mockReturnValue(createBackendStub());
        const { session, rpcHandlers } = createSessionStub();
        const { agyRemoteLauncher } = await import('./agyRemoteLauncher');

        const launchPromise = agyRemoteLauncher(session as never, {
            model: 'Gemini 3.5 Flash (High)',
            authRetryDelayMs: 50
        });
        await vi.waitFor(() => expect(harness.promptCalls).toHaveLength(1));
        const abort = rpcHandlers.get('abort');
        expect(abort).toBeDefined();
        await abort?.({});
        await new Promise((resolve) => setTimeout(resolve, 75));
        await rpcHandlers.get('switch')?.({});
        await launchPromise;

        expect(harness.promptCalls).toHaveLength(1);
    });

    it('sanitizes the final browser OAuth error after the one retry is exhausted', async () => {
        harness.promptErrors = [BROWSER_OAUTH_TIMEOUT, BROWSER_OAUTH_TIMEOUT];
        vi.spyOn(Date, 'now').mockImplementation(() => harness.nowMs);
        resolveAgyRuntimeConfigMock.mockReturnValue({
            model: 'Gemini 3.5 Flash (High)',
            token: undefined
        });
        createAgyBackendMock.mockReturnValue(createBackendStub());
        const { session, sessionEvents } = createSessionStub();
        const { agyRemoteLauncher } = await import('./agyRemoteLauncher');

        await agyRemoteLauncher(session as never, {
            model: 'Gemini 3.5 Flash (High)',
            authRetryDelayMs: 0
        });

        expect(harness.promptCalls).toHaveLength(2);
        expect(sessionEvents).toContainEqual({
            type: 'message',
            message: 'Antigravity agy prompt failed: auth_error: Antigravity browser authentication timed out after one retry'
        });
        expect(JSON.stringify(sessionEvents)).not.toContain('accounts.google.com');
        expect(JSON.stringify(sessionEvents)).not.toContain('do-not-leak');
    });

    it.each([
        'Error: timeout waiting for response',
        'auth_refresh_network_error: Antigravity token refresh failed due to a network error before the response completed'
    ])('does not retry non-OAuth failure: %s', async (errorMessage) => {
        harness.promptErrors = [errorMessage];
        vi.spyOn(Date, 'now').mockImplementation(() => harness.nowMs);
        resolveAgyRuntimeConfigMock.mockReturnValue({
            model: 'Gemini 3.5 Flash (High)',
            token: undefined
        });
        createAgyBackendMock.mockReturnValue(createBackendStub());
        const { session, sessionEvents } = createSessionStub();
        const { agyRemoteLauncher } = await import('./agyRemoteLauncher');

        await agyRemoteLauncher(session as never, {
            model: 'Gemini 3.5 Flash (High)',
            authRetryDelayMs: 0
        });

        expect(harness.promptCalls).toHaveLength(1);
        expect(sessionEvents).toContainEqual({
            type: 'message',
            message: `Antigravity agy prompt failed: ${errorMessage}`
        });
    });

});

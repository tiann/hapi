import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import type { AgentMessage, AgentSessionConfig, PermissionRequest, PermissionResponse, PromptContent } from '@/agent/types';
import type { OpencodeMode, PermissionMode } from './types';

const harness = vi.hoisted(() => ({
    nowMs: 1_700_000_000_000,
    promptDurationMs: 0,
    promptShouldReject: false,
    promptCalls: [] as Array<{ sessionId: string; content: PromptContent[] }>,
    newSessionCalls: [] as AgentSessionConfig[],
    loadSessionCalls: [] as Array<AgentSessionConfig & { sessionId: string }>,
    disconnectCalls: 0,
    stderrHandler: null as ((error: Error) => void) | null,
    terminalHandler: null as ((error: Error) => void) | null,
    connected: true,
    terminalDuringPrompt: false,
    permissionHandler: null as ((request: PermissionRequest) => void) | null
}));

const createOpencodeBackendMock = vi.hoisted(() => vi.fn());

vi.mock('@/codex/utils/buildHapiMcpBridge', () => ({
    buildHapiMcpBridge: async () => ({
        server: {
            stop: () => {}
        },
        mcpServers: {}
    })
}));

vi.mock('./utils/opencodeBackend', () => ({
    createOpencodeBackend: createOpencodeBackendMock
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
        onTerminalError(handler: (error: Error) => void) {
            harness.terminalHandler = handler;
        },
        isConnected() {
            return harness.connected;
        },
        onPermissionRequest(handler: (request: PermissionRequest) => void) {
            harness.permissionHandler = handler;
        },
        initialize: vi.fn(async () => {}),
        newSession: vi.fn(async (config: AgentSessionConfig) => {
            harness.newSessionCalls.push(config);
            return 'opencode-session-1';
        }),
        loadSession: vi.fn(async (config: AgentSessionConfig & { sessionId: string }) => {
            harness.loadSessionCalls.push(config);
            return config.sessionId;
        }),
        prompt: vi.fn(async (sessionId: string, content: PromptContent[], onUpdate: (message: AgentMessage) => void) => {
            harness.promptCalls.push({ sessionId, content });
            harness.nowMs += harness.promptDurationMs;
            if (harness.terminalDuringPrompt) {
                harness.connected = false;
                const error = new Error('ACP process exited (code=17, signal=null)');
                harness.terminalHandler?.(error);
                throw error;
            }
            if (harness.promptShouldReject) {
                throw new Error('prompt exploded');
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

function createMode(): OpencodeMode {
    return {
        permissionMode: 'default' as PermissionMode
    };
}

function createSessionStub(
    message: string | string[] = 'hello OpenCode',
    options: { closeQueue?: boolean } = {}
) {
    const messages = Array.isArray(message) ? message : [message];
    const queue = new MessageQueue2<OpencodeMode>((mode) => JSON.stringify(mode));
    messages.forEach((msg) => {
        queue.push(msg, createMode());
    });
    if (options.closeQueue !== false) queue.close();

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
        sendAgentMessage(message: unknown) {
            agentMessages.push(message);
        },
        sendSessionEvent(event: { type: string; [key: string]: unknown }) {
            sessionEvents.push(event);
        },
        updateAgentState: vi.fn()
    };

    const session = {
        path: '/tmp/hapi-opencode-test',
        logPath: '/tmp/hapi-opencode-test/test.log',
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

describe('opencodeRemoteLauncher', () => {
    afterEach(() => {
        harness.nowMs = 1_700_000_000_000;
        harness.promptDurationMs = 0;
        harness.promptShouldReject = false;
        harness.promptCalls = [];
        harness.newSessionCalls = [];
        harness.loadSessionCalls = [];
        harness.disconnectCalls = 0;
        harness.stderrHandler = null;
        harness.terminalHandler = null;
        harness.connected = true;
        harness.terminalDuringPrompt = false;
        harness.permissionHandler = null;
        createOpencodeBackendMock.mockReset();
        vi.restoreAllMocks();
    });

    it('emits a HAPI-only turn-duration event after an OpenCode prompt settles', async () => {
        harness.promptDurationMs = 12_345;
        vi.spyOn(Date, 'now').mockImplementation(() => harness.nowMs);
        createOpencodeBackendMock.mockReturnValue(createBackendStub());
        const { session, sessionEvents, foundSessionIds } = createSessionStub();
        const { opencodeRemoteLauncher } = await import('./opencodeRemoteLauncher');

        const exitReason = await opencodeRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(foundSessionIds).toEqual(['opencode-session-1']);
        expect(sessionEvents).toContainEqual(expect.objectContaining({
            type: 'turn-duration',
            durationMs: 12_345
        }));
        expect(sessionEvents.at(-1)).toEqual({ type: 'ready' });
    });

    it('awaits runner acknowledgement of the provider session id before prompting', async () => {
        createOpencodeBackendMock.mockReturnValue(createBackendStub());
        const { session } = createSessionStub();
        let acknowledge!: () => void;
        session.onSessionFound = vi.fn(() => new Promise<void>((resolve) => { acknowledge = resolve })) as never;
        const { opencodeRemoteLauncher } = await import('./opencodeRemoteLauncher');

        const launch = opencodeRemoteLauncher(session as never);
        await vi.waitFor(() => expect(session.onSessionFound).toHaveBeenCalledWith('opencode-session-1'));
        expect(harness.promptCalls).toHaveLength(0);
        acknowledge();
        await launch;
        expect(harness.promptCalls).toHaveLength(1);
    });

    it('emits turn-duration even when an OpenCode prompt fails', async () => {
        harness.promptDurationMs = 7_890;
        harness.promptShouldReject = true;
        vi.spyOn(Date, 'now').mockImplementation(() => harness.nowMs);
        createOpencodeBackendMock.mockReturnValue(createBackendStub());
        const { session, sessionEvents } = createSessionStub();
        const { opencodeRemoteLauncher } = await import('./opencodeRemoteLauncher');

        const exitReason = await opencodeRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(sessionEvents).toContainEqual(expect.objectContaining({
            type: 'turn-duration',
            durationMs: 7_890
        }));
        expect(sessionEvents.at(-1)).toEqual({ type: 'ready' });
    });

    it('terminalizes an active prompt without publishing ready after ACP exits', async () => {
        harness.terminalDuringPrompt = true;
        createOpencodeBackendMock.mockReturnValue(createBackendStub());
        const { session, sessionEvents } = createSessionStub();
        const { opencodeRemoteLauncher } = await import('./opencodeRemoteLauncher');

        await expect(opencodeRemoteLauncher(session as never)).resolves.toBe('exit');

        expect(sessionEvents.filter((event) => event.type === 'ready')).toHaveLength(0);
        expect(sessionEvents.filter((event) => (
            event.type === 'message'
            && typeof event.message === 'string'
            && event.message.includes('ACP process exited (code=17, signal=null)')
        ))).toHaveLength(1);
    });

    it('wakes an idle queue and exits once when the ACP transport terminates', async () => {
        createOpencodeBackendMock.mockReturnValue(createBackendStub());
        const { session, sessionEvents } = createSessionStub([], { closeQueue: false });
        const { opencodeRemoteLauncher } = await import('./opencodeRemoteLauncher');

        const launch = opencodeRemoteLauncher(session as never);
        await vi.waitFor(() => expect(harness.terminalHandler).not.toBeNull());
        harness.connected = false;
        harness.terminalHandler?.(new Error('ACP process exited (code=null, signal=SIGTERM)'));

        await expect(launch).resolves.toBe('exit');
        expect(sessionEvents.filter((event) => event.type === 'ready')).toHaveLength(0);
        expect(sessionEvents.filter((event) => (
            event.type === 'message'
            && typeof event.message === 'string'
            && event.message.includes('ACP process exited (code=null, signal=SIGTERM)')
        ))).toHaveLength(1);
    });

});

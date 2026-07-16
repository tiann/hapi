import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import type { EnhancedMode } from './loop';

const harness = vi.hoisted(() => ({
    initializeError: null as Error | null,
    loadSessionError: null as Error | null,
    supportsLoadSession: true,
    loadSessionCalled: false,
    newSessionCalled: false,
    promptCalls: 0,
    prompts: [] as unknown[][],
    backendArgs: null as { command: string; args?: string[] } | null,
    setConfigOptionCalls: [] as Array<{ sessionId: string; configId: string; value: string }>,
    deferSetConfigOption: null as Promise<void> | null,
    releaseSetConfigOption: null as (() => void) | null,
    deferLoadSession: null as Promise<void> | null,
    releaseLoadSession: null as (() => void) | null
}));

const legacyLauncher = vi.hoisted(() => vi.fn());

vi.mock('./cursorLegacyRemoteLauncher', () => ({
    cursorLegacyRemoteLauncher: legacyLauncher
}));

vi.mock('./utils/cursorAcpBackend', () => ({
    CURSOR_ACP_REQUIRED_MESSAGE: 'Cursor ACP mode is required for new Cursor remote sessions.',
    createCursorAcpBackend: vi.fn((opts?: { model?: string | null }) => {
        const args = ['acp'];
        const model = opts?.model?.trim();
        if (model && model !== 'auto' && model !== 'default' && model !== 'default[]') {
            args.unshift('--model', model);
        }
        harness.backendArgs = { command: 'agent', args };
        return {
            initialize: vi.fn(async () => {
                if (harness.initializeError) throw harness.initializeError;
            }),
            authenticateIfAvailable: vi.fn(async () => {}),
            supportsLoadSession: vi.fn(() => harness.supportsLoadSession),
            loadSession: vi.fn(async () => {
                harness.loadSessionCalled = true;
                if (harness.deferLoadSession) {
                    await harness.deferLoadSession;
                }
                if (harness.loadSessionError) throw harness.loadSessionError;
                return 'loaded-acp-session';
            }),
            newSession: vi.fn(async () => {
                harness.newSessionCalled = true;
                return 'new-acp-session';
            }),
            setMode: vi.fn(async () => {}),
            setModel: vi.fn(async () => {}),
            setConfigOption: vi.fn(async (sessionId: string, configId: string, value: string) => {
                if (configId === 'model-opt' && harness.deferSetConfigOption) {
                    await harness.deferSetConfigOption;
                }
                harness.setConfigOptionCalls.push({ sessionId, configId, value });
            }),
            pinSessionModelWireId: vi.fn(),
            getSessionModelsMetadata: vi.fn(() => ({
                availableModels: [
                    { modelId: 'composer-2.5[fast=true]' },
                    { modelId: 'composer-2.5[fast=false]' }
                ],
                currentModelId: 'composer-2.5[fast=true]'
            })),
            getConfigOptionByCategory: vi.fn((_sessionId: string, category: string) => {
                if (category === 'mode') {
                    return {
                        id: 'mode-opt',
                        options: [
                            { value: 'agent' },
                            { value: 'plan' },
                            { value: 'debug' }
                        ]
                    };
                }
                if (category === 'model') {
                    return {
                        id: 'model-opt',
                        options: [
                            { value: 'default[]' },
                            { value: 'composer-2.5[fast=true]' },
                            { value: 'composer-2.5[fast=false]' }
                        ]
                    };
                }
                return undefined;
            }),
            prompt: vi.fn(async (_sessionId: string, content: unknown[]) => {
                harness.promptCalls++;
                harness.prompts.push(content);
            }),
            cancelPrompt: vi.fn(async () => {}),
            respondToPermission: vi.fn(async () => {}),
            onStderrError: vi.fn(),
            setUsageUpdateListener: vi.fn(),
            onPermissionRequest: vi.fn(),
            registerExtensionRequestHandler: vi.fn(),
            disconnect: vi.fn(async () => {})
        };
    })
}));

vi.mock('./utils/cursorExtensionAdapter', () => ({
    CursorExtensionAdapter: class {
        handlePermissionResponse = vi.fn(async () => false);
        cancelAll = vi.fn(async () => {});
    }
}));

vi.mock('@/agent/permissionAdapter', () => ({
    PermissionAdapter: class {
        cancelAll = vi.fn(async () => {});
    }
}));

vi.mock('@/codex/utils/buildHapiMcpBridge', () => ({
    buildHapiMcpBridge: async () => ({
        server: { stop: () => {} },
        mcpServers: {}
    })
}));

vi.mock('@/ui/ink/OpencodeDisplay', () => ({
    OpencodeDisplay: () => null
}));

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() }
}));

import { cursorAcpRemoteLauncher } from './cursorAcpRemoteLauncher';
import { createCursorAcpBackend } from './utils/cursorAcpBackend';
import { CursorSession } from './session';
import { ApiSessionClient } from '@/api/apiSession';

function makeSession(sessionId: string | null): CursorSession {
    const queue = new MessageQueue2<EnhancedMode>(() => 'mode');
    const client = makeClient();

    const session = new CursorSession({
        api: {} as never,
        client,
        path: '/tmp/project',
        logPath: '/tmp/log',
        sessionId,
        messageQueue: queue,
        onModeChange: vi.fn(),
        mode: 'remote',
        startedBy: 'runner',
        startingMode: 'remote',
        permissionMode: 'default'
    });

    session.onSessionFoundWithProtocol = vi.fn();
    queue.close();

    return session;
}

function makeClient() {
    return {
        rpcHandlerManager: {
            registerHandler: vi.fn()
        },
        updateMetadata: vi.fn(),
        flushMetadata: vi.fn(async () => true),
        sendSessionEvent: vi.fn(),
        sendAgentMessage: vi.fn(),
        keepAlive: vi.fn(),
        emitSessionReady: vi.fn()
    } as unknown as ApiSessionClient;
}

describe('cursorAcpRemoteLauncher', () => {
    beforeEach(() => {
        harness.initializeError = null;
        harness.loadSessionError = null;
        harness.supportsLoadSession = true;
        harness.loadSessionCalled = false;
        harness.newSessionCalled = false;
        harness.promptCalls = 0;
        harness.prompts = [];
        harness.setConfigOptionCalls = [];
        harness.deferSetConfigOption = null;
        harness.releaseSetConfigOption = null;
        harness.deferLoadSession = null;
        harness.releaseLoadSession = null;
        legacyLauncher.mockClear();
        process.stdin.isTTY = false;
        process.stdout.isTTY = false;
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('spawns agent acp backend, not stream-json', async () => {
        const session = makeSession(null);
        await cursorAcpRemoteLauncher(session);

        expect(createCursorAcpBackend).toHaveBeenCalled();
        expect(harness.backendArgs).toEqual({ command: 'agent', args: ['acp'] });
        expect(legacyLauncher).not.toHaveBeenCalled();
    });

    it('throws on initialize failure without invoking legacy launcher', async () => {
        harness.initializeError = new Error('agent acp not found');
        const session = makeSession(null);
        const client = session.client as unknown as { sendAgentMessage: ReturnType<typeof vi.fn> };

        await expect(cursorAcpRemoteLauncher(session)).rejects.toThrow(
            /Cursor ACP mode is required for new Cursor remote sessions/
        );

        expect(client.sendAgentMessage).toHaveBeenCalledWith({
            type: 'error',
            message: expect.stringContaining('agent acp not found')
        });
        expect(legacyLauncher).not.toHaveBeenCalled();
        expect(harness.newSessionCalled).toBe(false);
    });

    it('registers cursorSessionId before session/load completes', async () => {
        let releaseLoadSession!: () => void;
        harness.deferLoadSession = new Promise<void>((resolve) => {
            harness.releaseLoadSession = resolve;
            releaseLoadSession = resolve;
        });

        const session = makeSession('resume-thread-1');
        const launchPromise = cursorAcpRemoteLauncher(session);

        await vi.waitFor(() => {
            expect(session.onSessionFoundWithProtocol).toHaveBeenCalledWith('resume-thread-1', 'acp');
        });
        expect(harness.loadSessionCalled).toBe(true);

        releaseLoadSession();
        await launchPromise;

        expect(session.onSessionFoundWithProtocol).toHaveBeenCalledWith('loaded-acp-session', 'acp');
    });

    it('throws when session/load fails instead of falling back to stream-json', async () => {
        harness.loadSessionError = new Error('session not found');
        const session = makeSession('old-stream-json-id');

        await expect(cursorAcpRemoteLauncher(session)).rejects.toThrow(
            /Legacy stream-json sessions cannot be loaded via ACP/
        );

        expect(harness.loadSessionCalled).toBe(true);
        expect(harness.newSessionCalled).toBe(false);
        expect(legacyLauncher).not.toHaveBeenCalled();
    });

    it('throws when resume id is set but session/load is unsupported', async () => {
        harness.supportsLoadSession = false;
        const session = makeSession('some-session-id');

        await expect(cursorAcpRemoteLauncher(session)).rejects.toThrow(
            /session\/load is not supported/
        );

        expect(harness.loadSessionCalled).toBe(false);
        expect(harness.newSessionCalled).toBe(false);
        expect(legacyLauncher).not.toHaveBeenCalled();
    });

    it('creates a new ACP session when no resume id is provided', async () => {
        const session = makeSession(null);
        await cursorAcpRemoteLauncher(session);

        expect(harness.newSessionCalled).toBe(true);
        expect(harness.loadSessionCalled).toBe(false);
        expect(session.onSessionFoundWithProtocol).toHaveBeenCalledWith('new-acp-session', 'acp');
        expect(session.client.emitSessionReady).toHaveBeenCalledTimes(1);
    });

    it('emits session-ready after session/load succeeds', async () => {
        const session = makeSession('resume-thread-ready');
        await cursorAcpRemoteLauncher(session);

        expect(harness.loadSessionCalled).toBe(true);
        expect(session.client.emitSessionReady).toHaveBeenCalledTimes(1);
    });

    it('does not emit session-ready when session/load fails', async () => {
        harness.loadSessionError = new Error('session not found');
        const session = makeSession('old-stream-json-id');

        await expect(cursorAcpRemoteLauncher(session)).rejects.toThrow(
            /Legacy stream-json sessions cannot be loaded via ACP/
        );

        expect(session.client.emitSessionReady).not.toHaveBeenCalled();
    });

    // tiann/hapi#913: fresh ACP sessions previously persisted `cursorSessionId`
    // via fire-and-forget `updateMetadata`. A SIGTERM within ~1s of the first
    // turn (hub-restart cascade) could strand the session because the ACK
    // never arrived. The fix awaits `client.flushMetadata()` between
    // `onSessionFoundWithProtocol` and the main loop, gating turn processing
    // on a durable persist.
    it('awaits flushMetadata after registering a fresh cursorSessionId so SIGTERM cannot strand the session', async () => {
        const session = makeSession(null);
        const flushSpy = vi.fn(async () => true);
        // Replace the mock fixture's flushMetadata so we can observe ordering.
        (session.client as unknown as { flushMetadata: typeof flushSpy }).flushMetadata = flushSpy;

        let flushCalled = false;
        flushSpy.mockImplementation(async () => {
            flushCalled = true;
            return true;
        });

        const onSessionFoundSpy = session.onSessionFoundWithProtocol as ReturnType<typeof vi.fn>;
        let onSessionFoundCalledBeforeFlush = false;
        onSessionFoundSpy.mockImplementation(() => {
            if (!flushCalled) {
                onSessionFoundCalledBeforeFlush = true;
            }
        });

        await cursorAcpRemoteLauncher(session);

        expect(onSessionFoundCalledBeforeFlush).toBe(true);
        expect(flushSpy).toHaveBeenCalled();
    });

    it('preserves the #834 resume-path pre-registration shape (registration before backend.loadSession)', async () => {
        // PR #834 pre-registers `cursorSessionId` BEFORE `backend.loadSession`
        // so a load-session failure on a legacy store does not strand the
        // session. The #913 fix must not relocate or remove that
        // pre-registration. We verify by observing call ordering on the spy.
        const session = makeSession('resume-acp-session');
        const onSessionFoundSpy = session.onSessionFoundWithProtocol as ReturnType<typeof vi.fn>;

        let preRegisterCalledBeforeLoadSession = false;
        let preRegisterArgs: unknown[] | null = null;
        onSessionFoundSpy.mockImplementation((id: string, protocol: string) => {
            if (!harness.loadSessionCalled) {
                preRegisterCalledBeforeLoadSession = true;
                preRegisterArgs = [id, protocol];
            }
        });

        await cursorAcpRemoteLauncher(session);

        expect(preRegisterCalledBeforeLoadSession).toBe(true);
        expect(preRegisterArgs).toEqual(['resume-acp-session', 'acp']);
        expect(harness.loadSessionCalled).toBe(true);
    });

    it('applies debug mode immediately when setPermissionMode is called', async () => {
        const queue = new MessageQueue2<EnhancedMode>((mode) => mode.permissionMode);
        const client = {
            rpcHandlerManager: { registerHandler: vi.fn() },
            updateMetadata: vi.fn(),
            flushMetadata: vi.fn(async () => true),
            sendSessionEvent: vi.fn(),
            sendAgentMessage: vi.fn(),
            keepAlive: vi.fn(),
        emitSessionReady: vi.fn()
        } as unknown as ApiSessionClient;

        const session = new CursorSession({
            api: {} as never,
            client,
            path: '/tmp/project',
            logPath: '/tmp/log',
            sessionId: null,
            messageQueue: queue,
            onModeChange: vi.fn(),
            mode: 'remote',
            startedBy: 'runner',
            startingMode: 'remote',
            permissionMode: 'default'
        });
        session.onSessionFoundWithProtocol = vi.fn();
        queue.push('hold-open', { permissionMode: 'default' });

        const runPromise = cursorAcpRemoteLauncher(session);
        await vi.waitFor(() => expect(harness.newSessionCalled).toBe(true));

        session.setPermissionMode('debug');

        await vi.waitFor(() => {
            expect(
                harness.setConfigOptionCalls.some(
                    (call) => call.configId === 'mode-opt' && call.value === 'debug'
                )
            ).toBe(true);
        });

        queue.close();
        await runPromise;
    });

    it('syncs spawn model to hub via keepAlive after initial ACP apply', async () => {
        const queue = new MessageQueue2<EnhancedMode>((mode) => mode.permissionMode);
        const keepAlive = vi.fn();
        const client = {
            rpcHandlerManager: { registerHandler: vi.fn() },
            updateMetadata: vi.fn(),
            flushMetadata: vi.fn(async () => true),
            sendSessionEvent: vi.fn(),
            sendAgentMessage: vi.fn(),
            keepAlive,
            emitSessionReady: vi.fn()
        } as unknown as ApiSessionClient;

        const session = new CursorSession({
            api: {} as never,
            client,
            path: '/tmp/project',
            logPath: '/tmp/log',
            sessionId: null,
            messageQueue: queue,
            onModeChange: vi.fn(),
            mode: 'remote',
            startedBy: 'runner',
            startingMode: 'remote',
            permissionMode: 'default',
            model: 'composer-2.5[fast=false]'
        });
        session.onSessionFoundWithProtocol = vi.fn();
        queue.push('hold-open', { permissionMode: 'default' });

        const runPromise = cursorAcpRemoteLauncher(session);
        await vi.waitFor(() => expect(harness.newSessionCalled).toBe(true));

        await vi.waitFor(() => {
            expect(session.model).toBe('composer-2.5[fast=false]');
            expect(keepAlive).toHaveBeenCalled();
        });

        queue.close();
        await runPromise;
    });

    it('pushes keepalive with requested model before ACP apply finishes', async () => {
        harness.deferSetConfigOption = new Promise<void>((resolve) => {
            harness.releaseSetConfigOption = resolve;
        });

        const queue = new MessageQueue2<EnhancedMode>((mode) => mode.permissionMode);
        const keepAlive = vi.fn();
        const client = {
            rpcHandlerManager: { registerHandler: vi.fn() },
            updateMetadata: vi.fn(),
            flushMetadata: vi.fn(async () => true),
            sendSessionEvent: vi.fn(),
            sendAgentMessage: vi.fn(),
            keepAlive,
            emitSessionReady: vi.fn()
        } as unknown as ApiSessionClient;

        const session = new CursorSession({
            api: {} as never,
            client,
            path: '/tmp/project',
            logPath: '/tmp/log',
            sessionId: null,
            messageQueue: queue,
            onModeChange: vi.fn(),
            mode: 'remote',
            startedBy: 'runner',
            startingMode: 'remote',
            permissionMode: 'default'
        });
        session.onSessionFoundWithProtocol = vi.fn();
        queue.push('hold-open', { permissionMode: 'default' });

        const runPromise = cursorAcpRemoteLauncher(session);
        await vi.waitFor(() => expect(harness.newSessionCalled).toBe(true));
        await vi.waitFor(() => expect(session.canApplyModelConfig()).toBe(true));

        session.setModel('composer-2.5[fast=false]');

        await vi.waitFor(() => {
            expect(session.model).toBe('composer-2.5[fast=false]');
            expect(harness.setConfigOptionCalls.some((call) => call.configId === 'model-opt')).toBe(false);
        });

        harness.releaseSetConfigOption?.();
        await vi.waitFor(() => {
            expect(harness.setConfigOptionCalls.length).toBeGreaterThan(0);
        });
        harness.deferSetConfigOption = null;
        harness.releaseSetConfigOption = null;
        queue.close();
        await runPromise;
    });

    it('applies model wire id immediately when setModel is called', async () => {
        const queue = new MessageQueue2<EnhancedMode>((mode) => mode.permissionMode);
        const client = {
            rpcHandlerManager: { registerHandler: vi.fn() },
            updateMetadata: vi.fn(),
            flushMetadata: vi.fn(async () => true),
            sendSessionEvent: vi.fn(),
            sendAgentMessage: vi.fn(),
            keepAlive: vi.fn(),
        emitSessionReady: vi.fn()
        } as unknown as ApiSessionClient;

        const session = new CursorSession({
            api: {} as never,
            client,
            path: '/tmp/project',
            logPath: '/tmp/log',
            sessionId: null,
            messageQueue: queue,
            onModeChange: vi.fn(),
            mode: 'remote',
            startedBy: 'runner',
            startingMode: 'remote',
            permissionMode: 'default'
        });
        session.onSessionFoundWithProtocol = vi.fn();
        queue.push('hold-open', { permissionMode: 'default' });

        const runPromise = cursorAcpRemoteLauncher(session);
        await vi.waitFor(() => expect(harness.newSessionCalled).toBe(true));
        await vi.waitFor(() => expect(session.canApplyModelConfig()).toBe(true));

        session.setModel('composer-2.5[fast=false]');

        await vi.waitFor(() => {
            expect(
                harness.setConfigOptionCalls.some(
                    (call) => call.configId === 'model-opt' && call.value === 'composer-2.5[fast=false]'
                )
            ).toBe(true);
        });

        queue.close();
        await runPromise;
    });

    it('applies ACP default model when setModel is cleared', async () => {
        const queue = new MessageQueue2<EnhancedMode>((mode) => mode.permissionMode);
        const client = {
            rpcHandlerManager: { registerHandler: vi.fn() },
            updateMetadata: vi.fn(),
            flushMetadata: vi.fn(async () => true),
            sendSessionEvent: vi.fn(),
            sendAgentMessage: vi.fn(),
            keepAlive: vi.fn(),
        emitSessionReady: vi.fn()
        } as unknown as ApiSessionClient;

        const session = new CursorSession({
            api: {} as never,
            client,
            path: '/tmp/project',
            logPath: '/tmp/log',
            sessionId: null,
            messageQueue: queue,
            onModeChange: vi.fn(),
            mode: 'remote',
            startedBy: 'runner',
            startingMode: 'remote',
            permissionMode: 'default'
        });
        session.onSessionFoundWithProtocol = vi.fn();
        queue.push('hold-open', { permissionMode: 'default' });

        const runPromise = cursorAcpRemoteLauncher(session);
        await vi.waitFor(() => expect(harness.newSessionCalled).toBe(true));
        await vi.waitFor(() => expect(session.canApplyModelConfig()).toBe(true));

        session.setModel('composer-2.5[fast=false]');
        await vi.waitFor(() => {
            expect(
                harness.setConfigOptionCalls.some(
                    (call) => call.configId === 'model-opt' && call.value === 'composer-2.5[fast=false]'
                )
            ).toBe(true);
        });

        harness.setConfigOptionCalls.length = 0;
        session.setModel(null);

        await vi.waitFor(() => {
            expect(
                harness.setConfigOptionCalls.some(
                    (call) => call.configId === 'model-opt' && call.value === 'default[]'
                )
            ).toBe(true);
            expect(session.model).toBeUndefined();
        });

        queue.close();
        await runPromise;
    });

    it('rolls back optimistic setModel when ACP does not expose the requested model', async () => {
        const queue = new MessageQueue2<EnhancedMode>((mode) => mode.permissionMode);
        const keepAlive = vi.fn();
        const client = {
            rpcHandlerManager: { registerHandler: vi.fn() },
            updateMetadata: vi.fn(),
            flushMetadata: vi.fn(async () => true),
            sendSessionEvent: vi.fn(),
            sendAgentMessage: vi.fn(),
            keepAlive,
            emitSessionReady: vi.fn()
        } as unknown as ApiSessionClient;

        const session = new CursorSession({
            api: {} as never,
            client,
            path: '/tmp/project',
            logPath: '/tmp/log',
            sessionId: null,
            messageQueue: queue,
            onModeChange: vi.fn(),
            mode: 'remote',
            startedBy: 'runner',
            startingMode: 'remote',
            permissionMode: 'default'
        });
        session.onSessionFoundWithProtocol = vi.fn();
        queue.push('hold-open', { permissionMode: 'default' });

        const runPromise = cursorAcpRemoteLauncher(session);
        await vi.waitFor(() => expect(harness.newSessionCalled).toBe(true));
        await vi.waitFor(() => expect(session.canApplyModelConfig()).toBe(true));

        session.setModel('missing-model');

        await vi.waitFor(() => {
            expect(session.model).toBe('composer-2.5[fast=true]');
        });
        expect(keepAlive).toHaveBeenCalled();

        queue.close();
        await runPromise;
    });

    it('applyModelConfig(null) resets ACP to the default model option', async () => {
        const queue = new MessageQueue2<EnhancedMode>((mode) => mode.permissionMode);
        const client = {
            rpcHandlerManager: { registerHandler: vi.fn() },
            updateMetadata: vi.fn(),
            flushMetadata: vi.fn(async () => true),
            sendSessionEvent: vi.fn(),
            sendAgentMessage: vi.fn(),
            keepAlive: vi.fn(),
        emitSessionReady: vi.fn()
        } as unknown as ApiSessionClient;

        const session = new CursorSession({
            api: {} as never,
            client,
            path: '/tmp/project',
            logPath: '/tmp/log',
            sessionId: null,
            messageQueue: queue,
            onModeChange: vi.fn(),
            mode: 'remote',
            startedBy: 'runner',
            startingMode: 'remote',
            permissionMode: 'default'
        });
        session.onSessionFoundWithProtocol = vi.fn();
        queue.push('hold-open', { permissionMode: 'default' });

        const runPromise = cursorAcpRemoteLauncher(session);
        await vi.waitFor(() => expect(harness.newSessionCalled).toBe(true));
        await vi.waitFor(() => expect(session.canApplyModelConfig()).toBe(true));

        await session.applyModelConfig('composer-2.5[fast=false]');
        harness.setConfigOptionCalls.length = 0;

        await session.applyModelConfig(null);

        expect(
            harness.setConfigOptionCalls.some(
                (call) => call.configId === 'model-opt' && call.value === 'default[]'
            )
        ).toBe(true);

        queue.close();
        await runPromise;
    });

    it('rejects applyModelConfig when ACP does not expose the requested model', async () => {
        const queue = new MessageQueue2<EnhancedMode>((mode) => mode.permissionMode);
        const client = {
            rpcHandlerManager: { registerHandler: vi.fn() },
            updateMetadata: vi.fn(),
            flushMetadata: vi.fn(async () => true),
            sendSessionEvent: vi.fn(),
            sendAgentMessage: vi.fn(),
            keepAlive: vi.fn(),
        emitSessionReady: vi.fn()
        } as unknown as ApiSessionClient;

        const session = new CursorSession({
            api: {} as never,
            client,
            path: '/tmp/project',
            logPath: '/tmp/log',
            sessionId: null,
            messageQueue: queue,
            onModeChange: vi.fn(),
            mode: 'remote',
            startedBy: 'runner',
            startingMode: 'remote',
            permissionMode: 'default'
        });
        session.onSessionFoundWithProtocol = vi.fn();
        queue.push('hold-open', { permissionMode: 'default' });

        const runPromise = cursorAcpRemoteLauncher(session);
        await vi.waitFor(() => expect(harness.newSessionCalled).toBe(true));
        await vi.waitFor(() => expect(session.canApplyModelConfig()).toBe(true));

        await expect(session.applyModelConfig('missing-model')).rejects.toThrow(
            /not available via ACP/
        );

        queue.close();
        await runPromise;
    });

    it('processes multiple queued messages with separate prompts', async () => {
        const queue = new MessageQueue2<EnhancedMode>((mode) =>
            `${mode.permissionMode}:${mode.model ?? ''}`
        );
        const client = {
            rpcHandlerManager: { registerHandler: vi.fn() },
            updateMetadata: vi.fn(),
            flushMetadata: vi.fn(async () => true),
            sendSessionEvent: vi.fn(),
            sendAgentMessage: vi.fn(),
            keepAlive: vi.fn(),
        emitSessionReady: vi.fn(),
            emitMessagesConsumed: vi.fn()
        } as unknown as ApiSessionClient;

        const session = new CursorSession({
            api: {} as never,
            client,
            path: '/tmp/project',
            logPath: '/tmp/log',
            sessionId: null,
            messageQueue: queue,
            onModeChange: vi.fn(),
            mode: 'remote',
            startedBy: 'runner',
            startingMode: 'remote',
            permissionMode: 'default'
        });
        session.onSessionFoundWithProtocol = vi.fn();
        queue.push('first', { permissionMode: 'default' });
        queue.push('second', { permissionMode: 'plan' });
        queue.close();

        await cursorAcpRemoteLauncher(session);

        expect(harness.promptCalls).toBe(2);
        expect(JSON.stringify(harness.prompts[0])).toContain('$name');
        expect(JSON.stringify(harness.prompts[0])).toContain('skill_lookup');
        expect(JSON.stringify(harness.prompts[1])).not.toContain('skill_lookup');
    });
});

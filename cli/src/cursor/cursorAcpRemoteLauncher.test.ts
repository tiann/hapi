import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import type { EnhancedMode } from './loop';
import type { AgentMessage } from '@/agent/types';
import { ACP_INDETERMINATE_SYMBOL } from '@/agent/backends/acp/AcpStdioTransport';

const harness = vi.hoisted(() => ({
    initializeError: null as Error | null,
    initializeAttempts: 0,
    loadSessionError: null as Error | null,
    newSessionError: null as Error | null,
    failSetConfigOption: false,
    supportsLoadSession: true,
    loadSessionCalled: false,
    newSessionCalled: false,
    newSessionAttempts: 0,
    promptCalls: 0,
    prompts: [] as unknown[][],
    deferSoftSteer: null as Promise<void> | null,
    softSteerDispatchError: null as Error | null,
    deferSoftSteerDispatch: null as Promise<void> | null,
    promptErrors: [] as Error[],
    promptMessages: [] as AgentMessage[],
    promptMessageBatches: [] as AgentMessage[][],
    promptStderrErrors: [] as Array<{ type: string; message: string; raw: string }>,
    backendArgs: null as { command: string; args?: string[] } | null,
    setConfigOptionCalls: [] as Array<{ sessionId: string; configId: string; value: string }>,
    deferSetConfigOption: null as Promise<void> | null,
    releaseSetConfigOption: null as (() => void) | null,
    deferLoadSession: null as Promise<void> | null,
    releaseLoadSession: null as (() => void) | null,
    stderrErrorHandler: null as ((error: {
        type: string
        message: string
        raw: string
    }) => void) | null,
    emitStderrOnPrompt: null as {
        type: 'rate_limit' | 'model_not_found' | 'authentication' | 'quota_exceeded' | 'unknown'
        message: string
        raw: string
    } | null,
    emitStderrOnInitialize: null as {
        type: 'rate_limit' | 'model_not_found' | 'authentication' | 'quota_exceeded' | 'unknown'
        message: string
        raw: string
    } | null,
    emitStderrOnLoadSession: null as {
        type: 'rate_limit' | 'model_not_found' | 'authentication' | 'quota_exceeded' | 'unknown'
        message: string
        raw: string
    } | null,
    emitTextOnPrompt: null as string | null,
    promptReject: null as Error | null,
    deferPrompt: null as Promise<void> | null,
    releasePrompt: null as (() => void) | null,
    deferBeforeSend: null as Promise<void> | null,
    releaseBeforeSend: null as (() => void) | null,
    promptSends: 0,
    /** When cancelPrompt runs, reject the deferred prompt with this error. */
    rejectPromptOnCancel: null as Error | null,
    disconnectError: null as Error | null,
    overlayCleanup: null as ReturnType<typeof vi.fn> | null,
    agentActivityListener: null as ((thinking: boolean) => void) | null
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
                harness.initializeAttempts += 1;
                if (harness.emitStderrOnInitialize && harness.stderrErrorHandler) {
                    harness.stderrErrorHandler(harness.emitStderrOnInitialize);
                }
                // Remap path (#1430 / stale spawn): fail only the first initialize
                // so the launcher can retry after rewriting --model.
                if (harness.initializeError && harness.initializeAttempts === 1) {
                    if (!harness.emitStderrOnInitialize) {
                        harness.stderrErrorHandler?.({
                            type: 'model_not_found',
                            message: harness.initializeError.message,
                            raw: harness.initializeError.message
                        });
                    }
                    throw harness.initializeError;
                }
            }),
            authenticateIfAvailable: vi.fn(async () => {}),
            supportsLoadSession: vi.fn(() => harness.supportsLoadSession),
            loadSession: vi.fn(async () => {
                harness.loadSessionCalled = true;
                if (harness.deferLoadSession) {
                    await harness.deferLoadSession;
                }
                if (harness.emitStderrOnLoadSession && harness.stderrErrorHandler) {
                    harness.stderrErrorHandler(harness.emitStderrOnLoadSession);
                }
                if (harness.loadSessionError) throw harness.loadSessionError;
                return 'loaded-acp-session';
            }),
            newSession: vi.fn(async () => {
                harness.newSessionAttempts += 1;
                harness.newSessionCalled = true;
                if (harness.newSessionError && harness.newSessionAttempts === 1) {
                    harness.stderrErrorHandler?.({
                        type: 'model_not_found',
                        message: harness.newSessionError.message,
                        raw: harness.newSessionError.message
                    });
                    throw harness.newSessionError;
                }
                return 'new-acp-session';
            }),
            setMode: vi.fn(async () => {}),
            setModel: vi.fn(async () => {}),
            setConfigOption: vi.fn(async (sessionId: string, configId: string, value: string) => {
                if (configId === 'model-opt' && harness.deferSetConfigOption) {
                    await harness.deferSetConfigOption;
                }
                if (harness.failSetConfigOption && configId === 'model-opt') {
                    throw new Error('set_config_option rejected');
                }
                harness.setConfigOptionCalls.push({ sessionId, configId, value });
            }),
            pinSessionModelWireId: vi.fn(),
            getSessionModelsMetadata: vi.fn(() => ({
                availableModels: [
                    { modelId: 'composer-2.5[fast=true]' },
                    { modelId: 'composer-2.5[fast=false]' },
                    { modelId: 'gpt-5.3-codex[reasoning=medium,fast=false]' },
                    { modelId: 'gpt-5.3-codex[reasoning=medium,fast=true]' },
                    { modelId: 'cursor-grok-4.5-medium' },
                    { modelId: 'cursor-grok-4.5-medium-fast' },
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
                            { value: 'composer-2.5[fast=false]' },
                            { value: 'gpt-5.3-codex[reasoning=medium,fast=false]' },
                            { value: 'gpt-5.3-codex[reasoning=medium,fast=true]' },
                            { value: 'cursor-grok-4.5-medium' },
                            { value: 'cursor-grok-4.5-medium-fast' },
                        ]
                    };
                }
                return undefined;
            }),
            prompt: vi.fn(async (
                _sessionId: string,
                content: unknown[],
                onMessage?: (message: AgentMessage) => void,
                options?: { shouldSend?: () => boolean }
            ) => {
                harness.promptCalls++;
                if (harness.deferBeforeSend) {
                    await harness.deferBeforeSend;
                    if (options?.shouldSend && !options.shouldSend()) {
                        return false;
                    }
                }
                harness.promptSends++;
                harness.prompts.push(content);
                const messages = harness.promptMessageBatches.shift() ?? harness.promptMessages.splice(0, 1);
                for (const message of messages) onMessage?.(message);
                if (harness.emitTextOnPrompt && onMessage) {
                    onMessage({ type: 'text', text: harness.emitTextOnPrompt });
                }
                const stderrError = harness.promptStderrErrors.shift();
                if (stderrError) harness.stderrErrorHandler?.(stderrError);
                if (harness.emitStderrOnPrompt && harness.stderrErrorHandler) {
                    harness.stderrErrorHandler(harness.emitStderrOnPrompt);
                }
                if (harness.deferPrompt) await harness.deferPrompt;
                const error = harness.promptErrors.shift();
                if (error) throw error;
                if (harness.promptReject) {
                    throw harness.promptReject;
                }
                return true;
            }),
            cancelPrompt: vi.fn(async () => {
                // Settlement of a deferred prompt is owned by the test so
                // userAbortRequested is visible before classifyAcpRpcRejection.
                if (harness.rejectPromptOnCancel) {
                    harness.promptReject = harness.rejectPromptOnCancel;
                }
            }),
            getPromptGeneration: vi.fn(() => 1),
            beginSoftSteerPrompt: vi.fn(() => ({
                dispatched: harness.softSteerDispatchError
                    ? Promise.reject(harness.softSteerDispatchError)
                    : (harness.deferSoftSteerDispatch ?? Promise.resolve()),
                completed: harness.deferSoftSteer ?? Promise.resolve()
            })),
            softSteerPrompt: vi.fn(async () => {}),
            abortSoftSteers: vi.fn(),
            waitForResponseComplete: vi.fn(async () => {}),
            respondToPermission: vi.fn(async () => {}),
            onStderrError: vi.fn((handler: typeof harness.stderrErrorHandler) => {
                harness.stderrErrorHandler = handler;
            }),
            setUsageUpdateListener: vi.fn(),
            setAgentActivityListener: vi.fn((listener: ((thinking: boolean) => void) | null) => {
                harness.agentActivityListener = listener;
            }),
            setSessionInfoUpdateListener: vi.fn(),
            refreshSessionInfo: vi.fn(async () => {}),
            onPermissionRequest: vi.fn(),
            registerExtensionRequestHandler: vi.fn(),
            disconnect: vi.fn(async () => {
                if (harness.disconnectError) {
                    throw harness.disconnectError;
                }
            })
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
        mcpServers: {
            hapi: { command: 'hapi', args: ['mcp', '--url', 'http://127.0.0.1:1/'] },
        },
    }),
}));

vi.mock('./utils/cursorMcpOverlay', () => ({
    cursorHapiMcpServerId: (sessionId: string) => `hapi-${sessionId}`,
    installCursorMcpOverlay: () => {
        harness.overlayCleanup = vi.fn();
        return { cleanup: harness.overlayCleanup };
    },
}));

vi.mock('@/ui/ink/OpencodeDisplay', () => ({
    OpencodeDisplay: () => null
}));

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() }
}));

import { classifyCursorAcpLoadError, cursorAcpRemoteLauncher } from './cursorAcpRemoteLauncher';
import { createCursorAcpBackend } from './utils/cursorAcpBackend';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import { CursorSession } from './session';
import { ApiSessionClient } from '@/api/apiSession';
import {
    _resetSharedCursorModelsCacheForTests,
    writeSharedCursorModelsCache
} from '@/modules/common/cursorModelsSharedCache';
import { setAutoBridgeTransientModelErrors } from './cursorModelErrorBridgePrefs';

function makeSession(sessionId: string | null, opts?: { keepQueueOpen?: boolean }): CursorSession {
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
    if (!opts?.keepQueueOpen) {
        queue.close();
    }

    return session;
}

function makeClient() {
    const handlers = new Map<string, (payload?: unknown) => Promise<unknown>>();
    return {
        sessionId: 'test-session-id',
        rpcHandlerManager: {
            handlers,
            registerHandler: vi.fn((method: string, handler: (payload?: unknown) => Promise<unknown>) => {
                handlers.set(method, handler);
            }),
            unregisterHandler: vi.fn()
        },
        getMetadata: vi.fn(() => null),
        updateMetadata: vi.fn(),
        flushMetadata: vi.fn(async () => true),
        sendSessionEvent: vi.fn(),
        sendAgentMessage: vi.fn(),
        emitMessagesConsumed: vi.fn(),
        emitSteerIndeterminate: vi.fn(),
        setSteerDeliveryState: vi.fn(async () => true),
        sendClaudeSessionMessage: vi.fn(),
        keepAlive: vi.fn(),
        emitSessionReady: vi.fn()
    } as unknown as ApiSessionClient;
}

describe('cursorAcpRemoteLauncher', () => {
    beforeEach(() => {
        harness.initializeError = null;
        harness.initializeAttempts = 0;
        harness.loadSessionError = null;
        harness.newSessionError = null;
        harness.failSetConfigOption = false;
        harness.supportsLoadSession = true;
        harness.loadSessionCalled = false;
        harness.newSessionAttempts = 0;
        harness.newSessionCalled = false;
        harness.promptCalls = 0;
        harness.prompts = [];
        harness.deferPrompt = null;
        harness.deferSoftSteer = null;
        harness.softSteerDispatchError = null;
        harness.deferSoftSteerDispatch = null;
        harness.promptErrors = [];
        harness.promptMessages = [];
        harness.promptMessageBatches = [];
        harness.promptStderrErrors = [];
        harness.releasePrompt = null;
        harness.setConfigOptionCalls = [];
        harness.deferSetConfigOption = null;
        harness.releaseSetConfigOption = null;
        harness.deferLoadSession = null;
        harness.releaseLoadSession = null;
        harness.stderrErrorHandler = null;
        harness.emitStderrOnPrompt = null;
        harness.emitStderrOnInitialize = null;
        harness.emitStderrOnLoadSession = null;
        harness.emitTextOnPrompt = null;
        harness.promptReject = null;
        harness.deferPrompt = null;
        harness.releasePrompt = null;
        harness.deferBeforeSend = null;
        harness.releaseBeforeSend = null;
        harness.promptSends = 0;
        harness.rejectPromptOnCancel = null;
        harness.disconnectError = null;
        harness.overlayCleanup = null;
        harness.agentActivityListener = null;
        legacyLauncher.mockClear();
        setAutoBridgeTransientModelErrors(false);
        process.stdin.isTTY = false;
        process.stdout.isTTY = false;
    });

    afterEach(() => {
        vi.clearAllMocks();
        setAutoBridgeTransientModelErrors(false);
        _resetSharedCursorModelsCacheForTests();
    });

    it('ends the launcher when a soft steer outlives an abort', async () => {
        let releasePrompt!: () => void;
        harness.deferPrompt = new Promise((resolve) => { releasePrompt = resolve; });
        // Soft-steer completion never settles — simulates Cursor keeping the
        // concurrent request open after an ordinary Abort.
        harness.deferSoftSteer = new Promise(() => {});
        const session = makeSession(null, { keepQueueOpen: true });
        const mode = { permissionMode: 'default' } as EnhancedMode;
        session.queue.push('first', mode, 'first');

        const runPromise = cursorAcpRemoteLauncher(session);
        await vi.waitFor(() => expect(harness.promptCalls).toBe(1));
        const handlers = (session.client as unknown as {
            rpcHandlerManager: { handlers: Map<string, (payload?: unknown) => Promise<unknown>> };
        }).rpcHandlerManager.handlers;

        session.queue.push('soft steer', mode, 'steer');
        await handlers.get(RPC_METHODS.SteerQueuedMessage)!({ localId: 'steer' });
        harness.deferPrompt = null;
        releasePrompt();
        await handlers.get(RPC_METHODS.Abort)!();

        // The old soft steer never settled, so the launcher must not install
        // another prompt handler over it; the bounded drain ends the session.
        expect(harness.promptCalls).toBe(1);
        session.queue.close();
        await runPromise;
    }, 10_000);

    it('restores a queued steer when ACP dispatch fails', async () => {
        let releasePrompt!: () => void;
        harness.deferPrompt = new Promise((resolve) => { releasePrompt = resolve; });
        harness.softSteerDispatchError = new Error('stdin closed');
        const session = makeSession(null, { keepQueueOpen: true });
        const mode = { permissionMode: 'default' } as EnhancedMode;
        session.queue.push('first', mode, 'first');

        const runPromise = cursorAcpRemoteLauncher(session);
        await vi.waitFor(() => expect(harness.promptCalls).toBe(1));
        const handlers = (session.client as unknown as {
            rpcHandlerManager: { handlers: Map<string, (payload?: unknown) => Promise<unknown>> };
        }).rpcHandlerManager.handlers;

        session.queue.push('soft steer', mode, 'steer');
        await expect(handlers.get(RPC_METHODS.SteerQueuedMessage)!({ localId: 'steer' }))
            .resolves.toEqual({ steered: false, error: 'Failed to soft-steer into active turn' });
        expect(session.client.emitMessagesConsumed).not.toHaveBeenCalledWith(['steer'], { steered: true });

        harness.softSteerDispatchError = null;
        harness.deferPrompt = null;
        releasePrompt();
        session.queue.close();
        await runPromise;
    });

    it('restores the row when ACP explicitly rejects after dispatch', async () => {
        let releasePrompt!: () => void;
        let rejectSoftSteer!: (error: Error) => void;
        harness.deferPrompt = new Promise((resolve) => { releasePrompt = resolve; });
        harness.deferSoftSteer = new Promise((_, reject) => { rejectSoftSteer = reject; });
        const session = makeSession(null, { keepQueueOpen: true });
        const mode = { permissionMode: 'default' } as EnhancedMode;
        session.queue.push('first', mode, 'first');

        const runPromise = cursorAcpRemoteLauncher(session);
        await vi.waitFor(() => expect(harness.promptCalls).toBe(1));
        const handlers = (session.client as unknown as {
            rpcHandlerManager: { handlers: Map<string, (payload?: unknown) => Promise<unknown>> };
        }).rpcHandlerManager.handlers;

        session.queue.push('soft steer', mode, 'steer');
        await expect(handlers.get(RPC_METHODS.SteerQueuedMessage)!({ localId: 'steer' }))
            .resolves.toEqual({ steered: true });
        // An explicit JSON-RPC rejection means ACP never accepted the
        // instruction — the row is restored for the next prompt (no data loss).
        rejectSoftSteer(new Error('request rejected'));
        await vi.waitFor(() => expect(session.queue.cancelByLocalId('steer')).toBe(true));
        expect(session.client.emitMessagesConsumed).not.toHaveBeenCalledWith(['steer'], { steered: true });

        harness.deferPrompt = null;
        releasePrompt();
        session.queue.close();
        await runPromise;
    });

    it('holds a transport-ambiguous steer for explicit retry or cancel', async () => {
        let releasePrompt!: () => void;
        let rejectSoftSteer!: (error: Error) => void;
        harness.deferPrompt = new Promise((resolve) => { releasePrompt = resolve; });
        harness.deferSoftSteer = new Promise((_, reject) => { rejectSoftSteer = reject; });
        const indeterminate = new Error('ACP transport closed');
        Object.defineProperty(indeterminate, ACP_INDETERMINATE_SYMBOL, { value: true });
        const session = makeSession(null, { keepQueueOpen: true });
        const mode = { permissionMode: 'default' } as EnhancedMode;
        session.queue.push('first', mode, 'first');

        const runPromise = cursorAcpRemoteLauncher(session);
        await vi.waitFor(() => expect(harness.promptCalls).toBe(1));
        const handlers = (session.client as unknown as {
            rpcHandlerManager: { handlers: Map<string, (payload?: unknown) => Promise<unknown>> };
        }).rpcHandlerManager.handlers;

        session.queue.push('soft steer', mode, 'steer');
        await expect(handlers.get(RPC_METHODS.SteerQueuedMessage)!({ localId: 'steer' }))
            .resolves.toEqual({ steered: true });
        rejectSoftSteer(indeterminate);
        await vi.waitFor(() => expect(session.queue.cancelByLocalId('steer')).toBe(true));
        expect(session.client.emitSteerIndeterminate).toHaveBeenCalledWith(['steer']);
        expect(session.client.emitMessagesConsumed).not.toHaveBeenCalledWith(['steer'], { steered: true });

        harness.deferPrompt = null;
        releasePrompt();
        session.queue.close();
        await runPromise;
    });

    it('holds an indeterminate dispatch failure instead of restoring it', async () => {
        let releasePrompt!: () => void;
        harness.deferPrompt = new Promise((resolve) => { releasePrompt = resolve; });
        const indeterminate = new Error('ACP write callback failed');
        Object.defineProperty(indeterminate, ACP_INDETERMINATE_SYMBOL, { value: true });
        harness.softSteerDispatchError = indeterminate;
        const session = makeSession(null, { keepQueueOpen: true });
        const mode = { permissionMode: 'default' } as EnhancedMode;
        session.queue.push('first', mode, 'first');

        const runPromise = cursorAcpRemoteLauncher(session);
        await vi.waitFor(() => expect(harness.promptCalls).toBe(1));
        const handlers = (session.client as unknown as {
            rpcHandlerManager: { handlers: Map<string, (payload?: unknown) => Promise<unknown>> };
        }).rpcHandlerManager.handlers;

        session.queue.push('soft steer', mode, 'steer');
        await expect(handlers.get(RPC_METHODS.SteerQueuedMessage)!({ localId: 'steer' }))
            .resolves.toEqual({ steered: false, error: 'Steer outcome is being reconciled' });
        expect(session.client.emitSteerIndeterminate).toHaveBeenCalledWith(['steer']);
        expect(session.queue.cancelByLocalId('steer')).toBe(true);

        harness.deferPrompt = null;
        releasePrompt();
        session.queue.close();
        await runPromise;
    });

    it('prevents cancellation once ACP steer dispatch starts', async () => {
        let releasePrompt!: () => void;
        let releaseDispatch!: () => void;
        harness.deferPrompt = new Promise((resolve) => { releasePrompt = resolve; });
        harness.deferSoftSteerDispatch = new Promise((resolve) => { releaseDispatch = resolve; });
        const session = makeSession(null, { keepQueueOpen: true });
        const mode = { permissionMode: 'default' } as EnhancedMode;
        session.queue.push('first', mode, 'first');

        const runPromise = cursorAcpRemoteLauncher(session);
        await vi.waitFor(() => expect(harness.promptCalls).toBe(1));
        const handlers = (session.client as unknown as {
            rpcHandlerManager: { handlers: Map<string, (payload?: unknown) => Promise<unknown>> };
        }).rpcHandlerManager.handlers;

        session.queue.push('soft steer', mode, 'steer');
        const steerResult = handlers.get(RPC_METHODS.SteerQueuedMessage)!({ localId: 'steer' });
        await Promise.resolve();
        expect(session.queue.cancelByLocalId('steer')).toBe('in-flight');
        releaseDispatch();
        await expect(steerResult).resolves.toEqual({ steered: true });
        expect(session.client.emitMessagesConsumed).toHaveBeenCalledWith(['steer'], { steered: true });

        harness.deferPrompt = null;
        releasePrompt();
        session.queue.close();
        await runPromise;
    });

    it('blocks the next prompt while soft-steer dispatch is pending', async () => {
        let releasePrompt!: () => void;
        let releaseDispatch!: () => void;
        let releaseSoftSteer!: () => void;
        harness.deferPrompt = new Promise((resolve) => { releasePrompt = resolve; });
        harness.deferSoftSteerDispatch = new Promise((resolve) => { releaseDispatch = resolve; });
        harness.deferSoftSteer = new Promise((resolve) => { releaseSoftSteer = resolve; });
        const session = makeSession(null, { keepQueueOpen: true });
        const mode = { permissionMode: 'default' } as EnhancedMode;
        session.queue.push('first', mode, 'first');

        const runPromise = cursorAcpRemoteLauncher(session);
        await vi.waitFor(() => expect(harness.promptCalls).toBe(1));
        const handlers = (session.client as unknown as {
            rpcHandlerManager: { handlers: Map<string, (payload?: unknown) => Promise<unknown>> };
        }).rpcHandlerManager.handlers;

        session.queue.push('soft steer', mode, 'steer');
        const steerResult = handlers.get(RPC_METHODS.SteerQueuedMessage)!({ localId: 'steer' });
        await Promise.resolve();
        session.queue.push('next', mode, 'next');
        harness.deferPrompt = null;
        releasePrompt();
        await Promise.resolve();
        expect(harness.promptCalls).toBe(1);

        releaseDispatch();
        await expect(steerResult).resolves.toEqual({ steered: true });
        expect(harness.promptCalls).toBe(1);
        releaseSoftSteer();
        await vi.waitFor(() => expect(harness.promptCalls).toBe(2));
        session.queue.close();
        await runPromise;
    });

    it('acknowledges a steer dispatched before an overlapping abort', async () => {
        let releasePrompt!: () => void;
        let releaseDispatch!: () => void;
        harness.deferPrompt = new Promise((resolve) => { releasePrompt = resolve; });
        harness.deferSoftSteerDispatch = new Promise((resolve) => { releaseDispatch = resolve; });
        const session = makeSession(null, { keepQueueOpen: true });
        const mode = { permissionMode: 'default' } as EnhancedMode;
        session.queue.push('first', mode, 'first');

        const runPromise = cursorAcpRemoteLauncher(session);
        await vi.waitFor(() => expect(harness.promptCalls).toBe(1));
        const handlers = (session.client as unknown as {
            rpcHandlerManager: { handlers: Map<string, (payload?: unknown) => Promise<unknown>> };
        }).rpcHandlerManager.handlers;

        session.queue.push('soft steer', mode, 'steer');
        const steerResult = handlers.get(RPC_METHODS.SteerQueuedMessage)!({ localId: 'steer' });
        await Promise.resolve();
        releaseDispatch();
        await expect(steerResult).resolves.toEqual({ steered: true });
        await handlers.get(RPC_METHODS.Abort)!();

        await vi.waitFor(() => expect(session.client.emitMessagesConsumed).toHaveBeenCalledWith(['steer'], { steered: true }));
        expect(vi.mocked(session.client.emitMessagesConsumed).mock.calls
            .filter(([ids]) => ids.includes('steer'))).toHaveLength(1);

        harness.deferPrompt = null;
        releasePrompt();
        session.queue.close();
        await runPromise;
    });

    it('does not hang teardown while a soft steer completion is unresolved', async () => {
        let releasePrompt!: () => void;
        harness.deferPrompt = new Promise((resolve) => { releasePrompt = resolve; });
        // Completion never resolves — simulates Cursor keeping the concurrent
        // request open past Exit/Switch.
        harness.deferSoftSteer = new Promise(() => {});
        const session = makeSession(null, { keepQueueOpen: true });
        const mode = { permissionMode: 'default' } as EnhancedMode;
        session.queue.push('first', mode, 'first');

        const runPromise = cursorAcpRemoteLauncher(session);
        await vi.waitFor(() => expect(harness.promptCalls).toBe(1));
        const handlers = (session.client as unknown as {
            rpcHandlerManager: { handlers: Map<string, (payload?: unknown) => Promise<unknown>> };
        }).rpcHandlerManager.handlers;

        session.queue.push('soft steer', mode, 'steer');
        await expect(handlers.get(RPC_METHODS.SteerQueuedMessage)!({ localId: 'steer' }))
            .resolves.toEqual({ steered: true });

        // Exit/Switch must reach cleanup (which disconnects the transport and
        // rejects pending ACP requests) without waiting on the soft steer.
        harness.deferPrompt = null;
        releasePrompt();
        await handlers.get(RPC_METHODS.Switch)!();
        await vi.waitFor(() => expect(runPromise).resolves.toBeDefined());
    });

    it('spawns agent acp backend, not stream-json', async () => {
        const session = makeSession(null);
        await cursorAcpRemoteLauncher(session);

        expect(createCursorAcpBackend).toHaveBeenCalled();
        expect(harness.backendArgs).toEqual({ command: 'agent', args: ['acp'] });
        expect(legacyLauncher).not.toHaveBeenCalled();
    });

    it('applies harness thinking transitions once per edge (#1470)', async () => {
        const keepAlive = vi.fn();
        const queue = new MessageQueue2<EnhancedMode>(() => 'mode');
        const client = {
            ...makeClient(),
            keepAlive
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
        // Keep the launcher in the main loop long enough to wire the listener.
        const runPromise = cursorAcpRemoteLauncher(session);
        await vi.waitFor(() => expect(harness.agentActivityListener).not.toBeNull());

        expect(session.thinking).toBe(false);
        keepAlive.mockClear();

        harness.agentActivityListener!(true);
        harness.agentActivityListener!(true);
        harness.agentActivityListener!(false);

        expect(session.thinking).toBe(false);
        expect(keepAlive.mock.calls.map((call) => call[0])).toEqual([true, false]);

        queue.close();
        await runPromise;
    });

    it('retries a transient Cursor connection failure three times using api_error events', async () => {
        harness.promptErrors = [
            new Error('Error: RetriableError: [canceled] http/2 stream closed with error code CANCEL'),
            new Error('Error: RetriableError: [unavailable] connection reset'),
            new Error("ACP request 'session/prompt' timed out after 120000ms")
        ];
        const queue = new MessageQueue2<EnhancedMode>(() => 'mode');
        const client = makeClient() as unknown as ApiSessionClient & {
            sendClaudeSessionMessage: ReturnType<typeof vi.fn>;
            sendAgentMessage: ReturnType<typeof vi.fn>;
        };
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
        queue.push('finish the task', { permissionMode: 'default' });
        queue.close();

        await cursorAcpRemoteLauncher(session);

        expect(harness.promptCalls).toBe(4);
        expect(harness.prompts).toEqual(Array(4).fill([{ type: 'text', text: 'finish the task' }]));
        expect(client.sendClaudeSessionMessage.mock.calls.map(([message]) => ({
            subtype: message.subtype,
            retryAttempt: message.retryAttempt,
            maxRetries: message.maxRetries
        }))).toEqual([
            { subtype: 'api_error', retryAttempt: 1, maxRetries: 4 },
            { subtype: 'api_error', retryAttempt: 2, maxRetries: 4 },
            { subtype: 'api_error', retryAttempt: 3, maxRetries: 4 }
        ]);
        expect(client.sendAgentMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    });

    it('suppresses an inline Cursor connection error and retries instead of rendering it as plaintext', async () => {
        harness.promptMessages = [
            { type: 'text', text: 'Error: RetriableError: [canceled] http/2 stream closed with error code CANCEL' }
        ];
        const queue = new MessageQueue2<EnhancedMode>(() => 'mode');
        const client = makeClient() as unknown as ApiSessionClient & {
            sendClaudeSessionMessage: ReturnType<typeof vi.fn>;
            sendAgentMessage: ReturnType<typeof vi.fn>;
        };
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
        queue.push('finish the task', { permissionMode: 'default' });
        queue.close();

        await cursorAcpRemoteLauncher(session);

        expect(harness.promptCalls).toBe(2);
        expect(client.sendClaudeSessionMessage).toHaveBeenCalledWith(expect.objectContaining({
            subtype: 'api_error',
            retryAttempt: 1,
            maxRetries: 4
        }));
        expect(client.sendAgentMessage).not.toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining('http/2 stream closed')
        }));
    });

    it('suppresses retryable Cursor stderr while a prompt is retried', async () => {
        harness.promptStderrErrors = [{
            type: 'unknown',
            message: 'http/2 stream closed with error code CANCEL',
            raw: 'http/2 stream closed with error code CANCEL'
        }];
        const queue = new MessageQueue2<EnhancedMode>(() => 'mode');
        const client = makeClient() as unknown as ApiSessionClient & {
            sendClaudeSessionMessage: ReturnType<typeof vi.fn>;
            sendAgentMessage: ReturnType<typeof vi.fn>;
        };
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
        queue.push('finish the task', { permissionMode: 'default' });
        queue.close();

        await cursorAcpRemoteLauncher(session);

        expect(harness.promptCalls).toBe(2);
        expect(client.sendClaudeSessionMessage).toHaveBeenCalledWith(expect.objectContaining({
            subtype: 'api_error',
            retryAttempt: 1
        }));
        expect(client.sendAgentMessage).not.toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining('http/2 stream closed')
        }));
    });

    it('does not retry when Cursor completes the turn after transient stderr', async () => {
        harness.promptStderrErrors = [{
            type: 'unknown',
            message: 'http/2 stream closed with error code CANCEL',
            raw: 'http/2 stream closed with error code CANCEL'
        }];
        harness.promptMessages = [{ type: 'turn_complete', stopReason: 'end_turn' }];
        const queue = new MessageQueue2<EnhancedMode>(() => 'mode');
        const client = makeClient() as unknown as ApiSessionClient & {
            sendClaudeSessionMessage: ReturnType<typeof vi.fn>;
        };
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
        queue.push('finish the task', { permissionMode: 'default' });
        queue.close();

        await cursorAcpRemoteLauncher(session);

        expect(harness.promptCalls).toBe(1);
        expect(client.sendClaudeSessionMessage).not.toHaveBeenCalled();
    });

    it('retries when inline failure accompanies recovered stderr and turn_complete', async () => {
        harness.promptStderrErrors = [{
            type: 'unknown',
            message: 'http/2 stream closed with error code CANCEL',
            raw: 'http/2 stream closed with error code CANCEL'
        }];
        harness.promptMessageBatches = [[
            { type: 'text', text: 'Error: RetriableError: [canceled] http/2 stream closed' },
            { type: 'turn_complete', stopReason: 'end_turn' }
        ]];
        const queue = new MessageQueue2<EnhancedMode>(() => 'mode');
        const session = new CursorSession({
            api: {} as never,
            client: makeClient(),
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
        queue.push('finish the task', { permissionMode: 'default' });
        queue.close();

        await cursorAcpRemoteLauncher(session);

        expect(harness.promptCalls).toBe(2);
    });

    it('does not retry when Stop resolves a prompt after a retryable stderr signal', async () => {
        harness.promptStderrErrors = [{
            type: 'unknown',
            message: 'http/2 stream closed with error code CANCEL',
            raw: 'http/2 stream closed with error code CANCEL'
        }];
        harness.deferPrompt = new Promise<void>((resolve) => {
            harness.releasePrompt = resolve;
        });
        const handlers = new Map<string, () => Promise<void>>();
        const queue = new MessageQueue2<EnhancedMode>(() => 'mode');
        const client = {
            ...makeClient(),
            rpcHandlerManager: {
                registerHandler: vi.fn((method: string, handler: () => Promise<void>) => handlers.set(method, handler)),
                unregisterHandler: vi.fn()
            }
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
        queue.push('finish the task', { permissionMode: 'default' });

        const launchPromise = cursorAcpRemoteLauncher(session);
        await vi.waitFor(() => expect(harness.promptCalls).toBe(1));
        await handlers.get('abort')!();
        harness.releasePrompt!();
        queue.close();
        await launchPromise;

        expect(harness.promptCalls).toBe(1);
    });

    it('does not replay a prompt when a transient failure follows tool activity', async () => {
        harness.promptMessages = [{
            type: 'tool_call',
            id: 'tool-1',
            name: 'shell',
            input: { command: 'touch output.txt' },
            status: 'completed'
        }];
        harness.promptErrors = [
            new Error('Error: RetriableError: [canceled] http/2 stream closed with error code CANCEL')
        ];
        const queue = new MessageQueue2<EnhancedMode>(() => 'mode');
        const client = makeClient() as unknown as ApiSessionClient & {
            sendAgentMessage: ReturnType<typeof vi.fn>;
            sendSessionEvent: ReturnType<typeof vi.fn>;
        };
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
        queue.push('finish the task', { permissionMode: 'default' });
        queue.close();

        await cursorAcpRemoteLauncher(session);

        expect(harness.promptCalls).toBe(1);
        expect(client.sendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'error',
            message: expect.stringContaining('not retried')
        }));
        expect(client.sendSessionEvent.mock.calls.some(
            (call) => call[0]?.type === 'modelError'
        )).toBe(true);
        expect(client.sendSessionEvent.mock.calls.some(
            (call) => call[0]?.type === 'modelErrorBridged'
        )).toBe(false);
    });

    it('removes the Cursor MCP overlay even when backend.disconnect rejects', async () => {
        harness.disconnectError = new Error('disconnect failed');
        const session = makeSession(null);

        await expect(cursorAcpRemoteLauncher(session)).rejects.toThrow('disconnect failed');
        expect(harness.overlayCleanup).toHaveBeenCalled();
    });


    it('throws on initialize failure without invoking legacy launcher', async () => {
        harness.initializeError = new Error('agent acp not found');
        const session = makeSession(null);
        const client = session.client as unknown as { sendAgentMessage: ReturnType<typeof vi.fn> };

        await expect(cursorAcpRemoteLauncher(session)).rejects.toThrow(
            /Cursor ACP mode is required for new Cursor remote sessions/
        );
        expect(legacyLauncher).not.toHaveBeenCalled();
        expect(client.sendAgentMessage).toHaveBeenCalled();
    });

    it('surfaces Cursor model rejection during initialize instead of the generic ACP-required message', async () => {
        harness.initializeError = new Error(
            'ACP process exited (code=1, signal=null). stderr: Cannot use this model: grok-4.5[fast=true]. Available models: auto'
        );
        const session = makeSession(null);

        const error = await cursorAcpRemoteLauncher(session).then(
            () => null,
            (err: unknown) => err
        );
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(
            /^Failed to start Cursor ACP session: Cannot use this model: grok-4\.5\[fast=true\]/
        );
        expect((error as Error).message).toMatch(/Available models: auto/);
        expect((error as Error).message).not.toMatch(/Cursor ACP mode is required/);
        expect((error as Error).message).not.toMatch(/Legacy stream-json/);
        expect(legacyLauncher).not.toHaveBeenCalled();
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

        const error = await cursorAcpRemoteLauncher(session).then(
            () => null,
            (err: unknown) => err
        );
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/Failed to resume Cursor ACP session: session not found/);
        expect((error as Error).message).not.toMatch(/Legacy stream-json/);

        expect(harness.loadSessionCalled).toBe(true);
        expect(harness.newSessionCalled).toBe(false);
        expect(legacyLauncher).not.toHaveBeenCalled();
    });

    it('retries session/new once after remapping a rejected bracket wire (#1430)', async () => {
        _resetSharedCursorModelsCacheForTests();
        harness.newSessionError = new Error(
            'ACP process exited (code=1, signal=null). stderr: Cannot use this model: gpt-5.3-codex[fast=false]. Available models: auto, gpt-5.3-codex, gpt-5.3-codex-fast'
        );

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
            permissionMode: 'default',
            model: 'gpt-5.3-codex[fast=false]'
        });
        session.onSessionFoundWithProtocol = vi.fn();
        queue.push('hold-open', { permissionMode: 'default' });

        const runPromise = cursorAcpRemoteLauncher(session);
        await vi.waitFor(() => expect(harness.newSessionAttempts).toBe(2));
        await vi.waitFor(() => {
            expect(harness.backendArgs?.args).toEqual(['--model', 'gpt-5.3-codex', 'acp']);
            expect(
                harness.setConfigOptionCalls.some(
                    (call) =>
                        call.configId === 'model-opt'
                        && call.value === 'gpt-5.3-codex[reasoning=medium,fast=false]'
                )
            ).toBe(true);
            expect(session.model).toBe('gpt-5.3-codex[fast=false]');
        });

        queue.close();
        await runPromise;
    });

    it('fails launch when remapped spawn cannot restore the desired variant (#1430)', async () => {
        _resetSharedCursorModelsCacheForTests();
        harness.failSetConfigOption = true;
        harness.newSessionError = new Error(
            'ACP process exited (code=1, signal=null). stderr: Cannot use this model: composer-2.5[fast=true]. Available models: auto, composer-2.5'
        );

        const queue = new MessageQueue2<EnhancedMode>((mode) => mode.permissionMode);
        const client = makeClient();
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
            model: 'composer-2.5[fast=true]'
        });
        session.onSessionFoundWithProtocol = vi.fn();
        queue.close();

        await expect(cursorAcpRemoteLauncher(session)).rejects.toThrow(
            /Cursor model is not available via ACP: composer-2\.5\[fast=true\]/
        );
        expect(harness.newSessionAttempts).toBe(2);
        expect(harness.backendArgs?.args).toEqual(['--model', 'composer-2.5', 'acp']);
    });

    it('spawns bare remap but reapplies original fast=true variant via ACP (#1430)', async () => {
        writeSharedCursorModelsCache({
            success: true,
            availableModels: [{ modelId: 'composer-2.5' }],
            currentModelId: 'composer-2.5',
            cliModelSkus: [{ modelId: 'composer-2.5' }],
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
            permissionMode: 'default',
            model: 'composer-2.5[fast=true]'
        });
        session.onSessionFoundWithProtocol = vi.fn();
        queue.push('hold-open', { permissionMode: 'default' });

        const runPromise = cursorAcpRemoteLauncher(session);
        await vi.waitFor(() => expect(harness.newSessionCalled).toBe(true));
        await vi.waitFor(() => {
            expect(harness.backendArgs?.args).toEqual(['--model', 'composer-2.5', 'acp']);
            expect(
                harness.setConfigOptionCalls.some(
                    (call) => call.configId === 'model-opt' && call.value === 'composer-2.5[fast=true]'
                )
            ).toBe(true);
            expect(session.model).toBe('composer-2.5[fast=true]');
        });

        queue.close();
        await runPromise;
        _resetSharedCursorModelsCacheForTests();
    });

    it('remaps stale spawn model and retries initialize once on model rejection', async () => {
        harness.initializeError = new Error(
            'ACP process exited (code=1, signal=null). stderr: Cannot use this model: grok-4.5[fast=false]. Available models: auto, cursor-grok-4.5-medium, cursor-grok-4.5-medium-fast'
        );

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
            model: 'grok-4.5[fast=false]'
        });
        session.onSessionFoundWithProtocol = vi.fn();
        queue.push('hold-open', { permissionMode: 'default' });

        const runPromise = cursorAcpRemoteLauncher(session);
        await vi.waitFor(() => expect(harness.initializeAttempts).toBe(2));
        await vi.waitFor(() => expect(harness.newSessionCalled).toBe(true));

        expect(harness.backendArgs?.args).toContain('cursor-grok-4.5-medium');
        expect(keepAlive).toHaveBeenCalled();
        expect(
            (client.sendAgentMessage as ReturnType<typeof vi.fn>).mock.calls.some((call) =>
                JSON.stringify(call[0]).includes('Cannot use this model')
            )
        ).toBe(false);

        queue.close();
        await runPromise;
    });

    it('surfaces Cursor model rejection from session/load instead of claiming legacy protocol', async () => {
        harness.loadSessionError = new Error(
            'ACP process exited (code=1, signal=null). stderr: Cannot use this model: grok-4.5[fast=true]. Available models: auto, cursor-grok-4.5-high-fast'
        );
        const session = makeSession('acp-thread-1');

        const error = await cursorAcpRemoteLauncher(session).then(
            () => null,
            (err: unknown) => err
        );
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/Cannot use this model: grok-4\.5\[fast=true\]/);
        expect((error as Error).message).toMatch(/Available models: auto, cursor-grok-4\.5-high-fast/);
        expect((error as Error).message).not.toMatch(/Legacy stream-json/);

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
            /Failed to resume Cursor ACP session: session not found/
        );

        expect(session.client.emitSessionReady).not.toHaveBeenCalled();
    });

    describe('classifyCursorAcpLoadError', () => {
        it('prefers Cannot use this model text from the underlying error', () => {
            const message = classifyCursorAcpLoadError(
                new Error('ACP process exited (code=1, signal=null). stderr: Cannot use this model: grok-4.5[fast=true]. Available models: auto, composer-2.5')
            );
            expect(message).toContain('Cannot use this model: grok-4.5[fast=true]');
            expect(message).toContain('Available models: auto, composer-2.5');
            expect(message).not.toMatch(/Legacy stream-json/);
        });

        it('uses recentStderr hint when exit error omits the model line', () => {
            const message = classifyCursorAcpLoadError(
                new Error('ACP process exited (code=1, signal=null)'),
                { recentStderr: 'Cannot use this model: stale-id. Available models: auto' }
            );
            expect(message).toContain('Cannot use this model: stale-id');
            expect(message).toContain('Available models: auto');
            expect(message).not.toMatch(/Legacy stream-json/);
        });

        it('prefers accumulated close stderr over a partial recentStderr hint', () => {
            const message = classifyCursorAcpLoadError(
                new Error(
                    'ACP process exited (code=1, signal=null). stderr: Cannot use this model: full-id. Available models: auto, composer-2.5'
                ),
                { recentStderr: 'Cannot use this mo' }
            );
            expect(message).toContain('Cannot use this model: full-id');
            expect(message).toContain('Available models: auto, composer-2.5');
            expect(message).not.toContain('Cannot use this mo:');
        });

        it('propagates generic load failures without inventing a legacy diagnosis', () => {
            const message = classifyCursorAcpLoadError(new Error('Session "abc" not found'));
            expect(message).toBe('Failed to resume Cursor ACP session: Session "abc" not found');
            expect(message).not.toMatch(/Legacy stream-json/);
        });

        it('uses start action prefix for spawn-time model rejection', () => {
            const message = classifyCursorAcpLoadError(
                new Error('ACP process exited (code=1, signal=null)'),
                {
                    recentStderr: 'Cannot use this model: stale-id. Available models: auto',
                    action: 'start'
                }
            );
            expect(message).toMatch(/^Failed to start Cursor ACP session: Cannot use this model: stale-id/);
            expect(message).not.toMatch(/Failed to resume/);
        });
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
        expect(JSON.stringify(harness.prompts[0])).toContain('first');
        expect(JSON.stringify(harness.prompts[0])).not.toContain('skill_lookup');
        expect(JSON.stringify(harness.prompts[0])).not.toContain('$name');
        expect(JSON.stringify(harness.prompts[1])).toContain('second');
        expect(JSON.stringify(harness.prompts[1])).not.toContain('skill_lookup');
    });

    it('keeps generic unknown stderr status-only and still emits ready', async () => {
        // Bot Major: type:unknown comes from any stderr with error/failed/exception.
        // Must not set turnHasModelError / suppress ready / write lastModelError.
        harness.emitStderrOnPrompt = {
            type: 'unknown',
            message: 'Some plugin failed to load: exception during init',
            raw: 'Some plugin failed to load: exception during init'
        };

        const session = makeSession(null, { keepQueueOpen: true });
        const client = session.client as unknown as {
            sendSessionEvent: ReturnType<typeof vi.fn>
            updateMetadata: ReturnType<typeof vi.fn>
            sendAgentMessage: ReturnType<typeof vi.fn>
        };

        session.queue.push('hello', { permissionMode: 'default' });
        session.queue.close();

        await cursorAcpRemoteLauncher(session);

        expect(harness.promptCalls).toBe(1);
        expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        expect(client.sendSessionEvent.mock.calls.some(
            (call) => call[0]?.type === 'modelError'
        )).toBe(false);
        const wroteLastModelError = client.updateMetadata.mock.calls.some((call) => {
            const updater = call[0] as (m: Record<string, unknown>) => Record<string, unknown>;
            if (typeof updater !== 'function') return false;
            return Boolean(updater({}).lastModelError);
        });
        expect(wroteLastModelError).toBe(false);
    });

    it('keeps weak typed authentication stderr status-only and still emits ready', async () => {
        // Transport types "authentication provider initialized" as authentication
        // via bare substring; strong-signature gate must keep it status-only.
        harness.emitStderrOnPrompt = {
            type: 'authentication',
            message: 'authentication provider initialized',
            raw: 'authentication provider initialized'
        };

        const session = makeSession(null, { keepQueueOpen: true });
        const client = session.client as unknown as {
            sendSessionEvent: ReturnType<typeof vi.fn>
        };

        session.queue.push('hello', { permissionMode: 'default' });
        session.queue.close();

        await cursorAcpRemoteLauncher(session);

        expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        expect(client.sendSessionEvent.mock.calls.some(
            (call) => call[0]?.type === 'modelError'
        )).toBe(false);
    });

    it('records modelError for model_not_found stderr during prompt and suppresses ready', async () => {
        harness.emitStderrOnPrompt = {
            type: 'model_not_found',
            message: 'Cannot use this model: cursor-bad-id. Available models: auto',
            raw: 'Cannot use this model: cursor-bad-id. Available models: auto'
        };

        const session = makeSession(null, { keepQueueOpen: true });
        const client = session.client as unknown as {
            sendSessionEvent: ReturnType<typeof vi.fn>
        };

        session.queue.push('hello', { permissionMode: 'default' });
        session.queue.close();

        await cursorAcpRemoteLauncher(session);

        expect(client.sendSessionEvent.mock.calls.some(
            (call) => call[0]?.type === 'modelError' && call[0]?.kind === 'model_not_found'
        )).toBe(true);
        expect(client.sendSessionEvent.mock.calls.some(
            (call) => call[0]?.type === 'ready'
        )).toBe(false);
    });

    it('ignores Cannot use this model stderr during initialize/load so remap can succeed', async () => {
        // Setup/load remap rejects a stale spawn model on stderr, then continues.
        // Must not persist lastModelError / suppress later ready.
        const stale = {
            type: 'model_not_found' as const,
            message: 'Cannot use this model: grok-4.5[fast=true]. Available models: auto',
            raw: 'Cannot use this model: grok-4.5[fast=true]. Available models: auto'
        };
        harness.emitStderrOnInitialize = stale;
        harness.emitStderrOnLoadSession = stale;

        const session = makeSession('resume-remap-ok', { keepQueueOpen: true });
        const client = session.client as unknown as {
            sendSessionEvent: ReturnType<typeof vi.fn>
            updateMetadata: ReturnType<typeof vi.fn>
        };

        session.queue.push('hello', { permissionMode: 'default' });
        session.queue.close();

        await cursorAcpRemoteLauncher(session);

        expect(harness.loadSessionCalled).toBe(true);
        expect(client.sendSessionEvent.mock.calls.some(
            (call) => call[0]?.type === 'modelError'
        )).toBe(false);
        expect(client.updateMetadata.mock.calls.some((call) => {
            const updater = call[0] as (m: Record<string, unknown>) => Record<string, unknown>;
            if (typeof updater !== 'function') return false;
            return Boolean(updater({}).lastModelError);
        })).toBe(false);
        expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
    });

    it('still records modelError for typed rate_limit stderr and suppresses ready', async () => {
        harness.emitStderrOnPrompt = {
            type: 'rate_limit',
            message: 'Rate limit exceeded.',
            raw: 'status 429 ratelimitexceeded'
        };

        const session = makeSession(null, { keepQueueOpen: true });
        const client = session.client as unknown as {
            sendSessionEvent: ReturnType<typeof vi.fn>
            updateMetadata: ReturnType<typeof vi.fn>
        };

        session.queue.push('hello', { permissionMode: 'default' });
        session.queue.close();

        await cursorAcpRemoteLauncher(session);

        expect(client.sendSessionEvent.mock.calls.some(
            (call) => call[0]?.type === 'modelError' && call[0]?.kind === 'rate_limited'
        )).toBe(true);
        expect(client.sendSessionEvent.mock.calls.some(
            (call) => call[0]?.type === 'ready'
        )).toBe(false);
        const wroteLastModelError = client.updateMetadata.mock.calls.some((call) => {
            const updater = call[0] as (m: Record<string, unknown>) => Record<string, unknown>;
            if (typeof updater !== 'function') return false;
            const next = updater({});
            return (next.lastModelError as { kind?: string } | undefined)?.kind === 'rate_limited';
        });
        expect(wroteLastModelError).toBe(true);
    });

    it('prefers structural RPC classification over text fallback when both fire', async () => {
        // Prompt callback emits wire text first (unknown_t_prefix / non-transient),
        // then the promise rejects with WritableIterable (transport_closed).
        harness.emitTextOnPrompt = '\n\nError: T: WritableIterable is closed';
        harness.promptReject = new Error('WritableIterable is closed');

        const session = makeSession(null, { keepQueueOpen: true });
        const client = session.client as unknown as {
            sendSessionEvent: ReturnType<typeof vi.fn>
            updateMetadata: ReturnType<typeof vi.fn>
        };

        session.queue.push('hello', { permissionMode: 'default' });
        session.queue.close();

        await cursorAcpRemoteLauncher(session);

        const modelErrors = client.sendSessionEvent.mock.calls
            .map((call) => call[0])
            .filter((event) => event?.type === 'modelError');
        expect(modelErrors).toHaveLength(1);
        expect(modelErrors[0]?.kind).toBe('transport_closed');
        expect(modelErrors[0]?.transient).toBe(false);
        expect(client.sendSessionEvent.mock.calls.some(
            (call) => call[0]?.type === 'ready'
        )).toBe(false);
    });

    it('prefers specific deferred stderr over generic transport_closed RPC', async () => {
        // Strong quota stderr first, then generic transport close — keep the
        // non-transient cause so retry copy is not “safe to retry”.
        harness.emitStderrOnPrompt = {
            type: 'quota_exceeded',
            message: 'Quota exceeded.',
            raw: 'resource exhausted'
        };
        harness.promptReject = new Error('WritableIterable is closed');

        const session = makeSession(null, { keepQueueOpen: true });
        const client = session.client as unknown as {
            sendSessionEvent: ReturnType<typeof vi.fn>
        };

        session.queue.push('hello', { permissionMode: 'default' });
        session.queue.close();

        await cursorAcpRemoteLauncher(session);

        const modelErrors = client.sendSessionEvent.mock.calls
            .map((call) => call[0])
            .filter((event) => event?.type === 'modelError');
        expect(modelErrors).toHaveLength(1);
        expect(modelErrors[0]?.kind).toBe('quota_exhausted');
        expect(modelErrors[0]?.transient).toBe(false);
    });

    it('still records modelError for canceled RPC rejection without user abort', async () => {
        harness.promptReject = new Error('Error: T: [canceled] Operation aborted');

        const session = makeSession(null, { keepQueueOpen: true });
        const client = session.client as unknown as {
            sendSessionEvent: ReturnType<typeof vi.fn>
        };

        session.queue.push('hello', { permissionMode: 'default' });
        session.queue.close();
        await cursorAcpRemoteLauncher(session);

        expect(client.sendSessionEvent.mock.calls.some(
            (call) => call[0]?.type === 'modelError' && call[0]?.kind === 'canceled'
        )).toBe(true);
    });

    it('does not promote user Abort cancel rejection to modelError', async () => {
        // Cursor rejects session/prompt after session/cancel with this wire shape;
        // classifier maps it to kind=canceled, but Abort must not page/notify.
        // Switch → requestExit → handleAbort sets shouldExit + userAbortRequested
        // before we settle the deferred prompt rejection (ordering matches
        // cancel-then-reject on the wire; avoids queue.reset hang in tests).
        harness.deferPrompt = new Promise<void>((resolve) => {
            harness.releasePrompt = resolve;
        });
        harness.rejectPromptOnCancel = new Error('Error: T: [canceled] Operation aborted');

        const session = makeSession(null, { keepQueueOpen: true });
        const client = session.client as unknown as {
            rpcHandlerManager: { registerHandler: ReturnType<typeof vi.fn> }
            sendSessionEvent: ReturnType<typeof vi.fn>
            updateMetadata: ReturnType<typeof vi.fn>
        };

        session.queue.push('hello', { permissionMode: 'default' });

        const launchPromise = cursorAcpRemoteLauncher(session);
        await vi.waitFor(() => expect(harness.promptCalls).toBe(1));

        const switchHandler = client.rpcHandlerManager.registerHandler.mock.calls.find(
            (call) => call[0] === 'switch'
        )?.[1] as (() => Promise<void>) | undefined;
        expect(switchHandler).toBeTypeOf('function');
        await switchHandler!();
        harness.releasePrompt?.();
        await launchPromise;

        expect(client.sendSessionEvent.mock.calls.some(
            (call) => call[0]?.type === 'modelError'
        )).toBe(false);
        const wroteLastModelError = client.updateMetadata.mock.calls.some((call) => {
            const updater = call[0] as (m: Record<string, unknown>) => Record<string, unknown>;
            if (typeof updater !== 'function') return false;
            return Boolean(updater({}).lastModelError);
        });
        expect(wroteLastModelError).toBe(false);
    });

    it('does not mark an in-flight bridge recovered when Abort wins the race', async () => {
        // Enqueue bridge while idle, then hold the bridge prompt and abort before
        // it settles — must NOT emit recovered.
        const session = makeSession('acp-session', { keepQueueOpen: true });
        const client = session.client as unknown as {
            rpcHandlerManager: { registerHandler: ReturnType<typeof vi.fn> }
            sendSessionEvent: ReturnType<typeof vi.fn>
            updateMetadata: ReturnType<typeof vi.fn>
        };

        let waitCount = 0;
        const nextWait = { release: null as (() => void) | null };
        const originalWait = session.queue.waitForMessagesAndGetAsString.bind(session.queue);
        session.queue.waitForMessagesAndGetAsString = async (signal) => {
            waitCount += 1;
            // Park from the second wait (post-first-turn idle) so bridge stays queued.
            if (waitCount >= 2 && nextWait.release === null) {
                await new Promise<void>((resolve) => {
                    nextWait.release = resolve;
                });
            }
            return originalWait(signal);
        };

        session.queue.push('hello', { permissionMode: 'default' });
        const launchPromise = cursorAcpRemoteLauncher(session);
        await vi.waitFor(() => expect(harness.promptCalls).toBe(1));
        await vi.waitFor(() => nextWait.release !== null);

        const bridgeHandler = client.rpcHandlerManager.registerHandler.mock.calls.find(
            (call) => call[0] === RPC_METHODS.BridgeModelError
        )?.[1] as ((payload: unknown) => Promise<{ ok: boolean; reason?: string }>) | undefined;
        const eventId = '55555555-5555-4555-8555-555555555555';
        expect(await bridgeHandler!({
            eventId,
            kind: 'rate_limited',
            transient: true,
            rawSnippet: 'status 429',
            lastUserMessage: 'hello',
            priorAssistantClaimsDone: false
        })).toEqual({ ok: true });

        const bridgeGate = { release: null as (() => void) | null };
        harness.deferPrompt = new Promise<void>((resolve) => {
            bridgeGate.release = resolve;
        });
        nextWait.release?.();
        await vi.waitFor(() => expect(harness.promptCalls).toBe(2));

        const abortHandler = client.rpcHandlerManager.registerHandler.mock.calls.find(
            (call) => call[0] === RPC_METHODS.Abort
        )?.[1] as (() => Promise<void>) | undefined;
        expect(abortHandler).toBeTypeOf('function');
        await abortHandler!();
        bridgeGate.release?.();
        session.queue.close();
        await launchPromise;

        expect(client.sendSessionEvent.mock.calls.some(
            (call) => call[0]?.type === 'modelErrorBridged'
        )).toBe(false);
        const wroteBridgedForEventId = client.updateMetadata.mock.calls.some((call) => {
            const updater = call[0] as (m: Record<string, unknown>) => Record<string, unknown>;
            if (typeof updater !== 'function') return false;
            const err = updater({}).lastModelError as { bridgedForEventId?: string } | undefined;
            return err?.bridgedForEventId === eventId;
        });
        expect(wroteBridgedForEventId).toBe(false);
    });

    it('does not promote ACP process-exit rejection after deliberate abort to modelError', async () => {
        harness.deferPrompt = new Promise<void>((resolve) => {
            harness.releasePrompt = resolve;
        });

        // Non-null Cursor session id so handleAbort reaches backend.cancelPrompt.
        const session = makeSession('acp-session', { keepQueueOpen: true });
        const client = session.client as unknown as {
            rpcHandlerManager: { registerHandler: ReturnType<typeof vi.fn> }
            sendSessionEvent: ReturnType<typeof vi.fn>
            updateMetadata: ReturnType<typeof vi.fn>
        };

        session.queue.push('hello', { permissionMode: 'default' });
        const launchPromise = cursorAcpRemoteLauncher(session);
        await vi.waitFor(() => expect(harness.promptCalls).toBe(1));

        harness.rejectPromptOnCancel = new Error('ACP process exited (code=143, signal=null)');
        const abortHandler = client.rpcHandlerManager.registerHandler.mock.calls.find(
            (call) => call[0] === RPC_METHODS.Abort
        )?.[1] as (() => Promise<void>) | undefined;
        expect(abortHandler).toBeTypeOf('function');
        await abortHandler!();
        harness.releasePrompt?.();
        session.queue.close();
        await launchPromise;

        expect(client.sendSessionEvent.mock.calls.some(
            (call) => call[0]?.type === 'modelError'
        )).toBe(false);
        const wroteLastModelError = client.updateMetadata.mock.calls.some((call) => {
            const updater = call[0] as (m: Record<string, unknown>) => Record<string, unknown>;
            if (typeof updater !== 'function') return false;
            return Boolean(updater({}).lastModelError);
        });
        expect(wroteLastModelError).toBe(false);
        expect(session.queue.pendingLocalIds().some((id) => id.startsWith('bridge:'))).toBe(false);
    });

    it('rejects manual bridge while a normal prompt is in flight', async () => {
        harness.deferPrompt = new Promise<void>((resolve) => {
            harness.releasePrompt = resolve;
        });

        const session = makeSession(null, { keepQueueOpen: true });
        const client = session.client as unknown as {
            rpcHandlerManager: { registerHandler: ReturnType<typeof vi.fn> }
        };

        session.queue.push('hello', { permissionMode: 'default' });
        const launchPromise = cursorAcpRemoteLauncher(session);
        await vi.waitFor(() => expect(harness.promptCalls).toBe(1));

        const bridgeHandler = client.rpcHandlerManager.registerHandler.mock.calls.find(
            (call) => call[0] === RPC_METHODS.BridgeModelError
        )?.[1] as ((payload: unknown) => Promise<{ ok: boolean; reason?: string }>) | undefined;

        const eventId = '66666666-6666-4666-8666-666666666666';
        expect(await bridgeHandler!({
            eventId,
            kind: 'rate_limited',
            transient: true,
            rawSnippet: 'status 429',
            lastUserMessage: 'older failed turn',
            priorAssistantClaimsDone: false
        })).toEqual({ ok: false, reason: 'prompt_in_flight' });
        expect(session.queue.pendingLocalIds().some((id) => id.startsWith('bridge:'))).toBe(false);

        session.queue.close();
        harness.releasePrompt?.();
        await launchPromise;
    });

    it('clears pending bridge on abort so the same event can be bridged again', async () => {
        const session = makeSession(null, { keepQueueOpen: true });
        const client = session.client as unknown as {
            rpcHandlerManager: { registerHandler: ReturnType<typeof vi.fn> }
        };

        // Park the post-turn wait so a manual bridge stays queued (idle, not mid-prompt).
        let waitCount = 0;
        const nextWait = { release: null as (() => void) | null };
        const originalWait = session.queue.waitForMessagesAndGetAsString.bind(session.queue);
        session.queue.waitForMessagesAndGetAsString = async (signal) => {
            waitCount += 1;
            if (waitCount >= 2 && nextWait.release === null) {
                await new Promise<void>((resolve) => {
                    nextWait.release = resolve;
                });
            }
            return originalWait(signal);
        };

        session.queue.push('hello', { permissionMode: 'default' });
        const launchPromise = cursorAcpRemoteLauncher(session);
        await vi.waitFor(() => expect(harness.promptCalls).toBe(1));
        await vi.waitFor(() => nextWait.release !== null);

        const bridgeHandler = client.rpcHandlerManager.registerHandler.mock.calls.find(
            (call) => call[0] === RPC_METHODS.BridgeModelError
        )?.[1] as ((payload: unknown) => Promise<{ ok: boolean; reason?: string }>) | undefined;
        expect(bridgeHandler).toBeTypeOf('function');

        const eventId = '11111111-1111-4111-8111-111111111111';
        const bridgePayload = {
            eventId,
            kind: 'rate_limited',
            transient: true,
            rawSnippet: 'status 429',
            lastUserMessage: 'hello',
            priorAssistantClaimsDone: false
        };

        expect(await bridgeHandler!(bridgePayload)).toEqual({ ok: true });
        expect(session.queue.queue.some((item) => item.internal?.kind === 'model-error-bridge' && item.internal.eventId === eventId)).toBe(true);
        expect(session.queue.pendingLocalIds().some((id) => id.startsWith('bridge:'))).toBe(false);
        expect(await bridgeHandler!(bridgePayload)).toEqual({
            ok: false,
            reason: 'not_bridgeable'
        });

        const abortHandler = client.rpcHandlerManager.registerHandler.mock.calls.find(
            (call) => call[0] === RPC_METHODS.Abort
        )?.[1] as (() => Promise<void>) | undefined;
        expect(abortHandler).toBeTypeOf('function');
        await abortHandler!();

        expect(session.queue.pendingLocalIds().some((id) => id.startsWith('bridge:'))).toBe(false);
        expect(await bridgeHandler!(bridgePayload)).toEqual({ ok: true });
        expect(session.queue.queue.some((item) => item.internal?.kind === 'model-error-bridge' && item.internal.eventId === eventId)).toBe(true);
        expect(session.queue.pendingLocalIds().some((id) => id.startsWith('bridge:'))).toBe(false);

        session.queue.close();
        nextWait.release?.();
        await launchPromise;
    });

    it('treats a forged bridge: localId user turn as normal and refuses Bridge overtake', async () => {
        const session = makeSession(null, { keepQueueOpen: true });
        const client = session.client as unknown as {
            rpcHandlerManager: { registerHandler: ReturnType<typeof vi.fn> }
        };

        let waitCount = 0;
        const nextWait = { release: null as (() => void) | null };
        const originalWait = session.queue.waitForMessagesAndGetAsString.bind(session.queue);
        session.queue.waitForMessagesAndGetAsString = async (signal) => {
            waitCount += 1;
            if (waitCount >= 2 && nextWait.release === null) {
                await new Promise<void>((resolve) => {
                    nextWait.release = resolve;
                });
            }
            return originalWait(signal);
        };

        session.queue.push('first', { permissionMode: 'default' });
        const launchPromise = cursorAcpRemoteLauncher(session);
        await vi.waitFor(() => expect(harness.promptCalls).toBe(1));
        await vi.waitFor(() => nextWait.release !== null);

        // Forged localId must not count as queue-owned Bridge provenance.
        session.queue.push('forged', { permissionMode: 'default' }, 'bridge:evt-forged');
        expect(session.queue.hasPendingNonBridgeTurn()).toBe(true);

        const bridgeHandler = client.rpcHandlerManager.registerHandler.mock.calls.find(
            (call) => call[0] === RPC_METHODS.BridgeModelError
        )?.[1] as ((payload: unknown) => Promise<{ ok: boolean; reason?: string }>) | undefined;

        expect(await bridgeHandler!({
            eventId: '55555555-5555-4555-8555-555555555555',
            kind: 'rate_limited',
            transient: true,
            rawSnippet: 'status 429',
            lastUserMessage: 'first',
            priorAssistantClaimsDone: false
        })).toEqual({ ok: false, reason: 'superseded_by_newer_turn' });
        expect(session.queue.queue.some((item) => item.internal?.kind === 'model-error-bridge')).toBe(false);

        session.queue.close();
        nextWait.release?.();
        await launchPromise;
    });

    it('rejects Bridge when the last user prompt exceeds the exact-replay limit', async () => {
        const { MAX_LAST_USER_MESSAGE_CHARS } = await import('./cursorModelErrorBridge');
        harness.emitStderrOnPrompt = {
            type: 'rate_limit',
            message: 'Rate limit exceeded.',
            raw: 'status 429 ratelimitexceeded'
        };

        const session = makeSession(null, { keepQueueOpen: true });
        const client = session.client as unknown as {
            rpcHandlerManager: { registerHandler: ReturnType<typeof vi.fn> }
            sendSessionEvent: ReturnType<typeof vi.fn>
            updateMetadata: ReturnType<typeof vi.fn>
        };

        const longPrompt = 'x'.repeat(MAX_LAST_USER_MESSAGE_CHARS + 1);
        session.queue.push(longPrompt, { permissionMode: 'default' });
        session.queue.close();
        await cursorAcpRemoteLauncher(session);

        await vi.waitFor(() => client.sendSessionEvent.mock.calls.some(
            (call) => call[0]?.type === 'modelError'
        ));

        const recorded = client.updateMetadata.mock.calls
            .map((c) => {
                const u = c[0] as (m: Record<string, unknown>) => Record<string, unknown>;
                if (typeof u !== 'function') return null;
                return u({}).lastModelError as {
                    eventId?: string
                    bridgeable?: boolean
                    lastUserMessage?: string
                } | undefined;
            })
            .find((err) => typeof err?.eventId === 'string');
        expect(recorded?.bridgeable).toBe(false);
        expect(recorded?.lastUserMessage).toBe('');

        const bridgeHandler = client.rpcHandlerManager.registerHandler.mock.calls.find(
            (call) => call[0] === RPC_METHODS.BridgeModelError
        )?.[1] as ((payload: unknown) => Promise<{ ok: boolean; reason?: string }>) | undefined;
        expect(await bridgeHandler!({
            eventId: recorded?.eventId,
            kind: 'rate_limited',
            transient: true,
            rawSnippet: 'status 429',
            lastUserMessage: longPrompt,
            priorAssistantClaimsDone: false
        })).toEqual({ ok: false, reason: 'not_bridgeable' });
    });

    it('does not wrap pass-through slash commands as Bridge prompts', async () => {
        harness.emitStderrOnPrompt = {
            type: 'rate_limit',
            message: 'Rate limit exceeded.',
            raw: 'status 429 ratelimitexceeded'
        };

        const session = makeSession(null, { keepQueueOpen: true });
        const client = session.client as unknown as {
            rpcHandlerManager: { registerHandler: ReturnType<typeof vi.fn> }
            sendSessionEvent: ReturnType<typeof vi.fn>
            updateMetadata: ReturnType<typeof vi.fn>
        };

        session.queue.push('/compact keep recap', { permissionMode: 'default' });
        session.queue.close();
        await cursorAcpRemoteLauncher(session);

        await vi.waitFor(() => client.sendSessionEvent.mock.calls.some(
            (call) => call[0]?.type === 'modelError'
        ));

        const recorded = client.updateMetadata.mock.calls
            .map((c) => {
                const u = c[0] as (m: Record<string, unknown>) => Record<string, unknown>;
                if (typeof u !== 'function') return null;
                return u({}).lastModelError as {
                    eventId?: string
                    bridgeable?: boolean
                    lastUserMessage?: string
                } | undefined;
            })
            .find((err) => typeof err?.eventId === 'string');
        expect(recorded?.bridgeable).toBe(false);
        expect(recorded?.lastUserMessage).toBe('');

        const bridgeHandler = client.rpcHandlerManager.registerHandler.mock.calls.find(
            (call) => call[0] === RPC_METHODS.BridgeModelError
        )?.[1] as ((payload: unknown) => Promise<{ ok: boolean; reason?: string }>) | undefined;
        expect(await bridgeHandler!({
            eventId: recorded?.eventId,
            kind: 'rate_limited',
            transient: true,
            rawSnippet: 'status 429',
            lastUserMessage: '/compact keep recap',
            priorAssistantClaimsDone: false
        })).toEqual({ ok: false, reason: 'not_bridgeable' });
    });

    it('rejects manual bridge when a newer user turn is already queued', async () => {
        const session = makeSession(null, { keepQueueOpen: true });
        const client = session.client as unknown as {
            rpcHandlerManager: { registerHandler: ReturnType<typeof vi.fn> }
            updateMetadata: ReturnType<typeof vi.fn>
        };

        let waitCount = 0;
        const nextWait = { release: null as (() => void) | null };
        const originalWait = session.queue.waitForMessagesAndGetAsString.bind(session.queue);
        session.queue.waitForMessagesAndGetAsString = async (signal) => {
            waitCount += 1;
            if (waitCount >= 2 && nextWait.release === null) {
                await new Promise<void>((resolve) => {
                    nextWait.release = resolve;
                });
            }
            return originalWait(signal);
        };

        session.queue.push('first', { permissionMode: 'default' });
        const launchPromise = cursorAcpRemoteLauncher(session);
        await vi.waitFor(() => expect(harness.promptCalls).toBe(1));
        await vi.waitFor(() => nextWait.release !== null);

        const bridgeHandler = client.rpcHandlerManager.registerHandler.mock.calls.find(
            (call) => call[0] === RPC_METHODS.BridgeModelError
        )?.[1] as ((payload: unknown) => Promise<{ ok: boolean; reason?: string }>) | undefined;

        session.queue.push('correction instead of retry', { permissionMode: 'default' });
        expect(await bridgeHandler!({
            eventId: '44444444-4444-4444-8444-444444444444',
            kind: 'rate_limited',
            transient: true,
            rawSnippet: 'status 429',
            lastUserMessage: 'first',
            priorAssistantClaimsDone: false
        })).toEqual({ ok: false, reason: 'superseded_by_newer_turn' });

        expect(session.queue.pendingLocalIds().some((id) => id.startsWith('bridge:'))).toBe(false);
        expect(session.queue.queue.some((item) => item.message === 'correction instead of retry')).toBe(true);

        session.queue.close();
        nextWait.release?.();
        await launchPromise;
    });

    it('does not auto-bridge ahead of a newer queued user turn', async () => {
        const { setAutoBridgeTransientModelErrors } = await import('./cursorModelErrorBridgePrefs');
        setAutoBridgeTransientModelErrors(true);

        harness.deferPrompt = new Promise<void>((resolve) => {
            harness.releasePrompt = resolve;
        });
        harness.promptReject = new Error('status 429 ratelimitexceeded');

        const session = makeSession(null, { keepQueueOpen: true });
        const client = session.client as unknown as {
            sendSessionEvent: ReturnType<typeof vi.fn>
        };

        session.queue.push('first', { permissionMode: 'default' });
        const launchPromise = cursorAcpRemoteLauncher(session);
        await vi.waitFor(() => expect(harness.promptCalls).toBe(1));

        // User queues a replacement while the failing turn is still settling.
        session.queue.push('do something else', { permissionMode: 'default' });
        harness.releasePrompt?.();

        await vi.waitFor(() => client.sendSessionEvent.mock.calls.some(
            (call) => call[0]?.type === 'modelError'
        ));
        expect(session.queue.pendingLocalIds().some((id) => id.startsWith('bridge:'))).toBe(false);
        expect(session.queue.queue[0]?.message).toBe('do something else');

        setAutoBridgeTransientModelErrors(false);
        session.queue.close();
        await launchPromise;
    });

    it('drops an already-queued Bridge when a newer user turn arrives before dequeue', async () => {
        harness.emitStderrOnPrompt = {
            type: 'rate_limit',
            message: 'Rate limit exceeded.',
            raw: 'status 429 ratelimitexceeded'
        };

        let metadata: Record<string, unknown> = {
            path: '/tmp/project',
            host: 'localhost'
        };
        const session = makeSession(null, { keepQueueOpen: true });
        const client = session.client as unknown as {
            rpcHandlerManager: { registerHandler: ReturnType<typeof vi.fn> }
            sendSessionEvent: ReturnType<typeof vi.fn>
            getMetadata: ReturnType<typeof vi.fn>
            updateMetadata: ReturnType<typeof vi.fn>
        };
        client.getMetadata.mockImplementation(() => metadata);
        client.updateMetadata.mockImplementation((updater: unknown) => {
            if (typeof updater === 'function') {
                metadata = (updater as (m: Record<string, unknown>) => Record<string, unknown>)(metadata);
            }
        });

        let waitCount = 0;
        const nextWait = { release: null as (() => void) | null };
        const originalWait = session.queue.waitForMessagesAndGetAsString.bind(session.queue);
        session.queue.waitForMessagesAndGetAsString = async (signal) => {
            waitCount += 1;
            if (waitCount >= 2 && nextWait.release === null) {
                await new Promise<void>((resolve) => {
                    nextWait.release = resolve;
                });
            }
            return originalWait(signal);
        };

        session.queue.push('first', { permissionMode: 'default' });
        const launchPromise = cursorAcpRemoteLauncher(session);
        await vi.waitFor(() => expect(harness.promptCalls).toBe(1));
        await vi.waitFor(() => client.sendSessionEvent.mock.calls.some(
            (call) => call[0]?.type === 'modelError'
        ));
        await vi.waitFor(() => nextWait.release !== null);

        const recorded = metadata.lastModelError as {
            eventId?: string
            kind?: string
            rawSnippet?: string
        } | undefined;
        expect(recorded?.eventId).toBeTypeOf('string');

        const bridgeHandler = client.rpcHandlerManager.registerHandler.mock.calls.find(
            (call) => call[0] === RPC_METHODS.BridgeModelError
        )?.[1] as ((payload: unknown) => Promise<{ ok: boolean; reason?: string }>) | undefined;
        expect(bridgeHandler).toBeTypeOf('function');
        expect(await bridgeHandler!({
            eventId: recorded?.eventId,
            kind: recorded?.kind ?? 'rate_limited',
            transient: true,
            rawSnippet: recorded?.rawSnippet ?? 'status 429',
            lastUserMessage: 'first',
            priorAssistantClaimsDone: false
        })).toEqual({ ok: true });
        expect(session.queue.queue.some((item) => item.internal?.kind === 'model-error-bridge' && item.internal.eventId === recorded?.eventId)).toBe(true);
        expect(session.queue.pendingLocalIds().some((id) => id.startsWith('bridge:'))).toBe(false);

        // Newer user intent arrives after Bridge is already at the head.
        session.queue.push('correction instead of retry', { permissionMode: 'default' });
        harness.emitStderrOnPrompt = null;
        nextWait.release?.();

        await vi.waitFor(() => expect(harness.promptCalls).toBe(2));
        const secondPrompt = JSON.stringify(harness.prompts[1] ?? []);
        expect(secondPrompt).toContain('correction instead of retry');
        expect(session.queue.queue.some((item) => item.internal?.kind === 'model-error-bridge')).toBe(false);
        // Bridge was dropped (not executed); subsequent Bridge RPC must fail closed.
        expect(await bridgeHandler!({
            eventId: recorded?.eventId,
            kind: recorded?.kind ?? 'rate_limited',
            transient: true,
            rawSnippet: recorded?.rawSnippet ?? 'status 429',
            lastUserMessage: 'first',
            priorAssistantClaimsDone: false
        })).toEqual({ ok: false, reason: 'superseded_by_newer_turn' });

        session.queue.close();
        await launchPromise;
    });

    it('records idle stderr as non-bridgeable so it cannot replay a finished turn', async () => {
        const session = makeSession(null, { keepQueueOpen: true });
        const client = session.client as unknown as {
            rpcHandlerManager: { registerHandler: ReturnType<typeof vi.fn> }
            sendSessionEvent: ReturnType<typeof vi.fn>
            updateMetadata: ReturnType<typeof vi.fn>
        };

        let waitCount = 0;
        const nextWait = { release: null as (() => void) | null };
        const originalWait = session.queue.waitForMessagesAndGetAsString.bind(session.queue);
        session.queue.waitForMessagesAndGetAsString = async (signal) => {
            waitCount += 1;
            if (waitCount >= 2 && nextWait.release === null) {
                await new Promise<void>((resolve) => {
                    nextWait.release = resolve;
                });
            }
            return originalWait(signal);
        };

        session.queue.push('first', { permissionMode: 'default' });
        const launchPromise = cursorAcpRemoteLauncher(session);
        await vi.waitFor(() => expect(harness.promptCalls).toBe(1));
        await vi.waitFor(() => nextWait.release !== null);

        harness.stderrErrorHandler!({
            type: 'rate_limit',
            message: 'Rate limit exceeded.',
            raw: 'status 429 ratelimitexceeded'
        });
        await vi.waitFor(() => client.sendSessionEvent.mock.calls.some(
            (call) => call[0]?.type === 'modelError'
        ));

        const recorded = client.updateMetadata.mock.calls
            .map((c) => {
                const u = c[0] as (m: Record<string, unknown>) => Record<string, unknown>;
                if (typeof u !== 'function') return null;
                return u({}).lastModelError as {
                    eventId?: string
                    bridgeable?: boolean
                } | undefined;
            })
            .find((err) => typeof err?.eventId === 'string');
        expect(recorded?.bridgeable).toBe(false);

        const bridgeHandler = client.rpcHandlerManager.registerHandler.mock.calls.find(
            (call) => call[0] === RPC_METHODS.BridgeModelError
        )?.[1] as ((payload: unknown) => Promise<{ ok: boolean; reason?: string }>) | undefined;

        expect(await bridgeHandler!({
            eventId: recorded?.eventId,
            kind: 'rate_limited',
            transient: true,
            rawSnippet: 'status 429',
            lastUserMessage: 'first',
            priorAssistantClaimsDone: false
        })).toEqual({ ok: false, reason: 'not_bridgeable' });

        session.queue.close();
        nextWait.release?.();
        await launchPromise;
    });

    it('hydrates persisted lastModelError so a post-restart turn supersedes it', async () => {
        const eventId = '33333333-3333-4333-8333-333333333333';
        let metadata: Record<string, unknown> = {
            path: '/tmp/project',
            host: 'localhost',
            lastModelError: {
                eventId,
                atTs: 1000,
                kind: 'rate_limited',
                transient: true,
                rawSnippet: 'status 429',
                priorAssistantClaimsDone: false,
                lastUserMessage: 'old failed turn'
            }
        };

        const session = makeSession(null, { keepQueueOpen: true });
        const client = session.client as unknown as {
            getMetadata: ReturnType<typeof vi.fn>
            updateMetadata: ReturnType<typeof vi.fn>
            rpcHandlerManager: { registerHandler: ReturnType<typeof vi.fn> }
        };
        client.getMetadata.mockImplementation(() => metadata);
        client.updateMetadata.mockImplementation((updater: unknown) => {
            if (typeof updater === 'function') {
                metadata = (updater as (m: Record<string, unknown>) => Record<string, unknown>)(metadata);
            }
        });

        session.queue.push('continue after restart', { permissionMode: 'default' });
        const launchPromise = cursorAcpRemoteLauncher(session);
        await vi.waitFor(() => expect(harness.promptCalls).toBe(1));
        await vi.waitFor(() => {
            const err = metadata.lastModelError as { supersededByUserTurn?: boolean } | undefined;
            expect(err?.supersededByUserTurn).toBe(true);
        });

        const bridgeHandler = client.rpcHandlerManager.registerHandler.mock.calls.find(
            (call) => call[0] === RPC_METHODS.BridgeModelError
        )?.[1] as ((payload: unknown) => Promise<{ ok: boolean; reason?: string }>) | undefined;
        expect(bridgeHandler).toBeTypeOf('function');

        expect(await bridgeHandler!({
            eventId,
            kind: 'rate_limited',
            transient: true,
            rawSnippet: 'status 429',
            lastUserMessage: 'old failed turn',
            priorAssistantClaimsDone: false
        })).toEqual({ ok: false, reason: 'superseded_by_newer_turn' });

        session.queue.close();
        await launchPromise;
    });

    it('rejects bridge after a newer normal turn succeeds', async () => {
        const session = makeSession(null, { keepQueueOpen: true });
        const client = session.client as unknown as {
            rpcHandlerManager: { registerHandler: ReturnType<typeof vi.fn> }
            updateMetadata: ReturnType<typeof vi.fn>
            sendSessionEvent: ReturnType<typeof vi.fn>
        };

        const readLastModelError = (): {
            eventId?: string
            supersededByUserTurn?: boolean
        } | undefined => {
            for (let i = client.updateMetadata.mock.calls.length - 1; i >= 0; i -= 1) {
                const updater = client.updateMetadata.mock.calls[i]?.[0] as
                    | ((m: Record<string, unknown>) => Record<string, unknown>)
                    | undefined;
                if (typeof updater !== 'function') continue;
                const err = updater({}).lastModelError as {
                    eventId?: string
                    supersededByUserTurn?: boolean
                } | undefined;
                if (typeof err?.eventId === 'string') {
                    return err;
                }
            }
            return undefined;
        };

        let waitCount = 0;
        const nextWait = { release: null as (() => void) | null };
        const originalWait = session.queue.waitForMessagesAndGetAsString.bind(session.queue);
        session.queue.waitForMessagesAndGetAsString = async (signal) => {
            waitCount += 1;
            if (waitCount >= 2 && nextWait.release === null) {
                await new Promise<void>((resolve) => {
                    nextWait.release = resolve;
                });
            }
            return originalWait(signal);
        };

        session.queue.push('first', { permissionMode: 'default' });
        const launchPromise = cursorAcpRemoteLauncher(session);
        await vi.waitFor(() => expect(harness.promptCalls).toBe(1));
        await vi.waitFor(() => nextWait.release !== null);

        // Idle structural stderr records a durable modelError (no auto-bridge).
        expect(harness.stderrErrorHandler).toBeTypeOf('function');
        harness.stderrErrorHandler!({
            type: 'rate_limit',
            message: 'Rate limit exceeded.',
            raw: 'status 429 ratelimitexceeded'
        });
        await vi.waitFor(() => client.sendSessionEvent.mock.calls.some(
            (call) => call[0]?.type === 'modelError'
        ));

        const eventId = readLastModelError()?.eventId;
        expect(eventId).toEqual(expect.any(String));

        const bridgeHandler = client.rpcHandlerManager.registerHandler.mock.calls.find(
            (call) => call[0] === RPC_METHODS.BridgeModelError
        )?.[1] as ((payload: unknown) => Promise<{ ok: boolean; reason?: string }>) | undefined;
        expect(bridgeHandler).toBeTypeOf('function');

        // Newer normal turn starts → durable supersededByUserTurn gate.
        session.queue.push('continue without bridging', { permissionMode: 'default' });
        nextWait.release?.();
        await vi.waitFor(() => expect(harness.promptCalls).toBe(2));
        await vi.waitFor(() => readLastModelError()?.supersededByUserTurn === true);

        expect(await bridgeHandler!({
            eventId,
            kind: 'rate_limited',
            transient: true,
            rawSnippet: 'status 429',
            lastUserMessage: 'first',
            priorAssistantClaimsDone: false
        })).toEqual({ ok: false, reason: 'superseded_by_newer_turn' });

        session.queue.close();
        await launchPromise;
    });

    it('cancels a pending bridge when a newer modelError supersedes it', async () => {
        const session = makeSession(null, { keepQueueOpen: true });
        const client = session.client as unknown as {
            rpcHandlerManager: { registerHandler: ReturnType<typeof vi.fn> }
            sendSessionEvent: ReturnType<typeof vi.fn>
        };

        let waitCount = 0;
        const nextWait = { release: null as (() => void) | null };
        const originalWait = session.queue.waitForMessagesAndGetAsString.bind(session.queue);
        session.queue.waitForMessagesAndGetAsString = async (signal) => {
            waitCount += 1;
            if (waitCount >= 2 && nextWait.release === null) {
                await new Promise<void>((resolve) => {
                    nextWait.release = resolve;
                });
            }
            return originalWait(signal);
        };

        session.queue.push('first', { permissionMode: 'default' });
        const launchPromise = cursorAcpRemoteLauncher(session);
        await vi.waitFor(() => expect(harness.promptCalls).toBe(1));
        await vi.waitFor(() => nextWait.release !== null);

        const bridgeHandler = client.rpcHandlerManager.registerHandler.mock.calls.find(
            (call) => call[0] === RPC_METHODS.BridgeModelError
        )?.[1] as ((payload: unknown) => Promise<{ ok: boolean; reason?: string }>) | undefined;

        const staleEventId = '22222222-2222-4222-8222-222222222222';
        expect(await bridgeHandler!({
            eventId: staleEventId,
            kind: 'rate_limited',
            transient: true,
            rawSnippet: 'status 429',
            lastUserMessage: 'first',
            priorAssistantClaimsDone: false
        })).toEqual({ ok: true });
        expect(session.queue.queue.some((item) => item.internal?.kind === 'model-error-bridge' && item.internal.eventId === staleEventId)).toBe(true);
        expect(session.queue.pendingLocalIds().some((id) => id.startsWith('bridge:'))).toBe(false);

        // Idle structural stderr supersedes the displayed error and drops the pending bridge.
        expect(harness.stderrErrorHandler).toBeTypeOf('function');
        harness.stderrErrorHandler!({
            type: 'rate_limit',
            message: 'Rate limit exceeded again.',
            raw: 'status 429 ratelimitexceeded again'
        });
        await vi.waitFor(() => client.sendSessionEvent.mock.calls.some(
            (call) => call[0]?.type === 'modelError'
        ));

        expect(session.queue.queue.some((item) => item.internal?.kind === 'model-error-bridge' && item.internal.eventId === staleEventId)).toBe(false);
        expect(await bridgeHandler!({
            eventId: staleEventId,
            kind: 'rate_limited',
            transient: true,
            rawSnippet: 'status 429',
            lastUserMessage: 'first',
            priorAssistantClaimsDone: false
        })).toEqual({ ok: false, reason: 'model_error_changed' });

        session.queue.close();
        nextWait.release?.();
        await launchPromise;
    });

    it('does not dispatch Bridge session/prompt after a newer turn arrives during pre-send drain', async () => {
        const session = makeSession(null, { keepQueueOpen: true });
        const client = session.client as unknown as {
            rpcHandlerManager: { registerHandler: ReturnType<typeof vi.fn> }
        };

        let waitCount = 0;
        const nextWait = { release: null as (() => void) | null };
        const originalWait = session.queue.waitForMessagesAndGetAsString.bind(session.queue);
        session.queue.waitForMessagesAndGetAsString = async (signal) => {
            waitCount += 1;
            if (waitCount >= 2 && nextWait.release === null) {
                await new Promise<void>((resolve) => {
                    nextWait.release = resolve;
                });
            }
            return originalWait(signal);
        };

        session.queue.push('first', { permissionMode: 'default' });
        const launchPromise = cursorAcpRemoteLauncher(session);
        await vi.waitFor(() => expect(harness.promptSends).toBe(1));
        await vi.waitFor(() => nextWait.release !== null);

        const bridgeHandler = client.rpcHandlerManager.registerHandler.mock.calls.find(
            (call) => call[0] === RPC_METHODS.BridgeModelError
        )?.[1] as ((payload: unknown) => Promise<{ ok: boolean; reason?: string }>) | undefined;

        expect(await bridgeHandler!({
            eventId: '33333333-3333-4333-8333-333333333333',
            kind: 'rate_limited',
            transient: true,
            rawSnippet: 'status 429',
            lastUserMessage: 'first',
            priorAssistantClaimsDone: false
        })).toEqual({ ok: true });

        harness.deferBeforeSend = new Promise<void>((resolve) => {
            harness.releaseBeforeSend = resolve;
        });
        nextWait.release?.();
        await vi.waitFor(() => expect(harness.promptCalls).toBe(2));

        session.queue.push('correction instead of retry', { permissionMode: 'default' });
        harness.releaseBeforeSend?.();

        await vi.waitFor(() => expect(harness.promptSends).toBe(2));
        const dispatched = JSON.stringify(harness.prompts);
        expect(dispatched).not.toContain('[HAPI bridge');
        expect(dispatched).toContain('correction instead of retry');

        session.queue.close();
        await launchPromise;
    });
});

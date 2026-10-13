import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import type { OpencodeMode, PermissionMode } from './types';
import { ACP_INDETERMINATE_SYMBOL } from '@/agent/backends/acp/AcpStdioTransport';

const harness = vi.hoisted(() => ({
    setModelArgs: [] as Array<{ sessionId: string; modelId: string; flavor?: string }>,
    setConfigOptionArgs: [] as Array<{ sessionId: string; configId: string; value: string }>,
    promptCount: 0,
    promptContents: [] as unknown[],
    refreshSessionInfoCalls: [] as Array<{ sessionId: string; cwd: string }>,
    bridgeOptions: null as { enableChangeTitle?: boolean; skillLookup?: { workingDirectory: string; flavor: string } } | null,
    events: [] as string[],
    cleanupEvents: [] as string[],
    setModelImpl: null as null | ((sessionId: string, modelId: string) => Promise<void>),
    setConfigOptionImpl: null as null | ((sessionId: string, configId: string, value: string) => Promise<void>),
    thoughtLevelOption: null as null | { id: string; currentValue?: string; options: Array<{ value: string; name?: string }> },
    // Records the events-array length at each getThoughtLevelConfigOption call,
    // so tests can order lookups against setModel/prompt events without
    // polluting the events list other assertions compare exactly.
    thoughtLevelLookups: [] as number[],
    stderrHandler: null as null | ((error: { type: string; message: string; raw: string }) => void),
    hangPrompt: false,
    resolvePrompt: null as null | (() => void),
    cancelPrompt: vi.fn(async (_sessionId: string) => {}),
    // Lets a test take full manual control of when a given prompt() call
    // resolves, instead of the fixed-one-tick setImmediate delay below —
    // needed to deterministically test ordering against /compact without
    // guessing tick counts.
    promptImpl: null as null | (() => Promise<void>),
    sessionModelsMetadata: undefined as undefined | { currentModelId: string; availableModels: unknown[] },
    // Lets a test hold handleAbort()'s cancelPrompt() call pending, so it
    // can assert something happened *before* handleAbort()'s async teardown
    // finished rather than merely by the time it eventually settles.
    cancelPromptImpl: null as null | (() => Promise<void>),
    // Lets a test hold backend.newSession() pending, to simulate a
    // terminal switch-to-local/exit landing during session initialization
    // — before RPC 'abort'/'switch' handlers even exist (they're only
    // registered once initialization finishes), so that race can only be
    // reproduced via the terminal UI's onExit/onSwitchToLocal callbacks,
    // not rpcHandlers.
    newSessionImpl: null as null | (() => Promise<string>),
    disconnectImpl: null as null | (() => Promise<void>),
    permissionCancelError: null as Error | null,
    serverStopError: null as Error | null,
    eventStreamOptions: [] as Array<{
        baseUrl: string;
        directory: string;
        sessionId: string;
        onRetry: (retry: { attempt: number; message: string }) => void;
    }>,
    eventStreamCloseCount: 0,
    // Soft-steer (mid-turn inject) controls.
    softSteerCalls: [] as Array<{ sessionId: string; content: unknown[] }>,
    softSteerDispatchError: null as Error | null,
    // Lets a test hold beginSoftSteerPrompt()'s dispatched promise pending.
    deferSoftSteerDispatch: null as Promise<void> | null,
    // Lets a test hold the concurrent prompt's completion pending, so
    // "dispatch returned but completion pending" is observable.
    deferSoftSteer: null as Promise<void> | null,
    softSteerThrow: null as Error | null,
    // Lets a test hold the durable dispatching-state write pending, so the
    // foreground prompt can finish (or an abort can land) mid-persistence.
    deferSteerState: null as Promise<void> | null,
    steerStateCalls: [] as Array<{ localIds: string[]; state: string }>,
    steerStateResult: true as boolean,
    promptGeneration: 1,
    abortSoftSteersCalls: 0,
    // Explicit override for isPromptRequestInFlight(); null keeps the
    // events-derived default (true between prompt:start and prompt:end).
    promptRequestInFlight: null as null | boolean
}));

// Captures the RemoteLauncherDisplayContext (including onExit/
// onSwitchToLocal) that RemoteLauncherBase.setupTerminal() passes to
// OpencodeDisplay via ink's render() — but only when `hasTTY` is true, since
// setupTerminal() gates the real render() call on it. None of the other
// tests in this file force isTTY, so this mock is inert for them (render()
// is simply never called) and this hoisted state stays untouched.
const inkHarness = vi.hoisted(() => ({
    lastRenderProps: null as null | { onExit?: () => void | Promise<void>; onSwitchToLocal?: () => void | Promise<void> }
}));

vi.mock('ink', () => ({
    render: vi.fn((element: { props?: { onExit?: () => void | Promise<void>; onSwitchToLocal?: () => void | Promise<void> } }) => {
        inkHarness.lastRenderProps = element.props ?? null;
        return { unmount: () => {} };
    })
}));

vi.mock('./utils/opencodeBackend', () => ({
    allocateFreePort: vi.fn(async () => 48273),
    createOpencodeBackend: vi.fn(() => ({
        initialize: vi.fn(async () => {}),
        newSession: vi.fn(async () => {
            if (harness.newSessionImpl) {
                return harness.newSessionImpl();
            }
            return 'acp-session-1';
        }),
        loadSession: vi.fn(async () => 'acp-session-1'),
        setModel: vi.fn(async (sessionId: string, modelId: string, opts?: { flavor?: string }) => {
            harness.events.push(`setModel:${modelId}`);
            harness.setModelArgs.push({ sessionId, modelId, flavor: opts?.flavor });
            if (harness.setModelImpl) {
                await harness.setModelImpl(sessionId, modelId);
            }
            // Mirror AcpSdkBackend's optimistic currentModelId update for the
            // opencode flavor (see updateCurrentModelOptimistic) so a
            // subsequent getSessionModelsMetadata() call in the same test
            // reflects the switch — needed to verify /compact runs under the
            // model a batch just switched to, not a stale cached one.
            if (harness.sessionModelsMetadata) {
                harness.sessionModelsMetadata = { ...harness.sessionModelsMetadata, currentModelId: modelId };
            }
        }),
        setConfigOption: vi.fn(async (sessionId: string, configId: string, value: string) => {
            harness.events.push(`setConfigOption:${value}`);
            harness.setConfigOptionArgs.push({ sessionId, configId, value });
            if (harness.setConfigOptionImpl) {
                await harness.setConfigOptionImpl(sessionId, configId, value);
            }
            if (harness.thoughtLevelOption) {
                harness.thoughtLevelOption = { ...harness.thoughtLevelOption, currentValue: value };
            }
        }),
        prompt: vi.fn(async (_sessionId: string, content: unknown[]) => {
            harness.promptContents.push(content);
            harness.events.push('prompt:start');
            harness.promptCount++;
            if (harness.hangPrompt) {
                await new Promise<void>((resolve) => {
                    harness.resolvePrompt = resolve;
                });
            } else if (harness.promptImpl) {
                await harness.promptImpl();
            } else {
                await new Promise<void>((resolve) => setImmediate(resolve));
            }
            harness.events.push('prompt:end');
        }),
        isPromptRequestInFlight: vi.fn(() =>
            // The override models the real backend's window where ACP already
            // answered session/prompt but prompt() is still draining updates.
            harness.promptRequestInFlight !== null
                ? harness.promptRequestInFlight
                : harness.events.lastIndexOf('prompt:start') > harness.events.lastIndexOf('prompt:end')
        ),
        cancelPrompt: vi.fn(async (sessionId: string) => {
            await harness.cancelPrompt(sessionId);
            if (harness.cancelPromptImpl) {
                await harness.cancelPromptImpl();
            }
        }),
        getPromptGeneration: vi.fn(() => harness.promptGeneration),
        beginSoftSteerPrompt: vi.fn((sessionId: string, content: unknown[]) => {
            harness.softSteerCalls.push({ sessionId, content });
            if (harness.softSteerThrow) throw harness.softSteerThrow;
            return {
                dispatched: harness.softSteerDispatchError
                    ? Promise.reject(harness.softSteerDispatchError)
                    : (harness.deferSoftSteerDispatch ?? Promise.resolve()),
                completed: harness.deferSoftSteer ?? Promise.resolve()
            };
        }),
        abortSoftSteers: vi.fn(() => { harness.abortSoftSteersCalls++; }),
        respondToPermission: vi.fn(async () => {}),
        onStderrError: vi.fn((handler: (error: { type: string; message: string; raw: string }) => void) => {
            harness.stderrHandler = handler;
        }),
        setSessionInfoUpdateListener: vi.fn(),
        refreshSessionInfo: vi.fn(async (sessionId: string, cwd: string) => {
            harness.refreshSessionInfoCalls.push({ sessionId, cwd });
        }),
        onPermissionRequest: vi.fn(),
        disconnect: vi.fn(async () => {
            harness.cleanupEvents.push('cleanup:disconnect');
            if (harness.disconnectImpl) {
                await harness.disconnectImpl();
            }
        }),
        getSessionModelsMetadata: vi.fn(() => harness.sessionModelsMetadata),
        getThoughtLevelConfigOption: vi.fn(() => {
            harness.thoughtLevelLookups.push(harness.events.length);
            return harness.thoughtLevelOption ?? undefined;
        }),
        // Real AcpSdkBackend.suppressUpdatesDuring swaps out the message
        // handler around `fn`; that detail is irrelevant to these
        // launcher-level tests (which never assert on ACP session/update
        // forwarding), so the stub is a transparent pass-through.
        suppressUpdatesDuring: vi.fn(async <T>(fn: () => Promise<T>): Promise<T> => fn())
    }))
}));

vi.mock('@/codex/utils/buildHapiMcpBridge', () => ({
    buildHapiMcpBridge: async (_client: unknown, options?: { enableChangeTitle?: boolean; skillLookup?: { workingDirectory: string; flavor: string } }) => {
        harness.bridgeOptions = options ?? null;
        return {
            server: { stop: () => { harness.cleanupEvents.push('cleanup:server-stop'); if (harness.serverStopError) throw harness.serverStopError; } },
            mcpServers: {}
        };
    }
}));

vi.mock('./utils/permissionHandler', () => ({
    OpencodePermissionHandler: class {
        async cancelAll(): Promise<void> { harness.cleanupEvents.push('cleanup:permission'); if (harness.permissionCancelError) throw harness.permissionCancelError; }
    }
}));

vi.mock('@/ui/ink/OpencodeDisplay', () => ({
    OpencodeDisplay: () => null
}));

const compactHarness = vi.hoisted(() => ({
    calls: [] as Array<{ baseUrl: string; sessionId: string; providerId: string; modelId: string; signal?: AbortSignal }>,
    operationEvents: [] as string[],
    result: { ok: true } as { ok: true } | { ok: false; error: string },
    markerSnapshotCalls: [] as Array<{ baseUrl: string; sessionId: string; signal?: AbortSignal }>,
    markerSnapshot: { markerIds: ['before-this-request'] } as { markerIds: string[] } | null,
    // Lets tests hold the pre-POST snapshot GET until plain Stop aborts it.
    snapshotImpl: null as null | ((opts: { baseUrl: string; sessionId: string; signal?: AbortSignal }) => Promise<{ markerIds: string[] } | null>),
    resultCalls: [] as Array<{ baseUrl: string; sessionId: string; markerIdsBefore: string[] | null; signal?: AbortSignal }>,
    compactionResult: { status: 'success', text: '## Objective\n- Did the thing' } as
        | { status: 'success'; text: string }
        | { status: 'failed'; reason: string }
        | { status: 'unverified'; reason: string },
    // Lets a test simulate a REST call that only settles once its signal is
    // aborted (mirroring how a real fetch() behaves under AbortSignal) —
    // needed to test that handleAbort() actually unblocks an in-flight
    // /compact instead of the default immediate-resolve behavior below.
    triggerImpl: null as null | ((opts: { baseUrl: string; sessionId: string; providerId: string; modelId: string; signal?: AbortSignal }) => Promise<{ ok: true } | { ok: false; error: string }>),
    // Same idea, for semantic-result GET that runs after a successful POST.
    resultImpl: null as null | ((opts: { baseUrl: string; sessionId: string; markerIdsBefore: string[] | null; signal?: AbortSignal }) => Promise<
        | { status: 'success'; text: string }
        | { status: 'failed'; reason: string }
        | { status: 'unverified'; reason: string }
    >)
}));

// Partial: only the subscription is stubbed. The retry formatter is pure and
// its output is part of what this launcher is asserted to forward.
vi.mock('./utils/opencodeEventStream', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./utils/opencodeEventStream')>()),
    subscribeToOpencodeEvents: vi.fn((options: {
        baseUrl: string;
        directory: string;
        sessionId: string;
        onRetry: (retry: { attempt: number; message: string }) => void;
    }) => {
        harness.eventStreamOptions.push(options);
        return {
            close: () => {
                harness.eventStreamCloseCount++;
            }
        };
    })
}));

vi.mock('./utils/opencodeCompactBridge', () => ({
    splitProviderModel: (combined: string | null | undefined) => {
        if (!combined) return null;
        const idx = combined.indexOf('/');
        if (idx <= 0 || idx === combined.length - 1) return null;
        return { providerId: combined.slice(0, idx), modelId: combined.slice(idx + 1) };
    },
    triggerOpencodeCompact: vi.fn(async (opts: { baseUrl: string; sessionId: string; providerId: string; modelId: string; signal?: AbortSignal }) => {
        compactHarness.operationEvents.push('trigger');
        compactHarness.calls.push(opts);
        if (compactHarness.triggerImpl) {
            return compactHarness.triggerImpl(opts);
        }
        return compactHarness.result;
    }),
    captureCompactionMarkerSnapshot: vi.fn(async (opts: { baseUrl: string; sessionId: string; signal?: AbortSignal }) => {
        compactHarness.operationEvents.push('snapshot');
        compactHarness.markerSnapshotCalls.push(opts);
        if (compactHarness.snapshotImpl) {
            return compactHarness.snapshotImpl(opts);
        }
        return compactHarness.markerSnapshot;
    }),
    fetchCompactionResult: vi.fn(async (opts: { baseUrl: string; sessionId: string; markerIdsBefore: string[] | null; signal?: AbortSignal }) => {
        compactHarness.operationEvents.push('result');
        compactHarness.resultCalls.push(opts);
        if (compactHarness.resultImpl) {
            return compactHarness.resultImpl(opts);
        }
        return compactHarness.compactionResult;
    })
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        warn: vi.fn(),
        info: vi.fn()
    }
}));

import { opencodeRemoteLauncher, selectAbortStatusMessage } from './opencodeRemoteLauncher';

function createMode(model?: string): OpencodeMode {
    return {
        permissionMode: 'default' as PermissionMode,
        model
    };
}

function createPlanMode(model?: string): OpencodeMode {
    return {
        permissionMode: 'plan' as PermissionMode,
        model
    };
}

function createModeWithEffort(model: string | undefined, modelReasoningEffort: string | null): OpencodeMode {
    return {
        permissionMode: 'default' as PermissionMode,
        model,
        modelReasoningEffort
    };
}

function createResetMode(): OpencodeMode {
    return {
        permissionMode: 'default' as PermissionMode,
        model: null
    };
}

function createSessionStub(
    items: Array<{ message: string; mode: OpencodeMode; localId?: string }>,
    opts: { keepOpen?: boolean } = {}
) {
    const queue = new MessageQueue2<OpencodeMode>((mode) => JSON.stringify(mode));
    items.forEach(({ message, mode, localId }, index) => {
        if (index === 0 && items.length > 1) {
            queue.pushIsolateAndClear(message, mode, localId);
        } else {
            queue.push(message, mode, localId);
        }
    });
    // A test simulating a message arriving mid-run (e.g. /compact reaching
    // the queue while an earlier item is still executing) needs to push to
    // this queue after createSessionStub returns, so it can't be closed yet.
    if (!opts.keepOpen) {
        queue.close();
    }

    const sessionEvents: Array<{ type: string; [key: string]: unknown }> = [];
    const sentAgentMessages: unknown[] = [];
    const claudeSessionMessages: unknown[] = [];
    const rpcHandlers = new Map<string, (params: unknown) => unknown>();
    const setModelReasoningEffort = vi.fn();
    const setModel = vi.fn((model: string | null) => {
        session.model = model;
    });
    const pushKeepAlive = vi.fn();
    const emitMessagesConsumedCalls: Array<{ localIds: string[]; options?: { clearQueuedThinkingGrace?: boolean; steered?: boolean } }> = [];
    const thinkingChangeCalls: boolean[] = [];
    const steerIndeterminateCalls: string[][] = [];
    const agentState: Record<string, unknown> = {};
    const steeringActiveCalls: boolean[] = [];
    const steerStateImpl = vi.fn(async (localIds: string[], state: 'queued' | 'dispatching') => {
        harness.steerStateCalls.push({ localIds, state });
        if (harness.deferSteerState) {
            await harness.deferSteerState;
        }
        return harness.steerStateResult;
    });

    const client = {
        rpcHandlerManager: {
            registerHandler(method: string, handler: (params: unknown) => unknown) {
                rpcHandlers.set(method, handler);
            }
        },
        sendAgentMessage(_message: unknown) {},
        sendClaudeSessionMessage(message: unknown) {
            claudeSessionMessages.push(message);
        },
        sendUserMessage(_text: string) {},
        sendSessionEvent(event: { type: string; [key: string]: unknown }) {
            sessionEvents.push(event);
        },
        emitMessagesConsumed(localIds: string[], options?: { clearQueuedThinkingGrace?: boolean; steered?: boolean }) {
            emitMessagesConsumedCalls.push({ localIds, options });
        },
        emitSteerIndeterminate(localIds: string[]) {
            steerIndeterminateCalls.push(localIds);
        },
        updateAgentState(handler: (state: Record<string, unknown>) => Record<string, unknown>) {
            Object.assign(agentState, handler(agentState));
            steeringActiveCalls.push(Boolean(agentState.steeringActive));
        },
        setSteerDeliveryState: steerStateImpl
    };

    const session = {
        path: '/tmp/hapi-opencode-test',
        logPath: '/tmp/hapi-opencode-test/test.log',
        client,
        queue,
        sessionId: null as string | null,
        thinking: false,
        model: null as string | null,
        getPermissionMode() {
            return 'default' as const;
        },
        getModel() {
            return session.model;
        },
        setModel,
        setModelReasoningEffort,
        pushKeepAlive,
        onThinkingChange(thinking: boolean) {
            session.thinking = thinking;
            thinkingChangeCalls.push(thinking);
        },
        onSessionFound(id: string) {
            session.sessionId = id;
        },
        sendAgentMessage(message: unknown) {
            sentAgentMessages.push(message);
        },
        sendSessionEvent(event: { type: string; [key: string]: unknown }) {
            client.sendSessionEvent(event);
        },
        sendUserMessage(_text: string) {}
    };

    return { session, sessionEvents, sentAgentMessages, agentMessages: sentAgentMessages, claudeSessionMessages, rpcHandlers, setModel, setModelReasoningEffort, pushKeepAlive, emitMessagesConsumedCalls, thinkingChangeCalls, steeringActiveCalls, steerIndeterminateCalls, steerStateImpl };
}

function createCompactMode(model?: string): OpencodeMode {
    return {
        permissionMode: 'default' as PermissionMode,
        model,
        operation: 'compact'
    };
}

function createClearMode(): OpencodeMode {
    return {
        permissionMode: 'default' as PermissionMode,
        operation: 'clear'
    };
}

describe('opencodeRemoteLauncher inline model switch', () => {
    afterEach(() => {
        harness.setModelArgs = [];
        harness.setConfigOptionArgs = [];
        harness.promptCount = 0;
        harness.promptContents = [];
        harness.refreshSessionInfoCalls = [];
        harness.bridgeOptions = null;
        harness.events = [];
        harness.cleanupEvents = [];
        harness.setModelImpl = null;
        harness.setConfigOptionImpl = null;
        harness.thoughtLevelOption = null;
        harness.thoughtLevelLookups = [];
        harness.stderrHandler = null;
        harness.hangPrompt = false;
        harness.resolvePrompt = null;
        harness.cancelPrompt.mockClear();
        compactHarness.calls = [];
        compactHarness.operationEvents = [];
        compactHarness.result = { ok: true };
        compactHarness.markerSnapshotCalls = [];
        compactHarness.markerSnapshot = { markerIds: ['before-this-request'] };
        compactHarness.snapshotImpl = null;
        compactHarness.resultCalls = [];
        compactHarness.compactionResult = { status: 'success', text: '## Objective\n- Did the thing' };
        compactHarness.triggerImpl = null;
        compactHarness.resultImpl = null;
        harness.promptImpl = null;
        harness.sessionModelsMetadata = undefined;
        harness.cancelPromptImpl = null;
        harness.newSessionImpl = null;
        harness.disconnectImpl = null;
        harness.permissionCancelError = null;
        harness.serverStopError = null;
        harness.eventStreamOptions = [];
        harness.eventStreamCloseCount = 0;
        harness.stderrHandler = null;
        harness.softSteerCalls = [];
        harness.softSteerDispatchError = null;
        harness.deferSoftSteerDispatch = null;
        harness.deferSoftSteer = null;
        harness.softSteerThrow = null;
        harness.deferSteerState = null;
        harness.steerStateCalls = [];
        harness.steerStateResult = true;
        harness.promptGeneration = 1;
        harness.abortSoftSteersCalls = 0;
        harness.promptRequestInFlight = null;
        inkHarness.lastRenderProps = null;
    });

    it('reaches /clear only after the earlier prompt settles, without starting another OpenCode turn', async () => {
        let resolvePrompt: (() => void) | null = null;
        harness.promptImpl = () => new Promise<void>((resolve) => {
            resolvePrompt = resolve;
        });
        const onClearRequested = vi.fn();
        const onClearCleanupComplete = vi.fn(async () => {});
        const { session } = createSessionStub([
            { message: 'before-clear', mode: createMode() },
            { message: '', mode: createClearMode() }
        ]);

        const launcherPromise = opencodeRemoteLauncher(session as never, { onClearRequested, onClearCleanupComplete });
        while (!harness.events.includes('prompt:start')) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(onClearRequested).not.toHaveBeenCalled();

        resolvePrompt!();
        await launcherPromise;

        expect(harness.events).toEqual(['prompt:start', 'prompt:end']);
        expect(harness.promptCount).toBe(1);
        expect(onClearRequested).toHaveBeenCalledTimes(1);
        expect(onClearCleanupComplete).toHaveBeenCalledTimes(1);
        // The sibling compact test below intentionally inspects its first
        // factory result; do not leave this test's backend instance behind.
        const backendModule = await import('./utils/opencodeBackend');
        (backendModule.createOpencodeBackend as unknown as ReturnType<typeof vi.fn>).mockClear();
    });

    it('reserves before native cleanup but does not complete the transition when cleanup fails', async () => {
        harness.disconnectImpl = async () => {
            throw new Error('disconnect failed');
        };
        const onClearRequested = vi.fn();
        const onClearCleanupComplete = vi.fn(async () => {});
        const onClearCleanupFailed = vi.fn(async () => {});
        const { session } = createSessionStub([
            { message: '', mode: createClearMode() }
        ]);

        await expect(opencodeRemoteLauncher(session as never, { onClearRequested, onClearCleanupComplete, onClearCleanupFailed })).rejects.toThrow('disconnect failed');
        expect(onClearRequested).toHaveBeenCalledTimes(1);
        expect(onClearCleanupComplete).not.toHaveBeenCalled();
        expect(onClearCleanupFailed).toHaveBeenCalledTimes(1);
        const backendModule = await import('./utils/opencodeBackend');
        (backendModule.createOpencodeBackend as unknown as ReturnType<typeof vi.fn>).mockClear();
    });

    it.each(['permission', 'server'] as const)('aborts clear when %s cleanup fails', async (stage) => {
        if (stage === 'permission') harness.permissionCancelError = new Error('permission cleanup failed');
        else harness.serverStopError = new Error('server cleanup failed');
        const onClearRequested = vi.fn(async () => {});
        const onClearCleanupComplete = vi.fn(async () => {});
        const onClearCleanupFailed = vi.fn(async () => {});
        const { session } = createSessionStub([{ message: '', mode: createClearMode() }]);
        await expect(opencodeRemoteLauncher(session as never, {
            onClearRequested, onClearCleanupComplete, onClearCleanupFailed
        })).rejects.toThrow('cleanup failed');
        expect(onClearCleanupFailed).toHaveBeenCalledTimes(1);
        expect(onClearCleanupComplete).not.toHaveBeenCalled();
        expect(harness.cleanupEvents).toEqual(expect.arrayContaining([
            'cleanup:permission', 'cleanup:disconnect', 'cleanup:server-stop'
        ]));
    });

    it('reaches /clear only after an in-flight /compact has completed', async () => {
        harness.sessionModelsMetadata = { currentModelId: 'ollama/x', availableModels: [] };
        let resolveCompact: (() => void) | null = null;
        compactHarness.triggerImpl = () => new Promise((resolve) => {
            resolveCompact = () => resolve({ ok: true });
        });
        const onClearRequested = vi.fn();
        const { session } = createSessionStub([
            { message: '', mode: createCompactMode('ollama/x') },
            { message: '', mode: createClearMode() }
        ]);

        const launcherPromise = opencodeRemoteLauncher(session as never, {
            onCompactAvailabilityChange: () => {},
            onClearRequested
        });
        while (compactHarness.calls.length === 0) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(onClearRequested).not.toHaveBeenCalled();

        resolveCompact!();
        await launcherPromise;

        expect(compactHarness.calls).toHaveLength(1);
        expect(onClearRequested).toHaveBeenCalledTimes(1);
        const backendModule = await import('./utils/opencodeBackend');
        (backendModule.createOpencodeBackend as unknown as ReturnType<typeof vi.fn>).mockClear();
    });

    it('processes a queued /compact operation only after an earlier queued prompt has finished', async () => {
        let resolvePrompt: (() => void) | null = null;
        harness.promptImpl = () => new Promise<void>((resolve) => {
            resolvePrompt = resolve;
        });
        harness.sessionModelsMetadata = { currentModelId: 'ollama/x', availableModels: [] };

        // The compact item is queued right behind the prompt from the start
        // (both pre-populated via createSessionStub) — this is the exact
        // "message A generating, message B (compact) already queued" race a
        // prior design got wrong by running /compact through an
        // externally-invoked trigger instead of this same queue.
        const { session } = createSessionStub([
            { message: 'first', mode: createMode('ollama/x') },
            { message: '', mode: createCompactMode('ollama/x') }
        ]);

        const launcherPromise = opencodeRemoteLauncher(session as never, {
            onCompactAvailabilityChange: () => {}
        });

        // Deterministically wait until the prompt is confirmed in-flight
        // (it will not resolve until we call resolvePrompt below).
        while (!harness.events.includes('prompt:start')) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }

        // Give the loop several ticks to (incorrectly) run the already-queued
        // compact item ahead of the still-running prompt, if the fix weren't
        // in place.
        for (let i = 0; i < 5; i++) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(compactHarness.calls).toEqual([]);
        expect(harness.events).toEqual(['prompt:start']);

        resolvePrompt!();
        await launcherPromise;

        expect(harness.events).toEqual(['prompt:start', 'prompt:end']);
        expect(compactHarness.calls.length).toBe(1);
    });

    it('processes a queued prompt only after an earlier queued /compact operation has finished', async () => {
        harness.sessionModelsMetadata = { currentModelId: 'ollama/x', availableModels: [] };

        const { triggerOpencodeCompact } = await import('./utils/opencodeCompactBridge');
        const triggerMock = triggerOpencodeCompact as unknown as ReturnType<typeof vi.fn>;
        let resolveCompact: (() => void) | null = null;
        triggerMock.mockImplementationOnce((opts: { baseUrl: string; sessionId: string; providerId: string; modelId: string }) => {
            compactHarness.calls.push(opts);
            return new Promise((resolve) => {
                resolveCompact = () => resolve({ ok: true });
            });
        });

        // Compact is queued first this time, with a prompt right behind it.
        const { session } = createSessionStub([
            { message: '', mode: createCompactMode('ollama/x') },
            { message: 'second', mode: createMode('ollama/x') }
        ]);

        const launcherPromise = opencodeRemoteLauncher(session as never, {
            onCompactAvailabilityChange: () => {}
        });

        // Give the main loop plenty of ticks to (incorrectly) start the
        // queued prompt while compact is still in flight.
        for (let i = 0; i < 10; i++) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(compactHarness.calls.length).toBe(1);
        expect(harness.promptCount).toBe(0);

        resolveCompact!();
        await launcherPromise;

        expect(harness.promptCount).toBe(1);
        expect(harness.events).toEqual(['prompt:start', 'prompt:end']);
    });

    it('runs the exact 3-stage scenario reported by HAPI Bot: prompt A generating, prompt B already queued, /compact arrives after — final order is A, B, compact', async () => {
        harness.sessionModelsMetadata = { currentModelId: 'ollama/x', availableModels: [] };
        const resolvers: Array<() => void> = [];
        harness.promptImpl = () => new Promise<void>((resolve) => {
            resolvers.push(resolve);
        });

        // Prompt A and prompt B are both already queued up front. Keep the
        // queue open so /compact can be pushed onto it mid-run, exactly like
        // runOpencode.ts's messageQueue.pushIsolated(...) call would while A
        // is still generating.
        const { session } = createSessionStub([
            { message: 'A', mode: createMode('ollama/x') },
            { message: 'B', mode: createMode('ollama/x') }
        ], { keepOpen: true });

        const launcherPromise = opencodeRemoteLauncher(session as never, {
            onCompactAvailabilityChange: () => {}
        });

        // Wait until prompt A is confirmed in-flight.
        while (!harness.events.includes('prompt:start')) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(harness.promptContents).toEqual([[{ type: 'text', text: expect.stringContaining('A') }]]);

        // /compact arrives now — after B was already queued, while A is
        // still generating.
        session.queue.pushIsolated('', { ...createMode('ollama/x'), operation: 'compact' });
        session.queue.close();

        // Resolve A; B must run to completion before compact fires, even
        // though /compact arrived before B had a chance to be dequeued.
        resolvers[0]!();
        while (harness.promptCount < 2) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(compactHarness.calls).toEqual([]);

        resolvers[1]!();
        await launcherPromise;

        expect(harness.promptContents).toEqual([
            [{ type: 'text', text: expect.stringContaining('A') }],
            [{ type: 'text', text: expect.stringContaining('B') }]
        ]);
        expect(compactHarness.calls.length).toBe(1);
        expect(harness.events).toEqual(['prompt:start', 'prompt:end', 'prompt:start', 'prompt:end']);
    });

    it('cancelling a /compact operation while it is still queued behind a running prompt keeps the REST bridge from ever being called', async () => {
        // Reproduces the exact scenario a PR reviewer bot reported: prompt A
        // is already generating, /compact is queued behind it (not yet
        // dequeued), and the user cancels /compact before A finishes.
        //
        // Note on what this test does and doesn't prove: `queue.cancelByLocalId`
        // removing a still-queued item and the dequeue loop never reaching a
        // removed item both already worked at this (launcher + MessageQueue2)
        // level before the runOpencode.ts fix below — this test would pass
        // either way, since it drives session.queue directly and never goes
        // through runOpencode.ts's onUserMessage/onCancelQueuedMessage
        // handlers. What actually changed with the fix — runOpencode.ts no
        // longer calling session.emitMessagesConsumed([localId]) synchronously
        // the instant /compact is queued, a leftover from when /compact ran
        // via a trigger function outside the queue entirely — is that the hub
        // would otherwise mark the message "invoked" before it was ever
        // dequeued and never ask the CLI to cancel it at all, so the cancel
        // request this test simulates (queue.cancelByLocalId) would never
        // have been *made* in the first place. That RED/GREEN is covered in
        // runOpencode.test.ts ("queues a /compact request..." — asserts
        // emitMessagesConsumed is not called at queue time). This test locks
        // in the launcher-side half of the contract that fix depends on: once
        // a cancel *does* reach the CLI for a still-queued /compact behind a
        // running prompt, the bridge must never be called.
        harness.sessionModelsMetadata = { currentModelId: 'ollama/x', availableModels: [] };
        const resolvers: Array<() => void> = [];
        harness.promptImpl = () => new Promise<void>((resolve) => {
            resolvers.push(resolve);
        });

        const { session } = createSessionStub([
            { message: 'A', mode: createMode('ollama/x') }
        ], { keepOpen: true });

        const launcherPromise = opencodeRemoteLauncher(session as never, {
            onCompactAvailabilityChange: () => {}
        });

        // Wait until prompt A is confirmed in-flight.
        while (!harness.events.includes('prompt:start')) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }

        // /compact is queued behind A while A is still generating — mirrors
        // runOpencode.ts's messageQueue.pushIsolated(...) call for a
        // /compact slash command.
        session.queue.pushIsolated('', { ...createMode('ollama/x'), operation: 'compact' }, 'local-compact');

        // The user cancels /compact before A finishes. It's still sitting
        // in the queue (never dequeued), so this must remove it cleanly —
        // the same call runOpencode.ts's onCancelQueuedMessage makes for any
        // other still-queued item.
        expect(session.queue.cancelByLocalId('local-compact')).toBe(true);
        session.queue.close();

        resolvers[0]!();
        await launcherPromise;

        expect(compactHarness.calls).toEqual([]);
        expect(harness.events).toEqual(['prompt:start', 'prompt:end']);
    });

    it('runs the compact POST callback inside suppression before reporting a verified completion', async () => {
        const opencodeBackendModule = await import('./utils/opencodeBackend');
        const factory = (opencodeBackendModule as unknown as { createOpencodeBackend: ReturnType<typeof vi.fn> }).createOpencodeBackend;
        let inSuppressionCallback = false;
        compactHarness.triggerImpl = async () => {
            expect(inSuppressionCallback).toBe(true);
            return { ok: true };
        };
        factory.mockImplementationOnce(() => ({
            initialize: vi.fn(async () => {}),
            newSession: vi.fn(async () => 'acp-session-1'),
            loadSession: vi.fn(async () => 'acp-session-1'),
            setModel: vi.fn(async () => {}),
            prompt: vi.fn(async () => {}),
            cancelPrompt: vi.fn(async () => {}),
            respondToPermission: vi.fn(async () => {}),
            onStderrError: vi.fn(),
            setSessionInfoUpdateListener: vi.fn(),
            refreshSessionInfo: vi.fn(async () => {}),
            onPermissionRequest: vi.fn(),
            disconnect: vi.fn(async () => {
            if (harness.disconnectImpl) {
                await harness.disconnectImpl();
            }
        }),
            getSessionModelsMetadata: vi.fn(() => ({
                currentModelId: 'ollama/qwen3.6:35b-a3b-q8_0-mtp',
                availableModels: []
            })),
            suppressUpdatesDuring: vi.fn(async <T>(fn: () => Promise<T>): Promise<T> => {
                inSuppressionCallback = true;
                try {
                    return await fn();
                } finally {
                    inSuppressionCallback = false;
                }
            })
        }));

        const { session, sessionEvents } = createSessionStub([
            { message: '', mode: createCompactMode() }
        ]);

        await opencodeRemoteLauncher(session as never);

        expect(compactHarness.operationEvents).toEqual(['snapshot', 'trigger', 'result']);

        expect(compactHarness.calls).toEqual([
            {
                baseUrl: 'http://127.0.0.1:48273',
                sessionId: 'acp-session-1',
                providerId: 'ollama',
                modelId: 'qwen3.6:35b-a3b-q8_0-mtp',
                signal: expect.any(AbortSignal)
            }
        ]);
        const messages = sessionEvents.filter((event) => event.type === 'message').map((event) => event.message);
        expect(messages).toEqual(['📦 Compaction started', '📦 Compaction completed']);

        // The REST bridge call must run inside suppressUpdatesDuring so any
        // session/update notifications OpenCode streams while it's in
        // flight don't leak into the previous turn's onUpdate and render as
        // a duplicate assistant message (see AcpSdkBackend.suppressUpdatesDuring).
        const backendInstance = factory.mock.results[0]?.value as { suppressUpdatesDuring: ReturnType<typeof vi.fn> };
        expect(backendInstance.suppressUpdatesDuring).toHaveBeenCalledTimes(1);
    });

    it('switch-to-local (which reuses handleAbort()) interrupts an in-flight /compact REST call instead of blocking on it until it settles on its own', async () => {
        // Reproduces the exact bug a PR reviewer bot reported: triggerOpencodeCompact
        // is awaited with no way to interrupt it, so Stop/switch-to-local had
        // to wait out the REST call (which is deliberately unbounded — see
        // its doc comment) before the launcher could do anything else. Here
        // the mock REST call only ever settles if its AbortSignal fires,
        // exactly like a real fetch() under AbortSignal — so if handleAbort()
        // (invoked here via the 'switch' RPC, which routes through it before
        // exiting remote mode) doesn't actually abort it, this test times out.
        harness.sessionModelsMetadata = { currentModelId: 'ollama/x', availableModels: [] };
        let capturedSignal: AbortSignal | undefined;
        // Mirrors the real triggerOpencodeCompact's contract (never rejects
        // — an aborted fetch() is caught internally and turned into a
        // structured `{ ok: false }`), just driven by a signal instead of a
        // real network call.
        compactHarness.triggerImpl = (opts) => new Promise((resolve) => {
            capturedSignal = opts.signal;
            opts.signal?.addEventListener('abort', () => {
                resolve({ ok: false, error: 'The operation was aborted.' });
            });
        });

        const { session, sessionEvents, rpcHandlers } = createSessionStub([
            { message: '', mode: createCompactMode('ollama/x') }
        ]);

        const launcherPromise = opencodeRemoteLauncher(session as never, {
            onCompactAvailabilityChange: () => {}
        });

        // Wait until the compact REST call is actually in flight.
        while (compactHarness.calls.length === 0) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(capturedSignal?.aborted).toBe(false);

        const switchHandler = rpcHandlers.get('switch') as (() => Promise<void>) | undefined;
        expect(switchHandler).toBeDefined();

        // Racing against a short timeout is the actual assertion: without
        // the fix, this promise (and therefore the whole launcher) never
        // settles, since the mock REST call above only resolves on abort.
        await Promise.race([
            switchHandler!(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('switch handler (handleAbort) did not return in time')), 2000))
        ]);
        expect(capturedSignal?.aborted).toBe(true);

        // The interrupted operation must not surface a stale result.
        const messages = sessionEvents.filter((event) => event.type === 'message').map((event) => event.message);
        expect(messages).toEqual(['📦 Compaction started']);

        // The launcher must actually be able to leave remote mode — 'switch'
        // sets shouldExit before calling handleAbort(), so once that
        // interruption unblocks runCompactOperation(), the main loop should
        // exit on its own without any further input.
        await Promise.race([
            launcherPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('launcher did not exit remote mode in time')), 2000))
        ]);
    });

    it('a plain Stop aborts the pre-POST marker snapshot GET and skips summarize because no server-side compaction has started', async () => {
        harness.sessionModelsMetadata = { currentModelId: 'ollama/x', availableModels: [] };
        let capturedSignal: AbortSignal | undefined;
        compactHarness.snapshotImpl = (opts) => new Promise((resolve) => {
            capturedSignal = opts.signal;
            opts.signal?.addEventListener('abort', () => resolve(null));
        });

        const { session, sessionEvents, rpcHandlers } = createSessionStub([
            { message: '', mode: createCompactMode('ollama/x') }
        ]);
        const launcherPromise = opencodeRemoteLauncher(session as never, {
            onCompactAvailabilityChange: () => {}
        });

        while (compactHarness.markerSnapshotCalls.length === 0) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(capturedSignal?.aborted).toBe(false);

        const abortHandler = rpcHandlers.get('abort') as (() => Promise<void>) | undefined;
        expect(abortHandler).toBeDefined();
        await Promise.race([
            abortHandler!(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('plain Stop did not settle during snapshot GET')), 2000))
        ]);

        expect(capturedSignal?.aborted).toBe(true);
        expect(compactHarness.calls).toEqual([]);
        expect(session.thinking).toBe(false);
        expect(sessionEvents.filter((event) => event.type === 'message').map((event) => event.message))
            .toEqual(['📦 Compaction started']);
        session.queue.close();
        await Promise.race([
            launcherPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('launcher did not finish after snapshot GET abort')), 2000))
        ]);
    });

    it('a plain Stop aborts the post-POST semantic-result GET because summarize has already completed', async () => {
        harness.sessionModelsMetadata = { currentModelId: 'ollama/x', availableModels: [] };
        let capturedSignal: AbortSignal | undefined;
        compactHarness.resultImpl = (opts) => new Promise((resolve) => {
            capturedSignal = opts.signal;
            opts.signal?.addEventListener('abort', () => {
                resolve({ status: 'unverified', reason: 'Compaction result could not be verified.' });
            });
        });

        const { session, sessionEvents, rpcHandlers } = createSessionStub([
            { message: '', mode: createCompactMode('ollama/x') }
        ]);
        const launcherPromise = opencodeRemoteLauncher(session as never, {
            onCompactAvailabilityChange: () => {}
        });

        while (compactHarness.resultCalls.length === 0) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(capturedSignal?.aborted).toBe(false);
        expect(compactHarness.calls).toHaveLength(1);

        const abortHandler = rpcHandlers.get('abort') as (() => Promise<void>) | undefined;
        expect(abortHandler).toBeDefined();
        await Promise.race([
            abortHandler!(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('plain Stop did not settle during result GET')), 2000))
        ]);

        expect(capturedSignal?.aborted).toBe(true);
        expect(session.thinking).toBe(false);
        expect(sessionEvents.filter((event) => event.type === 'message').map((event) => event.message))
            .toEqual(['📦 Compaction started']);
        session.queue.close();
        await Promise.race([
            launcherPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('launcher did not finish after result GET abort')), 2000))
        ]);
    });

    it('switch-to-local also interrupts an in-flight semantic-result GET (not just the triggerOpencodeCompact POST)', async () => {
        // Reproduces a second PR-review round's finding: the fix above only
        // wired the abort signal through triggerOpencodeCompact (the POST).
        // The semantic-result GET runCompactOperation() calls right after a
        // successful POST still had no way to be interrupted, so
        // Stop/switch-to-local could still block for as long as *that* call
        // took even after the POST-side fix landed. Here the POST resolves
        // immediately (ok:true) and the GET is the one that only settles on
        // abort.
        harness.sessionModelsMetadata = { currentModelId: 'ollama/x', availableModels: [] };
        let capturedSignal: AbortSignal | undefined;
        compactHarness.resultImpl = (opts) => new Promise((resolve) => {
            capturedSignal = opts.signal;
            opts.signal?.addEventListener('abort', () => {
                resolve({ status: 'unverified', reason: 'Compaction result could not be verified.' });
            });
        });

        const { session, sessionEvents, rpcHandlers } = createSessionStub([
            { message: '', mode: createCompactMode('ollama/x') }
        ]);

        const launcherPromise = opencodeRemoteLauncher(session as never, {
            onCompactAvailabilityChange: () => {}
        });

        // Wait until the summary GET is actually in flight (i.e. the POST
        // already resolved successfully).
        while (compactHarness.resultCalls.length === 0) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(capturedSignal?.aborted).toBe(false);

        const switchHandler = rpcHandlers.get('switch') as (() => Promise<void>) | undefined;
        expect(switchHandler).toBeDefined();

        await Promise.race([
            switchHandler!(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('switch handler (handleAbort) did not return in time')), 2000))
        ]);
        expect(capturedSignal?.aborted).toBe(true);

        // No stale "Compaction completed" for an interrupted GET.
        const messages = sessionEvents.filter((event) => event.type === 'message').map((event) => event.message);
        expect(messages).toEqual(['📦 Compaction started']);

        await Promise.race([
            launcherPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('launcher did not exit remote mode in time')), 2000))
        ]);
    });

    it('flips /compact availability to false synchronously the instant switch-to-local begins, before handleAbort()\'s async teardown (e.g. cancelPrompt) finishes', async () => {
        // Reproduces a fourth PR-review round's finding: availability used
        // to only reset on the *next* local-mode entry (loop.ts's
        // `runLocal:` callback), leaving a window between "switch was
        // requested" and "local mode actually started running" where
        // availability was still stale-true. A /compact slash command
        // arriving in that window would still queue normally
        // (runOpencode.ts's `compactSupported` flag hadn't flipped yet) —
        // and since local mode immediately hands back to remote when it
        // finds a non-empty queue, that queued compact could end up running
        // anyway despite the user having already asked to leave remote mode.
        //
        // cancelPrompt() is held pending here specifically so the assertion
        // below happens *during* handleAbort()'s async teardown, not merely
        // by the time the whole thing eventually settles — proving
        // availability flips at the earliest possible synchronous point
        // (requestExit()'s onLeavingRemote() call), not somewhere later in
        // the same unwind.
        let resolveCancelPrompt: (() => void) | null = null;
        harness.cancelPromptImpl = () => new Promise<void>((resolve) => {
            resolveCancelPrompt = resolve;
        });

        const availabilityEvents: boolean[] = [];
        const { session, rpcHandlers } = createSessionStub([], { keepOpen: true });

        const launcherPromise = opencodeRemoteLauncher(session as never, {
            onCompactAvailabilityChange: (available) => availabilityEvents.push(available)
        });

        // Wait until remote signals /compact is available (backend ready,
        // dequeue loop now idle waiting on the empty queue).
        while (!availabilityEvents.includes(true)) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(availabilityEvents).toEqual([true]);

        const switchHandler = rpcHandlers.get('switch') as (() => Promise<void>) | undefined;
        expect(switchHandler).toBeDefined();

        const switchPromise = switchHandler!();

        // Let the synchronous prefix of the switch/requestExit/handleAbort
        // call chain run, then check availability *before* releasing the
        // held cancelPrompt() — i.e. before handleAbort() can possibly have
        // finished.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(resolveCancelPrompt).not.toBeNull();
        expect(availabilityEvents).toEqual([true, false]);

        resolveCancelPrompt!();
        session.queue.close();
        await Promise.race([
            switchPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('switch handler did not settle in time')), 2000))
        ]);
        await Promise.race([
            launcherPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('launcher did not exit remote mode in time')), 2000))
        ]);
    });

    it('never emits a trailing /compact availability(true) if a terminal switch-to-local/exit already ran while session initialization (newSession) was still pending', async () => {
        // A 9th PR-review round found the mirror-image bug to the test
        // above: onCompactAvailabilityChange(true) (right after
        // newSession/loadSession resolves) fires unconditionally — with no
        // way to know a switch/exit already happened *during* that pending
        // ACP round trip. That race can only be reached via the terminal
        // UI's onExit/onSwitchToLocal callbacks (wired up by
        // setupTerminal() before runMainLoop() even starts) — the RPC
        // 'abort'/'switch' handlers below don't exist yet at this point in
        // the sequence (setupAbortHandlers() only runs after
        // newSession/loadSession resolve), so they can't be used to
        // reproduce this specific window.
        //
        // requestExit() sets `this.shouldExit = true` synchronously, before
        // awaiting its handler (see RemoteLauncherBase.requestExit) — so by
        // the time the pending newSession() resolves and this code reaches
        // `onCompactAvailabilityChange?.(true)`, `this.shouldExit` already
        // reflects the switch/exit that happened in between. The bug: that
        // line used to fire regardless, resurrecting availability (and
        // transitively runOpencode.ts's compactSupported) even though the
        // session is on its way out — see that gate's compactTeardownInProgress
        // comment for why compactSupported flipping true makes it get
        // ignored entirely.
        let resolveNewSession: ((id: string) => void) | null = null;
        harness.newSessionImpl = () => new Promise<string>((resolve) => {
            resolveNewSession = resolve;
        });

        const originalStdoutIsTTY = process.stdout.isTTY;
        const originalStdinIsTTY = process.stdin.isTTY;
        Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
        Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
        const originalSetRawMode = (process.stdin as unknown as { setRawMode?: (mode: boolean) => void }).setRawMode;
        const setRawModeStub = vi.fn();
        Object.defineProperty(process.stdin, 'setRawMode', { configurable: true, value: setRawModeStub });

        try {
            const availabilityEvents: boolean[] = [];
            const { session } = createSessionStub([], { keepOpen: true });

            const launcherPromise = opencodeRemoteLauncher(session as never, {
                onCompactAvailabilityChange: (available) => availabilityEvents.push(available)
            });

            // setupTerminal() runs synchronously as the very first thing
            // start() does, before runMainLoop() (and hence before the
            // pending newSession()) gets a chance to run — so by the time
            // control returns here, ink's render() (mocked above) has
            // already captured onExit/onSwitchToLocal.
            expect(inkHarness.lastRenderProps?.onSwitchToLocal).toBeDefined();
            expect(resolveNewSession).toBeNull();
            expect(availabilityEvents).toEqual([]);

            await inkHarness.lastRenderProps!.onSwitchToLocal!();
            // requestExit()'s onLeavingRemote() fires synchronously — but
            // availability was never true yet, so this is the only event
            // so far.
            expect(availabilityEvents).toEqual([false]);

            // Now let the previously-pending newSession() resolve.
            resolveNewSession!('acp-session-late');

            for (let i = 0; i < 10; i++) {
                await new Promise<void>((resolve) => setImmediate(resolve));
            }

            // The fix: no trailing `true` ever gets appended once the
            // previously-pending newSession() resolves.
            expect(availabilityEvents).not.toContain(true);

            session.queue.close();
            await Promise.race([
                launcherPromise,
                new Promise((_, reject) => setTimeout(() => reject(new Error('launcher did not exit remote mode in time')), 2000))
            ]);

            // Final check once the launcher has actually settled — still no
            // `true` anywhere, regardless of how many times the (idempotent,
            // by design — see onLeavingRemote's doc comment) backstop in
            // start()'s finally re-fired `false` along the way.
            expect(availabilityEvents).not.toContain(true);
            expect(availabilityEvents.length).toBeGreaterThan(0);
            expect(availabilityEvents.every((value) => value === false)).toBe(true);
        } finally {
            Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: originalStdoutIsTTY });
            Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: originalStdinIsTTY });
            if (originalSetRawMode) {
                Object.defineProperty(process.stdin, 'setRawMode', { configurable: true, value: originalSetRawMode });
            } else {
                delete (process.stdin as unknown as { setRawMode?: unknown }).setRawMode;
            }
        }
    });

    it('sends the verified compaction summary as a reasoning-type agent message', async () => {
        compactHarness.compactionResult = { status: 'success', text: '## Objective\n- Did the thing' };
        harness.sessionModelsMetadata = { currentModelId: 'ollama/qwen3.6:35b-a3b-q8_0-mtp', availableModels: [] };

        const { session, sentAgentMessages } = createSessionStub([
            { message: '', mode: createCompactMode() }
        ]);

        await opencodeRemoteLauncher(session as never);

        expect(compactHarness.resultCalls).toEqual([
            {
                baseUrl: 'http://127.0.0.1:48273',
                sessionId: 'acp-session-1',
                markerIdsBefore: ['before-this-request'],
                signal: expect.any(AbortSignal)
            }
        ]);
        expect(sentAgentMessages).toEqual([
            { type: 'reasoning', message: '## Objective\n- Did the thing', id: expect.any(String) }
        ]);
    });

    it('does not report completion when HTTP success resolves to the observed empty terminal summary failure', async () => {
        compactHarness.compactionResult = {
            status: 'failed',
            reason: 'OpenCode returned an empty compaction summary.'
        };
        harness.sessionModelsMetadata = { currentModelId: 'ollama/x', availableModels: [] };

        const { session, sessionEvents, sentAgentMessages } = createSessionStub([
            { message: '', mode: createCompactMode('ollama/x') }
        ]);

        await opencodeRemoteLauncher(session as never);

        const messages = sessionEvents.filter((event) => event.type === 'message').map((event) => event.message);
        expect(messages).toEqual([
            '📦 Compaction started',
            '📦 Compaction failed: OpenCode returned an empty compaction summary.'
        ]);
        expect(sentAgentMessages).toEqual([]);
    });

    it('reports an unverified result rather than optimistically completing when association is unavailable', async () => {
        compactHarness.compactionResult = {
            status: 'unverified',
            reason: 'Compaction result could not be verified.'
        };
        harness.sessionModelsMetadata = { currentModelId: 'ollama/x', availableModels: [] };

        const { session, sessionEvents, sentAgentMessages } = createSessionStub([
            { message: '', mode: createCompactMode('ollama/x') }
        ]);

        await opencodeRemoteLauncher(session as never);

        const messages = sessionEvents.filter((event) => event.type === 'message').map((event) => event.message);
        expect(messages).toEqual([
            '📦 Compaction started',
            '📦 Compaction result could not be verified.'
        ]);
        expect(sentAgentMessages).toEqual([]);
    });

    it('never starts the compact at all if isLocalIdCancelled already reports the item cancelled the moment it is dequeued', async () => {
        // isLocalIdCancelled's backing Set (runOpencode.ts's
        // cancelledBeforeEnqueue) can only ever be populated during the
        // brief network round trip between the CLI emitting a queued
        // /compact item's "invoked" ack and the hub recording it — never
        // while the compact REST call is actually running (see that file's
        // doc comment for the full mechanism). So by the time the dequeue
        // loop gets here, a true result unconditionally means this compact
        // was cancelled before its REST request was ever sent — an 8th
        // PR-review round found the pre-start check round 7 added for
        // compactResultSuppressed needed the same treatment here: skip
        // starting the operation entirely rather than sending "📦
        // Compaction started" for a request that's about to be thrown away.
        //
        // A 10th PR-review round found this skip path also never told the
        // hub the queued item was done — session.onThinkingChange(true) is
        // never called here (that's the whole point of skipping), so
        // without an explicit clearQueuedThinkingGrace ack + a final
        // thinking=false keepalive, the web UI spinner could sit stuck for
        // the hub's full 15s queued-thinking grace window.
        harness.sessionModelsMetadata = { currentModelId: 'ollama/x', availableModels: [] };
        const isLocalIdCancelled = vi.fn((id: string) => id === 'compact-1');

        const { session, sessionEvents, sentAgentMessages, emitMessagesConsumedCalls, thinkingChangeCalls } = createSessionStub([
            { message: '', mode: createCompactMode('ollama/x'), localId: 'compact-1' }
        ]);

        await opencodeRemoteLauncher(session as never, { isLocalIdCancelled });

        expect(isLocalIdCancelled).toHaveBeenCalledWith('compact-1');
        expect(compactHarness.calls).toEqual([]);
        const messages = sessionEvents.filter((event) => event.type === 'message').map((event) => event.message);
        expect(messages).toEqual([]);
        expect(sentAgentMessages).toEqual([]);
        expect(emitMessagesConsumedCalls).toEqual([
            { localIds: ['compact-1'], options: { clearQueuedThinkingGrace: true } }
        ]);
        expect(thinkingChangeCalls).toEqual([false]);
    });

    it('never starts the compact (not even the REST bridge call itself) if isLocalIdCancelled already reports the item cancelled the moment it is dequeued, regardless of localId', async () => {
        // Sibling of the test above using an unconditional isLocalIdCancelled
        // (vs. one keyed to a specific id) — doesn't mock triggerOpencodeCompact
        // at all, since the whole point is that it must never be called; doing
        // so also avoids leaking a mockImplementationOnce() that would never
        // get consumed (skip means it's never invoked) into a later test.
        harness.sessionModelsMetadata = { currentModelId: 'ollama/x', availableModels: [] };
        const isLocalIdCancelled = vi.fn(() => true);

        const { session, sessionEvents } = createSessionStub([
            { message: '', mode: createCompactMode('ollama/x'), localId: 'compact-2' }
        ]);

        await opencodeRemoteLauncher(session as never, { isLocalIdCancelled });

        expect(compactHarness.calls).toEqual([]);
        const messages = sessionEvents.filter((event) => event.type === 'message').map((event) => event.message);
        expect(messages).toEqual([]);
    });

    it('does not suppress the result when isLocalIdCancelled reports false', async () => {
        harness.sessionModelsMetadata = { currentModelId: 'ollama/x', availableModels: [] };
        const isLocalIdCancelled = vi.fn(() => false);

        const { session, sessionEvents } = createSessionStub([
            { message: '', mode: createCompactMode('ollama/x'), localId: 'compact-3' }
        ]);

        await opencodeRemoteLauncher(session as never, { isLocalIdCancelled });

        const messages = sessionEvents.filter((event) => event.type === 'message').map((event) => event.message);
        expect(messages).toEqual(['📦 Compaction started', '📦 Compaction completed']);
    });

    it('a plain Stop during an in-flight compact does not unblock the dequeue loop until the operation actually settles server-side, and suppresses the eventual result', async () => {
        // Reproduces the exact scenario a 6th PR-review round reported (and
        // that an earlier round's fix — always aborting compactAbortController
        // on any abort — was rejected for): Stop only interrupts the
        // *client's* HTTP request. The OpenCode server can still be
        // compacting the same session well after that, since session/update
        // notifications are a separate channel from that HTTP request's
        // lifecycle (see AcpSdkBackend.suppressUpdatesDuring's doc comment).
        // If the dequeue loop moved on to the next queued prompt as soon as
        // the client gave up, that prompt could run concurrently with a
        // compaction still touching the same session — breaking the "compact
        // and prompt never touch the session at once" invariant this
        // feature's whole queue-based redesign depends on. This mock's
        // triggerImpl only ever settles when the test explicitly resolves
        // it (standing in for "the server is still working"), never when
        // the client-side signal aborts — so if the fix regressed back to
        // unconditionally aborting on plain Stop, this test would hang/time
        // out rather than merely assert wrong.
        // (handleAbort()'s existing session.queue.reset() call clears any
        // still-queued items regardless of leavingRemote, so this
        // deliberately doesn't rely on a prompt queued behind the compact
        // surviving Stop — that's an orthogonal, pre-existing behavior.
        // Instead it uses the dequeue loop's 'ready' session event — only
        // ever sent from the loop's own finally block, once
        // runCompactOperation() actually returns — as the direct signal that
        // the loop advanced past this operation.)
        harness.sessionModelsMetadata = { currentModelId: 'ollama/x', availableModels: [] };
        let resolveServerSideCompaction: (() => void) | null = null;
        let capturedSignal: AbortSignal | undefined;
        compactHarness.triggerImpl = (opts) => {
            capturedSignal = opts.signal;
            return new Promise((resolve) => {
                resolveServerSideCompaction = () => resolve({ ok: true });
                // Mirrors real triggerOpencodeCompact/fetch() semantics: an
                // aborted signal settles the call too (as a failure) — this
                // is what makes the test meaningfully distinguish "plain
                // Stop leaves the signal alone" from "plain Stop aborts it",
                // rather than both cases merely hanging identically.
                opts.signal?.addEventListener('abort', () => resolve({ ok: false, error: 'aborted' }));
            });
        };

        const { session, sessionEvents, rpcHandlers } = createSessionStub([
            { message: '', mode: createCompactMode('ollama/x') }
        ]);

        const launcherPromise = opencodeRemoteLauncher(session as never, {
            onCompactAvailabilityChange: () => {}
        });

        while (compactHarness.calls.length === 0) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }

        const abortHandler = rpcHandlers.get('abort') as (() => Promise<void>) | undefined;
        expect(abortHandler).toBeDefined();
        await abortHandler!();

        // Plain Stop must NOT abort the client-side signal.
        expect(capturedSignal?.aborted).toBe(false);

        // Several ticks pass — the loop must still be blocked inside
        // runCompactOperation(): no 'ready' event yet, and `thinking` must
        // stay true — nothing has actually stopped yet from the user's
        // perspective, so flipping it false here (as handleAbort used to,
        // unconditionally) would misleadingly suggest otherwise while the
        // server keeps compacting for real.
        for (let i = 0; i < 10; i++) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(sessionEvents.some((event) => event.type === 'ready')).toBe(false);
        expect(session.thinking).toBe(true);

        // The server genuinely finishes now.
        resolveServerSideCompaction!();

        while (!sessionEvents.some((event) => event.type === 'ready')) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }

        // The result must be suppressed — no stale "Compaction completed"
        // for an action the user already asked to abort.
        const messages = sessionEvents.filter((event) => event.type === 'message').map((event) => event.message);
        expect(messages).toEqual(['📦 Compaction started']);

        session.queue.close();
        await launcherPromise;
    });

    it('does not look up a summary when the compact REST call itself failed', async () => {
        harness.sessionModelsMetadata = { currentModelId: 'ollama/x', availableModels: [] };
        const { triggerOpencodeCompact } = await import('./utils/opencodeCompactBridge');
        (triggerOpencodeCompact as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => ({ ok: false, error: 'boom' }));

        const { session, sessionEvents } = createSessionStub([
            { message: '', mode: createCompactMode('ollama/x') }
        ]);

        await opencodeRemoteLauncher(session as never);

        expect(compactHarness.resultCalls).toEqual([]);
        const messages = sessionEvents.filter((event) => event.type === 'message').map((event) => event.message);
        expect(messages).toEqual(['📦 Compaction started', '📦 Compaction failed: boom']);
    });

    it('reports a clear failure when the session has no model metadata', async () => {
        // Default harness mock's getSessionModelsMetadata returns undefined
        // (harness.sessionModelsMetadata stays undefined).
        const { session, sessionEvents } = createSessionStub([
            { message: '', mode: createCompactMode() }
        ]);

        await opencodeRemoteLauncher(session as never);

        expect(compactHarness.calls).toEqual([]);
        const messages = sessionEvents.filter((event) => event.type === 'message').map((event) => event.message);
        expect(messages).toEqual([
            '📦 Compaction started',
            '📦 Compaction failed: OpenCode model metadata is not available; cannot determine provider/model for compaction.'
        ]);
    });

    it('switches the model for a queued /compact operation before running it, same as a prompt turn', async () => {
        // Addresses the reviewer's secondary concern: model/effort switching
        // must apply to a compact batch too, in its actual queue position —
        // not be skipped or applied "outside" the ordering guarantee.
        harness.sessionModelsMetadata = { currentModelId: 'ollama/launch-default', availableModels: [] };

        const { session } = createSessionStub([
            { message: '', mode: createCompactMode('ollama/switched') }
        ]);

        await opencodeRemoteLauncher(session as never);

        expect(harness.setModelArgs).toEqual([
            { sessionId: 'acp-session-1', modelId: 'ollama/switched', flavor: 'opencode' }
        ]);
        // The compact REST call must reflect the just-switched model, not the
        // launch-time default it replaced.
        expect(compactHarness.calls).toEqual([
            {
                baseUrl: 'http://127.0.0.1:48273',
                sessionId: 'acp-session-1',
                providerId: 'ollama',
                modelId: 'switched',
                signal: expect.any(AbortSignal)
            }
        ]);
    });

    it('a switch-to-local firing during the inline model switch prevents the later snapshot/POST from starting', async () => {
        // The controller is created before inline model switching so terminal
        // exit is remembered. The cancellation check before the marker GET
        // must then prevent any delayed compact HTTP work after the switch.
        harness.sessionModelsMetadata = { currentModelId: 'ollama/launch-default', availableModels: [] };
        let resolveSetModel: (() => void) | null = null;
        harness.setModelImpl = () => new Promise<void>((resolve) => {
            resolveSetModel = resolve;
        });

        const { session, rpcHandlers } = createSessionStub([
            { message: '', mode: createCompactMode('ollama/switched') }
        ]);
        const launcherPromise = opencodeRemoteLauncher(session as never, {
            onCompactAvailabilityChange: () => {}
        });

        while (harness.setModelArgs.length === 0) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(compactHarness.markerSnapshotCalls).toEqual([]);
        expect(compactHarness.calls).toEqual([]);

        const switchHandler = rpcHandlers.get('switch') as (() => Promise<void>) | undefined;
        expect(switchHandler).toBeDefined();
        await switchHandler!();
        (resolveSetModel as (() => void) | null)?.();

        await Promise.race([
            launcherPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('launcher did not exit in time')), 2000))
        ]);
        expect(compactHarness.markerSnapshotCalls).toEqual([]);
        expect(compactHarness.calls).toEqual([]);
    });

    it('a plain Stop firing during the inline model switch that precedes a compact batch prevents that compact from ever starting once the switch finishes, instead of unconditionally launching it anyway', async () => {
        // Reproduces a 7th PR-review round finding: compactAbortController
        // is created before the model/effort switch specifically so a
        // Stop/switch/exit landing during that switch has something to act
        // on (see its field doc comment). But a plain Stop only sets
        // compactResultSuppressed — that flag suppresses the eventual
        // RESULT of a request that's already in flight (see
        // runCompactOperation()'s isCancelled()), it does not stop
        // runCompactOperation() itself from being called in the first
        // place. Once the switch resolved, the dequeue loop used to call
        // runCompactOperation() unconditionally regardless — so a compact
        // cancelled *before* its REST request was ever sent would still
        // start a brand new one the instant the switch finished, blocking
        // the dequeue loop for however long that takes despite the user
        // having already cancelled before anything went out. Round 6's
        // "wait for a request that's actually in flight to really finish"
        // invariant only makes sense once a request has actually been sent
        // — there's nothing server-side to wait for here.
        //
        // A 10th PR-review round found this skip path also never told the
        // hub the queued item was done — same fix, same assertions, as the
        // isLocalIdCancelled sibling test above.
        harness.sessionModelsMetadata = { currentModelId: 'ollama/launch-default', availableModels: [] };
        let resolveSetModel: (() => void) | null = null;
        harness.setModelImpl = () => new Promise<void>((resolve) => {
            resolveSetModel = resolve;
        });

        const { session, rpcHandlers, sessionEvents, emitMessagesConsumedCalls, thinkingChangeCalls } = createSessionStub([
            { message: '', mode: createCompactMode('ollama/switched'), localId: 'compact-switch-1' }
        ]);

        const launcherPromise = opencodeRemoteLauncher(session as never, {
            onCompactAvailabilityChange: () => {}
        });

        // Wait until the model switch is actually in flight.
        while (harness.setModelArgs.length === 0) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(compactHarness.calls).toEqual([]);

        const abortHandler = rpcHandlers.get('abort') as (() => Promise<void>) | undefined;
        expect(abortHandler).toBeDefined();
        await abortHandler!();

        // Release the switch — the loop now decides what to do with the
        // compact batch. (Cast re-widens the type: see the sibling test
        // above for why TS narrows this to `never` otherwise.)
        (resolveSetModel as (() => void) | null)?.();

        // Give the loop several ticks to (incorrectly) start the compact
        // anyway, if the fix weren't in place.
        for (let i = 0; i < 10; i++) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }

        expect(compactHarness.calls).toEqual([]);
        // No "Compaction started/completed/failed" at all — the operation
        // never actually began.
        const messages = sessionEvents.filter((event) => event.type === 'message').map((event) => event.message);
        expect(messages).toEqual([]);
        expect(emitMessagesConsumedCalls).toEqual([
            { localIds: ['compact-switch-1'], options: { clearQueuedThinkingGrace: true } }
        ]);
        expect(thinkingChangeCalls).toEqual([false]);

        // The loop went back to waiting on the (now-empty) queue after
        // skipping the cancelled compact — close it so the launcher can
        // exit, same as every other test in this file that reaches the
        // dequeue loop's steady state.
        session.queue.close();
        await Promise.race([
            launcherPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('launcher did not exit in time')), 2000))
        ]);
    });

    it('creates a fresh compactAbortController for each sequential compact operation — no leak or cross-clearing between them', async () => {
        // Backs up the "still same controller" guard in runCompactOperation()'s
        // finally block (which only clears this.compactAbortController if it's
        // still the instance this call created) with an executable check, not
        // just the code comment's claim that two runCompactOperation calls can
        // never overlap. Two isolated /compact items dequeued back-to-back
        // must each get their own independent controller.
        harness.sessionModelsMetadata = { currentModelId: 'ollama/x', availableModels: [] };
        const capturedSignals: AbortSignal[] = [];
        compactHarness.triggerImpl = (opts) => {
            capturedSignals.push(opts.signal!);
            return Promise.resolve({ ok: true });
        };

        const { session } = createSessionStub([], { keepOpen: true });
        session.queue.pushIsolated('', createCompactMode('ollama/x'), 'compact-1');
        session.queue.pushIsolated('', createCompactMode('ollama/x'), 'compact-2');
        session.queue.close();

        await opencodeRemoteLauncher(session as never, { onCompactAvailabilityChange: () => {} });

        expect(capturedSignals.length).toBe(2);
        expect(capturedSignals[0]).not.toBe(capturedSignals[1]);
        // Neither should be left in an aborted state by the other's cleanup.
        expect(capturedSignals[0].aborted).toBe(false);
        expect(capturedSignals[1].aborted).toBe(false);
    });

    it('does not leak compactResultSuppressed into a later compact operation — a Stop-suppressed compact #1 does not silence a normally-completed compact #2', async () => {
        // Companion to the controller-freshness test above: compactAbortController
        // isn't the only piece of per-operation state runCompactOperation()
        // reads — compactResultSuppressed (set by a plain Stop, see
        // handleAbort()'s doc comment) must also be scoped to the operation
        // that was actually Stopped, not linger and silence an unrelated
        // later compact that completes normally.
        harness.sessionModelsMetadata = { currentModelId: 'ollama/x', availableModels: [] };
        let resolveFirstCompaction: (() => void) | null = null;
        compactHarness.triggerImpl = (opts) => {
            const callIndex = compactHarness.calls.length;
            if (callIndex === 1) {
                // First call: hangs until the test explicitly resolves it,
                // standing in for "the server is still compacting" — same
                // pattern as the plain-Stop-blocking test above.
                return new Promise((resolve) => {
                    resolveFirstCompaction = () => resolve({ ok: true });
                });
            }
            return Promise.resolve({ ok: true });
        };

        // compact #2 is deliberately pushed *after* Stop below, not
        // upfront: handleAbort() unconditionally calls session.queue.reset(),
        // which would otherwise clear it before it's ever dequeued (an
        // orthogonal, pre-existing behavior — see the plain-Stop-blocking
        // test above's comment on the same point).
        const { session, sessionEvents, rpcHandlers } = createSessionStub([], { keepOpen: true });
        session.queue.pushIsolated('', createCompactMode('ollama/x'), 'compact-1');

        const launcherPromise = opencodeRemoteLauncher(session as never, { onCompactAvailabilityChange: () => {} });

        while (compactHarness.calls.length === 0) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }

        const abortHandler = rpcHandlers.get('abort') as (() => Promise<void>) | undefined;
        expect(abortHandler).toBeDefined();
        await abortHandler!();

        session.queue.pushIsolated('', createCompactMode('ollama/x'), 'compact-2');
        session.queue.close();

        // Compact #1 genuinely finishes now — its result must stay suppressed.
        resolveFirstCompaction!();

        // Wait for compact #2 to actually run and finish too.
        while (compactHarness.calls.length < 2) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        await launcherPromise;

        const messages = sessionEvents.filter((event) => event.type === 'message').map((event) => event.message);
        expect(messages).toEqual([
            '📦 Compaction started', // compact #1
            '📦 Compaction started', // compact #2
            '📦 Compaction completed' // compact #2's result, NOT suppressed by #1's Stop
        ]);
    });

    it('injects the skill lookup instruction only on the first prompt', async () => {
        const { session } = createSessionStub([
            { message: 'first', mode: createMode() },
            { message: 'second', mode: createMode() }
        ]);

        await opencodeRemoteLauncher(session as never);

        expect(JSON.stringify(harness.promptContents[0])).toContain('$name');
        expect(JSON.stringify(harness.promptContents[0])).toContain('skill_lookup');
        expect(JSON.stringify(harness.promptContents[0])).toContain('hapi_display_image');
        expect(JSON.stringify(harness.promptContents[0])).not.toContain('hapi_change_title');
        expect(JSON.stringify(harness.promptContents[1])).not.toContain('skill_lookup');
    });

    it('spawns the ACP backend with an explicit --port/--hostname from allocateFreePort', async () => {
        const { session } = createSessionStub([
            { message: 'first', mode: createMode() }
        ]);

        await opencodeRemoteLauncher(session as never);

        const opencodeBackendModule = await import('./utils/opencodeBackend');
        const factory = (opencodeBackendModule as unknown as { createOpencodeBackend: ReturnType<typeof vi.fn> }).createOpencodeBackend;
        const lastCall = factory.mock.calls.at(-1)?.[0] as { cwd?: string; port?: number; hostname?: string };
        expect(lastCall.port).toBe(48273);
        expect(lastCall.hostname).toBe('127.0.0.1');
    });

    it('applies the requested startup model eagerly so thought_level is discoverable before the first turn', async () => {
        // The OpenCode CLI was launched with --model hy3-free, but the ACP
        // session's own default (mirrored into the metadata) is big-pickle.
        harness.sessionModelsMetadata = { currentModelId: 'opencode/big-pickle', availableModels: [] };
        harness.thoughtLevelOption = {
            id: 'effort',
            currentValue: 'low',
            options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }]
        };
        const { session } = createSessionStub([
            { message: 'first', mode: createModeWithEffort(undefined, 'high') }
        ]);
        session.model = 'opencode/hy3-free';

        await opencodeRemoteLauncher(session as never);

        expect(harness.setModelArgs).toEqual([
            { sessionId: 'acp-session-1', modelId: 'opencode/hy3-free', flavor: 'opencode' }
        ]);
        // The effort lookup that seeds currentBackendEffort must run *after*
        // the eager setModel, so it observes the new model's thought_level.
        const eagerModelIndex = harness.events.indexOf('setModel:opencode/hy3-free');
        expect(eagerModelIndex).toBeGreaterThanOrEqual(0);
        const lookupAfterEager = harness.thoughtLevelLookups.find((at) => at > eagerModelIndex);
        expect(lookupAfterEager).toBeDefined();
        expect(lookupAfterEager!).toBeLessThan(harness.events.indexOf('prompt:start'));
    });

    it('ignores an eager startup model failure and lets the first batch retry inline', async () => {
        let eagerFailed = false;
        harness.setModelImpl = async () => {
            if (!eagerFailed) {
                eagerFailed = true;
                throw new Error('Transient backend failure');
            }
        };
        harness.sessionModelsMetadata = { currentModelId: 'opencode/big-pickle', availableModels: [] };
        harness.thoughtLevelOption = {
            id: 'effort',
            currentValue: 'low',
            options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }]
        };
        const { session, sessionEvents } = createSessionStub([
            { message: 'first', mode: createMode('opencode/hy3-free') }
        ]);
        session.model = 'opencode/hy3-free';

        await opencodeRemoteLauncher(session as never);

        // Eager attempt happened once and failed; the first batch then retried
        // via the existing inline switch path.
        expect(harness.setModelArgs).toEqual([
            { sessionId: 'acp-session-1', modelId: 'opencode/hy3-free', flavor: 'opencode' },
            { sessionId: 'acp-session-1', modelId: 'opencode/hy3-free', flavor: 'opencode' }
        ]);
        // The inline switch must also refresh the cached effort from the fresh
        // thought_level options (set_config_option changes the backend's
        // effort currentValue).
        const inlineSwitchIndex = harness.events.lastIndexOf('setModel:opencode/hy3-free');
        const lookupAfterInline = harness.thoughtLevelLookups.find((at) => at > inlineSwitchIndex);
        expect(lookupAfterInline).toBeDefined();
        // The eager attempt failed, but the inline retry succeeded — so the
        // user never sees a "Failed to switch model" notice.
        const failureNotices = sessionEvents.filter(
            (event) => event.type === 'message' && typeof event.message === 'string' && event.message.includes('Failed to switch model')
        );
        expect(failureNotices.length).toBe(0);
        expect(harness.promptCount).toBe(1);
    });

    it('does not call setModel when the requested startup model matches the session default', async () => {
        harness.sessionModelsMetadata = { currentModelId: 'ollama/x', availableModels: [] };
        const { session } = createSessionStub([
            { message: 'first', mode: createMode('ollama/x') }
        ]);
        session.model = 'ollama/x';

        await opencodeRemoteLauncher(session as never);

        expect(harness.setModelArgs).toEqual([]);
        expect(harness.promptCount).toBe(1);
    });

    it('calls setModel with opencode flavor between turns when the queued model differs', async () => {
        const { session } = createSessionStub([
            { message: 'first', mode: createMode('ollama/exaone:4.5-33b-q8') },
            { message: 'second', mode: createMode('mlx/qwen3:0.6b') }
        ]);

        await opencodeRemoteLauncher(session as never);

        expect(harness.bridgeOptions).toEqual({
            enableChangeTitle: false,
            skillLookup: { workingDirectory: '/tmp/hapi-opencode-test', flavor: 'opencode' }
        });
        expect(harness.refreshSessionInfoCalls).toEqual([
            { sessionId: 'acp-session-1', cwd: '/tmp/hapi-opencode-test' },
            { sessionId: 'acp-session-1', cwd: '/tmp/hapi-opencode-test' }
        ]);

        expect(harness.setModelArgs).toEqual([
            { sessionId: 'acp-session-1', modelId: 'mlx/qwen3:0.6b', flavor: 'opencode' }
        ]);
        expect(harness.promptCount).toBe(2);
    });

    it('does not call setModel when the model is unchanged across turns', async () => {
        const { session } = createSessionStub([
            { message: 'first', mode: createMode('ollama/exaone:4.5-33b-q8') },
            { message: 'second', mode: createMode('ollama/exaone:4.5-33b-q8') }
        ]);

        await opencodeRemoteLauncher(session as never);

        expect(harness.setModelArgs).toEqual([]);
        expect(harness.promptCount).toBe(2);
    });

    it('latches inline switching off after a method-not-found response and notifies the user once', async () => {
        harness.setModelImpl = async () => {
            throw new Error('Method not found: session/set_model');
        };
        const { session, sessionEvents } = createSessionStub([
            { message: 'first', mode: createMode('ollama/a') },
            { message: 'second', mode: createMode('ollama/b') },
            { message: 'third', mode: createMode('ollama/c') }
        ]);

        await opencodeRemoteLauncher(session as never);

        // Only one setModel attempt — latched off after the first method-not-found
        expect(harness.setModelArgs).toEqual([
            { sessionId: 'acp-session-1', modelId: 'ollama/b', flavor: 'opencode' }
        ]);
        const unsupportedMessages = sessionEvents.filter(
            (event) =>
                event.type === 'message' &&
                typeof event.message === 'string' &&
                event.message.includes('does not support inline model switching')
        );
        expect(unsupportedMessages.length).toBe(1);
        expect(harness.promptCount).toBe(3);
    });

    it('reports a transient setModel error and continues with the previous model', async () => {
        harness.sessionModelsMetadata = { currentModelId: 'ollama/a', availableModels: [] };
        let attempts = 0;
        harness.setModelImpl = async () => {
            attempts++;
            throw new Error('Transient backend failure');
        };
        const { session, sessionEvents, setModel, pushKeepAlive } = createSessionStub([
            { message: 'first', mode: createMode('ollama/a') },
            { message: 'second', mode: createMode('ollama/b') }
        ]);
        const rollbacks: Array<string | null> = [];

        await opencodeRemoteLauncher(session as never, {
            onModelRollback: (model) => rollbacks.push(model)
        });

        expect(attempts).toBe(1);
        const failureMessages = sessionEvents.filter(
            (event) =>
                event.type === 'message' &&
                typeof event.message === 'string' &&
                event.message.includes('Failed to switch model')
        );
        expect(failureMessages.length).toBe(1);
        expect(failureMessages[0]?.message).toContain('ollama/b');
        expect(setModel).toHaveBeenCalledWith('ollama/a');
        expect(session.model).toBe('ollama/a');
        expect(pushKeepAlive).toHaveBeenCalledTimes(1);
        expect(rollbacks).toEqual(['ollama/a']);
        expect(harness.promptCount).toBe(2);
    });

    it('rejects unsupported reasoning effort values before calling setConfigOption', async () => {
        harness.thoughtLevelOption = {
            id: 'effort',
            currentValue: 'low',
            options: [
                { value: 'low', name: 'Low' },
                { value: 'medium', name: 'Medium' }
            ]
        };
        const { session, setModelReasoningEffort } = createSessionStub([
            { message: 'first', mode: createModeWithEffort(undefined, 'high') }
        ]);

        await opencodeRemoteLauncher(session as never);

        expect(harness.setConfigOptionArgs).toEqual([]);
        expect(setModelReasoningEffort).toHaveBeenCalledWith('low');
        expect(harness.promptCount).toBe(1);
    });

    it('syncs hub effort state after coercing an unsupported request to a different supported value', async () => {
        harness.thoughtLevelOption = {
            id: 'effort',
            currentValue: 'high',
            options: [
                { value: 'low', name: 'Low' },
                { value: 'medium', name: 'Medium' }
            ]
        };
        const { session, setModelReasoningEffort, pushKeepAlive } = createSessionStub([
            { message: 'first', mode: createModeWithEffort(undefined, 'max') }
        ]);

        await opencodeRemoteLauncher(session as never);

        expect(harness.setConfigOptionArgs).toEqual([
            { sessionId: 'acp-session-1', configId: 'effort', value: 'low' }
        ]);
        expect(setModelReasoningEffort).toHaveBeenCalledWith('low');
        expect(pushKeepAlive).toHaveBeenCalledTimes(1);
        expect(harness.promptCount).toBe(1);
    });

    it('resets to the backend launch-time default model when the queued mode.model is null', async () => {
        // Seed the backend with a launch-time default model so the launcher
        // captures it as `defaultBackendModel`. Without that, `/model default`
        // resolves to null and the launcher has nothing to switch back to.
        const opencodeBackendModule = await import('./utils/opencodeBackend');
        const factory = (opencodeBackendModule as unknown as { createOpencodeBackend: ReturnType<typeof vi.fn> }).createOpencodeBackend;
        const originalImpl = factory.getMockImplementation();
        factory.mockImplementationOnce(() => {
            const backend = (originalImpl as () => Record<string, unknown>)();
            backend.getSessionModelsMetadata = vi.fn(() => ({
                currentModelId: 'ollama/launch-default',
                availableModels: []
            }));
            return backend;
        });

        const { session } = createSessionStub([
            { message: 'first', mode: createMode('ollama/custom') },
            { message: 'second', mode: createResetMode() }
        ]);

        await opencodeRemoteLauncher(session as never);

        // Switch to custom on turn 1, then back to the launch-time default on turn 2.
        expect(harness.setModelArgs).toEqual([
            { sessionId: 'acp-session-1', modelId: 'ollama/custom', flavor: 'opencode' },
            { sessionId: 'acp-session-1', modelId: 'ollama/launch-default', flavor: 'opencode' }
        ]);
        expect(harness.promptCount).toBe(2);
    });

    it('calls setConfigOption for OpenCode reasoning effort changes', async () => {
        harness.thoughtLevelOption = {
            id: 'effort',
            currentValue: 'low',
            options: [
                { value: 'low', name: 'Low' },
                { value: 'high', name: 'High' }
            ]
        };
        const { session } = createSessionStub([
            { message: 'first', mode: createModeWithEffort(undefined, 'high') }
        ]);

        await opencodeRemoteLauncher(session as never);

        expect(harness.setConfigOptionArgs).toEqual([
            { sessionId: 'acp-session-1', configId: 'effort', value: 'high' }
        ]);
        expect(harness.promptCount).toBe(1);
    });

    it('rolls back session reasoning effort when OpenCode rejects the switch', async () => {
        harness.thoughtLevelOption = {
            id: 'effort',
            currentValue: 'low',
            options: [
                { value: 'low', name: 'Low' },
                { value: 'high', name: 'High' }
            ]
        };
        harness.setConfigOptionImpl = async () => {
            throw new Error('Transient backend failure');
        };
        const { session, sessionEvents, setModelReasoningEffort, pushKeepAlive } = createSessionStub([
            { message: 'first', mode: createModeWithEffort(undefined, 'high') }
        ]);
        const rollbacks: Array<string | null> = [];

        await opencodeRemoteLauncher(session as never, {
            onReasoningEffortRollback: (effort) => rollbacks.push(effort)
        });

        expect(harness.setConfigOptionArgs).toEqual([
            { sessionId: 'acp-session-1', configId: 'effort', value: 'high' }
        ]);
        expect(setModelReasoningEffort).toHaveBeenCalledWith('low');
        expect(pushKeepAlive).toHaveBeenCalledTimes(1);
        expect(rollbacks).toEqual(['low']);
        expect(sessionEvents.some(
            (event) => event.type === 'message'
                && typeof event.message === 'string'
                && event.message.includes('Failed to switch reasoning effort')
        )).toBe(true);
        expect(harness.promptCount).toBe(1);
    });

    it('injects plan-mode instructions into plan turns', async () => {
        const { session } = createSessionStub([
            { message: 'design the fix', mode: createPlanMode() }
        ]);

        await opencodeRemoteLauncher(session as never);

        const content = harness.promptContents[0] as Array<{ type: string; text: string }>;
        expect(content[0]?.text).toContain('You are in plan mode');
        expect(content[0]?.text).toContain('Do not execute tools');
        expect(content[0]?.text).toContain('design the fix');
        expect(content[0]?.text).not.toContain('hapi_change_title');
    });

    it('registers a listOpencodeModels RPC handler that returns the backend cache', async () => {
        // Override getSessionModelsMetadata for this run only.
        const fixtureModels = [
            { modelId: 'ollama/exaone:4.5-33b-q8', name: 'Ollama EXAONE' },
            { modelId: 'mlx/qwen3:0.6b', name: 'MLX Qwen3' }
        ];
        const opencodeBackendModule = await import('./utils/opencodeBackend');
        const factory = (opencodeBackendModule as unknown as { createOpencodeBackend: ReturnType<typeof vi.fn> }).createOpencodeBackend;
        factory.mockImplementationOnce(() => ({
            initialize: vi.fn(async () => {}),
            newSession: vi.fn(async () => 'acp-session-1'),
            loadSession: vi.fn(async () => 'acp-session-1'),
            setModel: vi.fn(async () => {}),
            prompt: vi.fn(async () => {}),
            cancelPrompt: vi.fn(async () => {}),
            respondToPermission: vi.fn(async () => {}),
            onStderrError: vi.fn(),
            setSessionInfoUpdateListener: vi.fn(),
            refreshSessionInfo: vi.fn(async () => {}),
            onPermissionRequest: vi.fn(),
            disconnect: vi.fn(async () => {
            if (harness.disconnectImpl) {
                await harness.disconnectImpl();
            }
        }),
            getSessionModelsMetadata: vi.fn((sessionId: string) => {
                if (sessionId === 'acp-session-1') {
                    return { availableModels: fixtureModels, currentModelId: 'ollama/exaone:4.5-33b-q8' };
                }
                return undefined;
            })
        }));

        const { session, rpcHandlers } = createSessionStub([
            { message: 'first', mode: createMode('ollama/exaone:4.5-33b-q8') }
        ]);
        await opencodeRemoteLauncher(session as never);

        const handler = rpcHandlers.get('listOpencodeModels');
        expect(handler).toBeDefined();
        const result = await handler!(undefined) as Record<string, unknown>;
        expect(result).toEqual({
            success: true,
            availableModels: fixtureModels,
            currentModelId: 'ollama/exaone:4.5-33b-q8'
        });
    });

    it('listOpencodeModels handler returns unavailable when backend has no metadata', async () => {
        const { session, rpcHandlers } = createSessionStub([
            { message: 'first', mode: createMode() }
        ]);
        await opencodeRemoteLauncher(session as never);

        const handler = rpcHandlers.get('listOpencodeModels');
        expect(handler).toBeDefined();
        const result = await handler!(undefined) as Record<string, unknown>;
        expect(result).toEqual({
            success: false,
            error: 'OpenCode model metadata is not available'
        });
    });

    it('registers a listOpencodeReasoningEffortOptions RPC handler that returns ACP options', async () => {
        harness.thoughtLevelOption = {
            id: 'effort',
            currentValue: 'low',
            options: [
                { value: 'low', name: 'Low' },
                { value: 'medium', name: 'Medium' }
            ]
        };
        const { session, rpcHandlers } = createSessionStub([
            { message: 'first', mode: createMode() }
        ]);
        await opencodeRemoteLauncher(session as never);

        const handler = rpcHandlers.get('listOpencodeReasoningEffortOptions');
        expect(handler).toBeDefined();
        const result = await handler!(undefined) as Record<string, unknown>;
        expect(result).toEqual({
            success: true,
            options: [
                { value: 'low', name: 'Low' },
                { value: 'medium', name: 'Medium' }
            ],
            currentValue: 'low',
            currentModelId: null,
            targetModelId: null
        });
    });

    it('listOpencodeReasoningEffortOptions handler returns unavailable when backend has no thought level option', async () => {
        harness.sessionModelsMetadata = { currentModelId: 'opencode/big-pickle', availableModels: [] };
        const { session, rpcHandlers } = createSessionStub([
            { message: 'first', mode: createMode() }
        ]);
        await opencodeRemoteLauncher(session as never);

        const handler = rpcHandlers.get('listOpencodeReasoningEffortOptions');
        expect(handler).toBeDefined();
        const result = await handler!(undefined) as Record<string, unknown>;
        expect(result).toEqual({
            success: false,
            error: 'OpenCode reasoning effort options are not available',
            currentModelId: 'opencode/big-pickle',
            targetModelId: 'opencode/big-pickle'
        });
    });

    it('reports the resolved default target while the backend still uses the previous model', async () => {
        harness.sessionModelsMetadata = { currentModelId: 'opencode/default', availableModels: [] };
        const { session, rpcHandlers } = createSessionStub([
            { message: 'first', mode: createMode() }
        ]);
        await opencodeRemoteLauncher(session as never);

        harness.sessionModelsMetadata = { currentModelId: 'opencode/previous', availableModels: [] };
        const result = await rpcHandlers.get('listOpencodeReasoningEffortOptions')!(undefined) as Record<string, unknown>;
        expect(result).toMatchObject({
            currentModelId: 'opencode/previous',
            targetModelId: 'opencode/default'
        });
    });

    it('reports a stall stderr error only once per prompt', async () => {
        harness.hangPrompt = true;
        const { session, agentMessages } = createSessionStub([
            { message: 'first', mode: createMode() }
        ]);

        const launchPromise = opencodeRemoteLauncher(session as never);
        await vi.waitFor(() => expect(harness.events).toContain('prompt:start'));
        expect(session.thinking).toBe(true);
        expect(harness.stderrHandler).toBeTypeOf('function');

        harness.stderrHandler!({
            type: 'quota_exceeded',
            message: 'API quota exceeded. Please check your billing or wait for quota reset.',
            raw: 'quota exceeded for provider'
        });
        harness.stderrHandler!({
            type: 'quota_exceeded',
            message: 'Retrying after quota error.',
            raw: 'retrying in 30 seconds'
        });

        expect(session.thinking).toBe(false);
        expect(harness.cancelPrompt).toHaveBeenCalledTimes(1);
        expect(harness.cancelPrompt).toHaveBeenCalledWith('acp-session-1');
        expect(agentMessages).toEqual([{
            type: 'error',
            message: 'API quota exceeded. Please check your billing or wait for quota reset.'
        }]);

        harness.resolvePrompt!();
        await launchPromise;
    });

    it('routes HTTP/2 cancel stderr through the error agent message pipeline', async () => {
        harness.hangPrompt = true;
        const { session, agentMessages } = createSessionStub([
            { message: 'first', mode: createMode() }
        ]);

        const launchPromise = opencodeRemoteLauncher(session as never);
        await vi.waitFor(() => expect(harness.stderrHandler).toBeTypeOf('function'));

        const message = 'Error: T: [canceled] http/2 stream closed with error code CANCEL (0x8)';
        harness.stderrHandler!({
            type: 'unknown',
            message,
            raw: message
        });

        expect(session.thinking).toBe(false);
        expect(harness.cancelPrompt).toHaveBeenCalledWith('acp-session-1');
        expect(agentMessages).toContainEqual({ type: 'error', message });

        harness.resolvePrompt!();
        await launchPromise;
    });

    it('surfaces non-stall stderr as error without clearing thinking or canceling prompt', async () => {
        harness.hangPrompt = true;
        const { session, agentMessages } = createSessionStub([
            { message: 'first', mode: createMode() }
        ]);

        const launchPromise = opencodeRemoteLauncher(session as never);
        await vi.waitFor(() => expect(harness.events).toContain('prompt:start'));
        expect(session.thinking).toBe(true);

        harness.stderrHandler!({
            type: 'authentication',
            message: 'Authentication failed. Please check your credentials.',
            raw: 'status 401 unauthenticated'
        });

        expect(session.thinking).toBe(true);
        expect(harness.cancelPrompt).not.toHaveBeenCalled();
        expect(agentMessages).toContainEqual({
            type: 'error',
            message: 'Authentication failed. Please check your credentials.'
        });

        harness.resolvePrompt!();
        await launchPromise;
    });

    it('subscribes to the agent event stream for this session and directory, and closes it on teardown', async () => {
        const { session } = createSessionStub([
            { message: 'first', mode: createMode() }
        ]);

        await opencodeRemoteLauncher(session as never);

        expect(harness.eventStreamOptions).toHaveLength(1);
        expect(harness.eventStreamOptions[0]).toMatchObject({
            baseUrl: 'http://127.0.0.1:48273',
            // Without the directory the endpoint reports nothing at all, and
            // says so with neither an error nor a 404.
            directory: '/tmp/hapi-opencode-test',
            sessionId: 'acp-session-1'
        });
        // A stream left open would keep reconnecting to a process that is gone.
        expect(harness.eventStreamCloseCount).toBe(1);
    });

    it('reports an upstream retry as progress carrying the provider text, not as a failure', async () => {
        harness.hangPrompt = true;
        const { session, agentMessages, claudeSessionMessages, thinkingChangeCalls } = createSessionStub([
            { message: 'first', mode: createMode() }
        ]);

        const launchPromise = opencodeRemoteLauncher(session as never);
        await vi.waitFor(() => expect(harness.eventStreamOptions).toHaveLength(1));
        await vi.waitFor(() => expect(harness.events).toContain('prompt:start'));

        harness.eventStreamOptions[0].onRetry({
            attempt: 2,
            message: 'Rate limit exceeded: free-models-per-day.'
        });

        // Sent on the api_error channel the web timeline folds, not the error
        // channel — the agent is still working.
        expect(agentMessages).toEqual([]);
        expect(claudeSessionMessages).toHaveLength(1);
        expect(claudeSessionMessages[0]).toMatchObject({
            type: 'system',
            subtype: 'api_error',
            retryAttempt: 2,
            maxRetries: 0
        });
        // The provider's own words survive; without them the timeline says
        // only "Retrying...".
        const error = (claudeSessionMessages[0] as { error: { message: string } }).error;
        expect(error.message).toContain('Rate limit exceeded: free-models-per-day.');
        expect(error.message).toContain('attempt 2');
        // A retry is not a turn boundary: the session really is still busy,
        // and the hub owns how that composes with its queue grace.
        expect(session.thinking).toBe(true);
        expect(thinkingChangeCalls).toEqual([true]);

        harness.resolvePrompt!();
        await launchPromise;
    });

    it('tells the user why the prompt failed instead of pointing at logs they cannot read', async () => {
        // The agent's own explanation already reaches this process: the ACP
        // transport rejects `session/prompt` with the JSON-RPC error message
        // verbatim (AcpStdioTransport's response handler). Discarding it left
        // a remote user — the only user this launcher has — staring at a
        // session that stopped for no stated reason, with "check the logs"
        // pointing at a machine they are not sitting in front of.
        harness.promptImpl = async () => {
            throw new Error('Internal error: Rate limit exceeded: free-models-per-day. Add credits to unlock 1000 free models.');
        };
        const { session, agentMessages } = createSessionStub([
            { message: 'first', mode: createMode() }
        ]);

        await opencodeRemoteLauncher(session as never);

        expect(agentMessages).toEqual([{
            type: 'error',
            message: 'OpenCode prompt failed: Rate limit exceeded: free-models-per-day. Add credits to unlock 1000 free models.'
        }]);
    });

    it('delivers both the raw stderr dump and the readable sentence on a hard error', async () => {
        // Measured (isolated E2E, stub provider answering 400): OpenCode
        // dumps the JSON-RPC error onto stderr, the shared ACP reader splits
        // it line by line, and each line is reported — then the rejected
        // session/prompt reaches the catch. Both arrive, on purpose. The
        // fragments are upstream's existing behaviour and the sentence is
        // the only line of the set a person can read, so it follows them as
        // a summary rather than as a repeat. An earlier revision suppressed
        // it as a duplicate; see reportPromptFailure's doc comment for why
        // that is not coming back.
        harness.promptImpl = async () => {
            harness.stderrHandler!({
                type: 'unknown',
                message: 'Error handling request {',
                raw: 'Error handling request {'
            });
            harness.stderrHandler!({
                type: 'unknown',
                message: 'message: "Internal error: SENTINEL stub rejected the request",',
                raw: 'message: "Internal error: SENTINEL stub rejected the request",'
            });
            throw new Error('Internal error: SENTINEL stub rejected the request');
        };
        const { session, agentMessages } = createSessionStub([
            { message: 'first', mode: createMode() }
        ]);

        await opencodeRemoteLauncher(session as never);

        expect(agentMessages).toEqual([
            { type: 'error', message: 'Error handling request {' },
            { type: 'error', message: 'message: "Internal error: SENTINEL stub rejected the request",' },
            { type: 'error', message: 'OpenCode prompt failed: SENTINEL stub rejected the request' }
        ]);
    });

    it('falls back to the original wording when the failure carries no message at all', async () => {
        harness.promptImpl = async () => {
            throw new Error('');
        };
        const { session, agentMessages } = createSessionStub([
            { message: 'first', mode: createMode() }
        ]);

        await opencodeRemoteLauncher(session as never);

        expect(agentMessages).toEqual([{
            type: 'error',
            message: 'OpenCode prompt failed. Check logs for details.'
        }]);
    });

    it('serializes setModel after the previous prompt resolves', async () => {
        const { session } = createSessionStub([
            { message: 'first', mode: createMode('ollama/a') },
            { message: 'second', mode: createMode('ollama/b') }
        ]);

        await opencodeRemoteLauncher(session as never);

        // Order must be: prompt(1) start/end → setModel → prompt(2) start/end
        expect(harness.events).toEqual([
            'prompt:start',
            'prompt:end',
            'setModel:ollama/b',
            'prompt:start',
            'prompt:end'
        ]);
    });
});

describe('selectAbortStatusMessage', () => {
    // Pure-logic unit tests for handleAbort()'s final decision, extracted
    // specifically because opencodeRemoteLauncher.test.ts's harness has no
    // way to observe MessageBuffer/Ink content — the launcher instance
    // itself is never exposed to tests, only the session stub and the exit
    // reason. These exercise the exact same decision handleAbort() makes,
    // driven by re-read (not snapshotted) state, without needing any of
    // that launcher/Ink machinery.

    it('a plain Stop with a compact still running (not yet aborted) reports the waiting message and does not clear thinking', () => {
        const decision = selectAbortStatusMessage({
            hasCompactInFlight: true,
            leavingRemote: false,
            compactAborted: false
        });

        expect(decision.shouldClearThinking).toBe(false);
        // Must actually tell the user how to leave, not just that they're stuck.
        expect(decision.message).toContain('waiting for the in-progress compaction');
        expect(decision.message.toLowerCase()).toMatch(/switch|exit/);
    });

    it('switch-to-local/exit (leavingRemote=true) with a compact in flight reports "Turn aborted" and clears thinking, even before the abort() call is reflected in the signal', () => {
        // Mirrors handleAbort()'s actual call: it reads leavingRemote
        // directly (not compactAborted) to decide this branch, since the
        // real call chain always aborts the controller synchronously before
        // reaching this decision when leavingRemote is true — this input
        // combination (leavingRemote=true, compactAborted=false) simply
        // proves the decision doesn't depend on compactAborted once
        // leavingRemote is true.
        const decision = selectAbortStatusMessage({
            hasCompactInFlight: true,
            leavingRemote: true,
            compactAborted: false
        });

        expect(decision).toEqual({ message: 'Turn aborted', shouldClearThinking: true });
    });

    it('no compact in flight reports "Turn aborted" regardless of leavingRemote', () => {
        expect(selectAbortStatusMessage({ hasCompactInFlight: false, leavingRemote: false, compactAborted: false }))
            .toEqual({ message: 'Turn aborted', shouldClearThinking: true });
        expect(selectAbortStatusMessage({ hasCompactInFlight: false, leavingRemote: true, compactAborted: false }))
            .toEqual({ message: 'Turn aborted', shouldClearThinking: true });
    });

    it('a compact already aborted by an interleaved leavingRemote=true call reports "Turn aborted" for a subsequent plain-Stop continuation reading the re-checked state — this is the RPC-overlap message-ordering fix', () => {
        // Reproduces the exact scenario the previous round's fix addressed:
        // Stop's continuation resumes (leavingRemote=false, as originally
        // called) *after* an interleaved switch-to-local call already
        // aborted the same controller. Re-reading `compactAborted` (true
        // here) rather than trusting a stale "was it aborted when I
        // started" snapshot is what makes this resolve to "Turn aborted"
        // instead of a now-inaccurate "still waiting" message that would
        // appear confusingly after switch's own "Turn aborted" already
        // printed.
        const decision = selectAbortStatusMessage({
            hasCompactInFlight: true,
            leavingRemote: false,
            compactAborted: true
        });

        expect(decision).toEqual({ message: 'Turn aborted', shouldClearThinking: true });
    });
});

function indeterminateError(message: string): Error {
    const error = new Error(message);
    Object.defineProperty(error, ACP_INDETERMINATE_SYMBOL, { value: true });
    return error;
}

describe('opencodeRemoteLauncher mid-turn steer', () => {
    afterEach(() => {
        harness.events = [];
        harness.cleanupEvents = [];
        harness.promptCount = 0;
        harness.promptContents = [];
        harness.promptImpl = null;
        harness.hangPrompt = false;
        harness.resolvePrompt = null;
        harness.cancelPrompt.mockClear();
        harness.cancelPromptImpl = null;
        harness.disconnectImpl = null;
        harness.thoughtLevelOption = null;
        harness.sessionModelsMetadata = undefined;
        harness.softSteerCalls = [];
        harness.softSteerDispatchError = null;
        harness.deferSoftSteerDispatch = null;
        harness.deferSoftSteer = null;
        harness.softSteerThrow = null;
        harness.deferSteerState = null;
        harness.steerStateCalls = [];
        harness.steerStateResult = true;
        harness.promptGeneration = 1;
        harness.abortSoftSteersCalls = 0;
        harness.promptRequestInFlight = null;
        compactHarness.calls = [];
        compactHarness.markerSnapshot = { markerIds: ['before'] };
        compactHarness.triggerImpl = null;
        compactHarness.resultImpl = null;
        compactHarness.snapshotImpl = null;
        compactHarness.compactionResult = { status: 'success', text: '## Objective\n- Did the thing' };
        const backendModule = (globalThis as { __opencodeBackendMockCalls?: unknown }).__opencodeBackendMockCalls;
        void backendModule;
    });

    type SteerSession = ReturnType<typeof createSessionStub>;
    type SteerHandler = (payload: unknown) => Promise<unknown>;

    async function startTurn(opts: {
        firstMessage?: string;
        firstMode?: OpencodeMode;
        holdPrompt?: boolean;
    } = {}): Promise<{
        stub: SteerSession;
        handlers: Map<string, (params: unknown) => unknown>;
        releasePrompt: () => void;
        runPromise: Promise<'switch' | 'exit'>;
    }> {
        let releasePrompt!: () => void;
        if (opts.holdPrompt !== false) {
            harness.promptImpl = () => new Promise<void>((resolve) => {
                releasePrompt = resolve;
            });
        }
        const mode = opts.firstMode ?? createMode();
        const stub = createSessionStub(
            [{ message: opts.firstMessage ?? 'first', mode, localId: 'first' }],
            { keepOpen: true }
        );
        const runPromise = opencodeRemoteLauncher(stub.session as never);
        await vi.waitFor(() => expect(harness.promptCount).toBe(1));
        // Later prompts fall back to the default auto-resolving prompt, so a
        // release can never strand the loop on a second turn.
        const release = () => {
            harness.promptImpl = null;
            releasePrompt();
        };
        return { stub, handlers: stub.rpcHandlers, releasePrompt: release, runPromise };
    }

    async function stopTurn(
        stub: SteerSession,
        releasePrompt: () => void,
        runPromise: Promise<'switch' | 'exit'>
    ): Promise<void> {
        releasePrompt();
        stub.session.queue.close();
        await runPromise;
    }

    function steerHandlerOf(stub: SteerSession): SteerHandler {
        return stub.rpcHandlers.get('steer-queued-message') as SteerHandler;
    }

    it('injects a compatible queued message into the active turn without cancelling it', async () => {
        let releaseSoftSteer!: () => void;
        harness.deferSoftSteer = new Promise<void>((resolve) => { releaseSoftSteer = resolve; });
        const { stub, releasePrompt, runPromise } = await startTurn();
        const mode = createMode();

        stub.session.queue.push('mid-turn correction', mode, 'steer');
        await expect(steerHandlerOf(stub)({ localId: 'steer' })).resolves.toEqual({ steered: true });

        // Injected into the live ACP session as a concurrent session/prompt.
        expect(harness.softSteerCalls).toEqual([
            { sessionId: 'acp-session-1', content: [{ type: 'text', text: 'mid-turn correction' }] }
        ]);
        // The foreground turn was never cancelled or re-prompted.
        expect(harness.cancelPrompt).not.toHaveBeenCalled();
        expect(harness.promptCount).toBe(1);

        // Consumed ack only after the concurrent prompt settles.
        expect(stub.emitMessagesConsumedCalls).not.toContainEqual(
            expect.objectContaining({ options: { steered: true } })
        );
        releaseSoftSteer();
        await vi.waitFor(() => expect(stub.emitMessagesConsumedCalls).toContainEqual(
            { localIds: ['steer'], options: { steered: true } }
        ));
        expect(stub.steerIndeterminateCalls).toEqual([]);
        // Committed: the row is neither restored nor cancellable.
        expect(stub.session.queue.cancelByLocalId('steer')).toBe('consumed');

        harness.deferSoftSteer = null;
        await stopTurn(stub, releasePrompt, runPromise);
    });

    it('consumes an input accepted in native history before its concurrent prompt completes', async () => {
        const receipts = await import('./utils/opencodeInputReceipt');
        const text = 'mid-turn correction';
        const receipt = vi.spyOn(receipts, 'fetchOpencodeUserMessages')
            .mockResolvedValueOnce([{ id: 'existing-user', text }])
            .mockResolvedValue([{ id: 'existing-user', text }, { id: 'new-user', text }]);
        let releaseSoftSteer!: () => void;
        harness.deferSoftSteer = new Promise<void>((resolve) => { releaseSoftSteer = resolve; });
        const { stub, releasePrompt, runPromise } = await startTurn();
        try {
            stub.session.queue.push(text, createMode(), 'steer');
            await expect(steerHandlerOf(stub)({ localId: 'steer' })).resolves.toEqual({ steered: true });
            expect(stub.emitMessagesConsumedCalls).toContainEqual({ localIds: ['steer'], options: { steered: true } });
            expect(stub.session.queue.cancelByLocalId('steer')).toBe('consumed');
            expect(harness.cancelPrompt).not.toHaveBeenCalled();
            releaseSoftSteer();
            await vi.waitFor(() => expect(stub.emitMessagesConsumedCalls.filter(c => c.localIds.includes('steer'))).toHaveLength(1));
        } finally {
            releaseSoftSteer();
            receipt.mockRestore();
            harness.deferSoftSteer = null;
            await stopTurn(stub, releasePrompt, runPromise);
        }
    });

    it('does not restore an input accepted by native history when the prompt later fails', async () => {
        const receipts = await import('./utils/opencodeInputReceipt');
        const receipt = vi.spyOn(receipts, 'fetchOpencodeUserMessages')
            .mockResolvedValueOnce([])
            .mockResolvedValue([{ id: 'native-user', text: 'correction' }]);
        let rejectSoftSteer!: (error: Error) => void;
        harness.deferSoftSteer = new Promise<void>((_resolve, reject) => { rejectSoftSteer = reject; });
        const { stub, releasePrompt, runPromise } = await startTurn();
        try {
            stub.session.queue.push('correction', createMode(), 'steer');
            await steerHandlerOf(stub)({ localId: 'steer' });
            rejectSoftSteer(new Error('provider failed after accepting input'));
            await stopTurn(stub, releasePrompt, runPromise);
            expect(harness.steerStateCalls).not.toContainEqual({ localIds: ['steer'], state: 'queued' });
            expect(stub.steerIndeterminateCalls).toEqual([]);
            expect(stub.session.queue.cancelByLocalId('steer')).toBe('consumed');
            expect(stub.emitMessagesConsumedCalls.filter(c => c.localIds.includes('steer'))).toHaveLength(1);
        } finally {
            receipt.mockRestore();
            harness.deferSoftSteer = null;
            releasePrompt();
            stub.session.queue.close();
            await runPromise;
        }
    });

    it('does not correlate overlapping identical steers using native text alone', async () => {
        const receipts = await import('./utils/opencodeInputReceipt');
        let releaseSnapshot!: (value: Array<{ id: string; text: string }>) => void;
        const receipt = vi.spyOn(receipts, 'fetchOpencodeUserMessages')
            .mockImplementationOnce(() => new Promise(resolve => { releaseSnapshot = resolve; }))
            .mockResolvedValue([{ id: 'new-user', text: 'same correction' }]);
        let releaseSoftSteer!: () => void;
        harness.deferSoftSteer = new Promise<void>(resolve => { releaseSoftSteer = resolve; });
        const { stub, releasePrompt, runPromise } = await startTurn();
        try {
            stub.session.queue.push('same correction', createMode(), 'steer-1');
            const first = steerHandlerOf(stub)({ localId: 'steer-1' });
            await vi.waitFor(() => expect(receipt).toHaveBeenCalledOnce());
            stub.session.queue.push('same correction', createMode(), 'steer-2');
            await steerHandlerOf(stub)({ localId: 'steer-2' });
            releaseSnapshot([]);
            await first;
            expect(stub.emitMessagesConsumedCalls).toEqual([]);
            releaseSoftSteer();
            await vi.waitFor(() => expect(stub.emitMessagesConsumedCalls).toHaveLength(2));
        } finally {
            releaseSnapshot?.([]);
            releaseSoftSteer();
            receipt.mockRestore();
            harness.deferSoftSteer = null;
            await stopTurn(stub, releasePrompt, runPromise);
        }
    });

    it('rejects a steer while idle with no active turn', async () => {
        const stub = createSessionStub([], { keepOpen: true });
        const runPromise = opencodeRemoteLauncher(stub.session as never);
        await vi.waitFor(() => expect(stub.rpcHandlers.has('steer-queued-message')).toBe(true));

        stub.session.queue.push('mid-turn correction', createMode(), 'steer');
        await expect(steerHandlerOf(stub)({ localId: 'steer' })).resolves.toEqual({
            steered: false,
            error: 'No active steerable turn'
        });
        expect(harness.softSteerCalls).toEqual([]);
        // No reservation, no durable steer state: the row is left entirely to
        // the normal queue and delivered by an ordinary prompt.
        expect(harness.steerStateCalls).toEqual([]);
        await vi.waitFor(() => expect(harness.promptCount).toBe(1));
        expect(JSON.stringify(harness.promptContents[0])).toContain('mid-turn correction');

        stub.session.queue.close();
        await runPromise;
    });

    it('rejects a missing localId and a localId that is not queued', async () => {
        const { stub, releasePrompt, runPromise } = await startTurn();

        await expect(steerHandlerOf(stub)({})).resolves.toEqual({
            steered: false,
            error: 'Missing localId'
        });
        await expect(steerHandlerOf(stub)({ localId: 'never-queued' })).resolves.toEqual({
            steered: false,
            error: 'Message not in queue'
        });
        expect(harness.softSteerCalls).toEqual([]);

        await stopTurn(stub, releasePrompt, runPromise);
    });

    it('rejects a duplicate steer for the same queued row', async () => {
        let releaseDispatch!: () => void;
        const dispatchGate = new Promise<void>((resolve) => { releaseDispatch = resolve; });
        harness.deferSoftSteerDispatch = dispatchGate;
        const { stub, releasePrompt, runPromise } = await startTurn();
        const mode = createMode();

        stub.session.queue.push('mid-turn correction', mode, 'steer');
        const first = steerHandlerOf(stub)({ localId: 'steer' });
        await vi.waitFor(() => expect(harness.softSteerCalls).toHaveLength(1));

        await expect(steerHandlerOf(stub)({ localId: 'steer' })).resolves.toEqual({
            steered: false,
            error: 'Message not in queue'
        });
        expect(harness.softSteerCalls).toHaveLength(1);

        releaseDispatch();
        await expect(first).resolves.toEqual({ steered: true });
        harness.deferSoftSteerDispatch = null;
        await stopTurn(stub, releasePrompt, runPromise);
    });

    it.each([
        ['isolated', createMode(), true],
        ['compact', createCompactMode(), false],
        ['clear', createClearMode(), false]
    ])('rejects an isolated %s item and restores its FIFO position', async (_label, mode, isolate) => {
        const { stub, releasePrompt, runPromise } = await startTurn();

        if (isolate) {
            stub.session.queue.pushIsolated('control', mode, 'control');
        } else {
            stub.session.queue.push('control', mode, 'control');
        }
        await expect(steerHandlerOf(stub)({ localId: 'control' })).resolves.toEqual({
            steered: false,
            error: 'Control commands cannot be steered'
        });
        expect(harness.softSteerCalls).toEqual([]);
        expect(stub.session.queue.peekByLocalId('control')).not.toBeNull();

        await stopTurn(stub, releasePrompt, runPromise);
    });

    it.each([
        ['permission', createPlanMode()],
        ['model', createMode('other-model')],
        ['effort', createModeWithEffort(undefined, 'high')]
    ])('rejects a queued message whose %s differs from the active turn', async (_label, mode) => {
        const { stub, releasePrompt, runPromise } = await startTurn();

        stub.session.queue.push('mid-turn correction', mode, 'steer');
        await expect(steerHandlerOf(stub)({ localId: 'steer' })).resolves.toEqual({
            steered: false,
            error: 'Queued message mode differs from the active turn'
        });
        expect(harness.softSteerCalls).toEqual([]);
        expect(stub.session.queue.peekByLocalId('steer')?.message).toBe('mid-turn correction');

        await stopTurn(stub, releasePrompt, runPromise);
    });

    it('rejects a normal steer while a compaction is in flight', async () => {
        harness.sessionModelsMetadata = { currentModelId: 'ollama/x', availableModels: [] };
        let releaseCompact!: () => void;
        compactHarness.triggerImpl = () => new Promise((resolve) => {
            releaseCompact = () => resolve({ ok: true });
        });
        const stub = createSessionStub(
            [
                { message: '', mode: createCompactMode('ollama/x'), localId: 'compact' },
                { message: 'mid-turn correction', mode: createCompactMode('ollama/x'), localId: 'steer' }
            ],
            { keepOpen: true }
        );
        const runPromise = opencodeRemoteLauncher(stub.session as never, {
            onCompactAvailabilityChange: () => {}
        });
        await vi.waitFor(() => expect(compactHarness.calls.length).toBe(1));

        await expect(steerHandlerOf(stub)({ localId: 'steer' })).resolves.toEqual({
            steered: false,
            error: 'No active steerable turn'
        });
        expect(harness.softSteerCalls).toEqual([]);

        releaseCompact();
        compactHarness.triggerImpl = null;
        stub.session.queue.close();
        await runPromise;
    });

    it('marks the steer indeterminate and sends nothing when the durable dispatching state fails', async () => {
        harness.steerStateResult = false;
        const { stub, releasePrompt, runPromise } = await startTurn();

        stub.session.queue.push('mid-turn correction', createMode(), 'steer');
        await expect(steerHandlerOf(stub)({ localId: 'steer' })).resolves.toEqual({
            steered: false,
            error: 'Steer state is indeterminate'
        });
        expect(harness.softSteerCalls).toEqual([]);
        expect(stub.steerIndeterminateCalls).toEqual([['steer']]);
        // Held outside the automatic queue — never silently replayed.
        expect(stub.session.queue.peekByLocalId('steer')).toBeNull();

        await stopTurn(stub, releasePrompt, runPromise);
    });

    it('does not send into a finished turn, restores the row, and does not start the next prompt until bookkeeping finished', async () => {
        let releaseSteerState!: () => void;
        harness.deferSteerState = new Promise<void>((resolve) => { releaseSteerState = resolve; });
        let releasePrompt!: () => void;
        harness.promptImpl = () => new Promise<void>((resolve) => { releasePrompt = resolve; });
        const stub = createSessionStub(
            [
                { message: 'first', mode: createMode(), localId: 'first' },
                { message: 'second', mode: createMode(), localId: 'second' }
            ],
            { keepOpen: true }
        );
        const runPromise = opencodeRemoteLauncher(stub.session as never);
        await vi.waitFor(() => expect(harness.promptCount).toBe(1));

        stub.session.queue.push('mid-turn correction', createMode(), 'steer');
        const steerPromise = steerHandlerOf(stub)({ localId: 'steer' });
        await vi.waitFor(() => expect(harness.steerStateCalls).toContainEqual(
            { localIds: ['steer'], state: 'dispatching' }
        ));

        // The foreground prompt finishes while persistence is still pending.
        harness.promptImpl = null;
        releasePrompt();
        await vi.waitFor(() => expect(harness.events).toContain('prompt:end'));
        // No second prompt may start while the steer still owns the row.
        expect(harness.promptCount).toBe(1);

        releaseSteerState();
        await expect(steerPromise).resolves.toEqual({ steered: false, error: 'Active turn changed' });
        expect(harness.softSteerCalls).toEqual([]);
        expect(stub.steerIndeterminateCalls).toEqual([]);

        // Restored in order and delivered by the next normal prompt — the row
        // was neither lost nor dropped on the floor.
        await vi.waitFor(() => expect(harness.promptCount).toBe(2));
        expect(JSON.stringify(harness.promptContents[1])).toContain('mid-turn correction');
        stub.session.queue.close();
        harness.deferSteerState = null;
        await runPromise;
    });

    it('restores the original FIFO position and emits no consumed ack when ACP rejects the steer explicitly', async () => {
        harness.softSteerDispatchError = new Error('session/prompt rejected');
        const { stub, releasePrompt, runPromise } = await startTurn();

        stub.session.queue.push('before', createMode(), 'before');
        stub.session.queue.push('mid-turn correction', createMode(), 'steer');
        stub.session.queue.push('after', createMode(), 'after');

        await expect(steerHandlerOf(stub)({ localId: 'steer' })).resolves.toEqual({
            steered: false,
            error: 'Failed to soft-steer into active turn'
        });
        expect(stub.emitMessagesConsumedCalls).toEqual([]);
        expect(stub.steerIndeterminateCalls).toEqual([]);
        expect(harness.steerStateCalls).toEqual([
            { localIds: ['steer'], state: 'dispatching' },
            { localIds: ['steer'], state: 'queued' }
        ]);
        // Exact FIFO restoration: before, steer, after.
        expect(stub.session.queue.queue.map((item: { localId?: string }) => item.localId))
            .toEqual(['before', 'steer', 'after']);

        await stopTurn(stub, releasePrompt, runPromise);
    });

    it('holds an ambiguous dispatch failure for explicit resolution instead of replaying it', async () => {
        harness.softSteerDispatchError = indeterminateError('ACP write callback failed');
        const { stub, releasePrompt, runPromise } = await startTurn();

        stub.session.queue.push('mid-turn correction', createMode(), 'steer');
        await expect(steerHandlerOf(stub)({ localId: 'steer' })).resolves.toEqual({
            steered: false,
            error: 'Steer outcome is being reconciled'
        });
        expect(stub.steerIndeterminateCalls).toEqual([['steer']]);
        expect(stub.emitMessagesConsumedCalls).toEqual([]);
        // No automatic replay, but an explicit cancel releases it.
        expect(stub.session.queue.peekByLocalId('steer')).toBeNull();
        expect(stub.session.queue.cancelByLocalId('steer')).toBe(true);

        await stopTurn(stub, releasePrompt, runPromise);
    });

    it('holds an ambiguous completion failure and never replays it', async () => {
        let rejectSoftSteer!: (error: Error) => void;
        harness.deferSoftSteer = new Promise<void>((_, reject) => { rejectSoftSteer = reject; });
        const { stub, releasePrompt, runPromise } = await startTurn();

        stub.session.queue.push('mid-turn correction', createMode(), 'steer');
        await expect(steerHandlerOf(stub)({ localId: 'steer' })).resolves.toEqual({ steered: true });
        rejectSoftSteer(indeterminateError('ACP transport closed'));

        // Delivery stays unproven and user-resolvable: held out of the queue,
        // no consumed ack, and only an explicit cancel releases it.
        await vi.waitFor(() => expect(stub.steerIndeterminateCalls).toEqual([['steer']]));
        expect(stub.emitMessagesConsumedCalls).toEqual([]);
        expect(stub.session.queue.peekByLocalId('steer')).toBeNull();
        expect(stub.session.queue.cancelByLocalId('steer')).toBe(true);

        // That delivery ambiguity is independent of the backend's logical
        // request lifetime: `completed` settled, so the ACP counters are
        // already down and an ordinary Stop must not force-settle them again
        // (which would deactivate the foreground handler for nothing).
        await (stub.rpcHandlers.get('abort') as () => Promise<void>)();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(harness.cancelPrompt).toHaveBeenCalledWith('acp-session-1');
        expect(harness.abortSoftSteersCalls).toBe(0);

        harness.deferSoftSteer = null;
        await stopTurn(stub, releasePrompt, runPromise);
    });

    it('acknowledges dispatch before completion but does not start the next prompt until completion', async () => {
        let releaseSoftSteer!: () => void;
        harness.deferSoftSteer = new Promise<void>((resolve) => { releaseSoftSteer = resolve; });
        const { stub, handlers, releasePrompt, runPromise } = await startTurn();

        stub.session.queue.push('mid-turn correction', createMode(), 'steer');
        stub.session.queue.push('second', createMode(), 'second');

        // The RPC returns as soon as stdin accepted the inject.
        await expect(steerHandlerOf(stub)({ localId: 'steer' })).resolves.toEqual({ steered: true });
        // Foreground turn still in flight: no ready, no next prompt.
        expect(stub.sessionEvents.filter((event) => event.type === 'ready')).toEqual([]);
        expect(harness.promptCount).toBe(1);

        releasePrompt();
        await vi.waitFor(() => expect(harness.events).toContain('prompt:end'));
        // Completion still gates the next prompt.
        expect(harness.promptCount).toBe(1);
        expect(stub.sessionEvents.filter((event) => event.type === 'ready')).toEqual([]);

        releaseSoftSteer();
        await vi.waitFor(() => expect(stub.emitMessagesConsumedCalls).toContainEqual(
            { localIds: ['steer'], options: { steered: true } }
        ));
        await vi.waitFor(() => expect(harness.promptCount).toBe(2));
        void handlers;

        harness.deferSoftSteer = null;
        stub.session.queue.close();
        await runPromise;
    });

    it('prevents sending into a new backend when an abort lands during persistence', async () => {
        let releaseSteerState!: () => void;
        harness.deferSteerState = new Promise<void>((resolve) => { releaseSteerState = resolve; });
        const { stub, releasePrompt, runPromise } = await startTurn();

        stub.session.queue.push('mid-turn correction', createMode(), 'steer');
        const steerPromise = steerHandlerOf(stub)({ localId: 'steer' });
        await vi.waitFor(() => expect(harness.steerStateCalls).toContainEqual(
            { localIds: ['steer'], state: 'dispatching' }
        ));

        await (stub.rpcHandlers.get('abort') as () => Promise<void>)();
        releaseSteerState();

        await expect(steerPromise).resolves.toEqual({ steered: false, error: 'Active turn changed' });
        expect(harness.softSteerCalls).toEqual([]);

        await stopTurn(stub, releasePrompt, runPromise);
    });

    it('restores the row when the ACP call fails synchronously, before anything was sent', async () => {
        harness.softSteerThrow = new Error('no active ACP prompt to soft-steer into');
        const { stub, releasePrompt, runPromise } = await startTurn();

        stub.session.queue.push('before', createMode(), 'before');
        stub.session.queue.push('mid-turn correction', createMode(), 'steer');
        stub.session.queue.push('after', createMode(), 'after');

        await expect(steerHandlerOf(stub)({ localId: 'steer' })).resolves.toEqual({
            steered: false,
            error: 'Failed to soft-steer into active turn'
        });
        expect(stub.emitMessagesConsumedCalls).toEqual([]);
        expect(stub.steerIndeterminateCalls).toEqual([]);
        expect(stub.session.queue.queue.map((item: { localId?: string }) => item.localId))
            .toEqual(['before', 'steer', 'after']);

        await stopTurn(stub, releasePrompt, runPromise);
    });

    it('prevents sending into a new backend when a switch lands during persistence', async () => {
        let releaseSteerState!: () => void;
        harness.deferSteerState = new Promise<void>((resolve) => { releaseSteerState = resolve; });
        const { stub, releasePrompt, runPromise } = await startTurn();

        stub.session.queue.push('mid-turn correction', createMode(), 'steer');
        const steerPromise = steerHandlerOf(stub)({ localId: 'steer' });
        await vi.waitFor(() => expect(harness.steerStateCalls).toContainEqual(
            { localIds: ['steer'], state: 'dispatching' }
        ));

        const switchPromise = (stub.rpcHandlers.get('switch') as () => Promise<void>)();
        releaseSteerState();
        await switchPromise;

        await expect(steerPromise).resolves.toEqual({ steered: false, error: 'Active turn changed' });
        expect(harness.softSteerCalls).toEqual([]);

        harness.deferSteerState = null;
        await stopTurn(stub, releasePrompt, runPromise);
    });

    it('advertises steerability only while a normal prompt runs, and drops it on abort and teardown', async () => {
        const { stub, releasePrompt, runPromise } = await startTurn();

        // Live prompt: the web's queued Steer button is reachable, and it was
        // published as false before the first prompt ran.
        await vi.waitFor(() => expect(stub.steeringActiveCalls.at(-1)).toBe(true));
        expect(stub.steeringActiveCalls[0]).toBe(false);

        releasePrompt();
        await vi.waitFor(() => expect(stub.steeringActiveCalls.at(-1)).toBe(false));

        // Abort keeps it false, and the terminal teardown leaves it false too.
        await (stub.rpcHandlers.get('abort') as () => Promise<void>)();
        expect(stub.steeringActiveCalls.at(-1)).toBe(false);
        stub.session.queue.close();
        await runPromise;
        expect(stub.steeringActiveCalls.at(-1)).toBe(false);
    });

    it('does not advertise steerability during a compaction', async () => {
        harness.sessionModelsMetadata = { currentModelId: 'ollama/x', availableModels: [] };
        let releaseCompact!: () => void;
        compactHarness.triggerImpl = () => new Promise((resolve) => {
            releaseCompact = () => resolve({ ok: true });
        });
        const stub = createSessionStub(
            [{ message: '', mode: createCompactMode('ollama/x'), localId: 'compact' }],
            { keepOpen: true }
        );
        const runPromise = opencodeRemoteLauncher(stub.session as never, {
            onCompactAvailabilityChange: () => {}
        });
        await vi.waitFor(() => expect(compactHarness.calls.length).toBe(1));
        expect(stub.steeringActiveCalls).not.toContain(true);

        releaseCompact();
        compactHarness.triggerImpl = null;
        stub.session.queue.close();
        await runPromise;
    });

    it('lets a new normal turn finish ready even when an aborted steer never completes', async () => {
        // The concurrent ACP request was cancelled by the abort and will never
        // answer; its completion callback stays attached so an accepted steer
        // can still be acknowledged later.
        harness.deferSoftSteer = new Promise<void>(() => {});
        const { stub, releasePrompt, runPromise } = await startTurn();

        stub.session.queue.push('mid-turn correction', createMode(), 'steer');
        await expect(steerHandlerOf(stub)({ localId: 'steer' })).resolves.toEqual({ steered: true });

        releasePrompt();
        await (stub.rpcHandlers.get('abort') as () => Promise<void>)();
        // Abort resets the queue, so the next normal turn is queued afterwards.
        stub.session.queue.push('second', createMode(), 'second');

        // The new normal turn must reach ready instead of blocking forever on
        // the old steer's unresolved completion.
        await vi.waitFor(() => expect(harness.promptCount).toBe(2));
        await vi.waitFor(() => expect(stub.sessionEvents).toContainEqual({ type: 'ready' }));
        expect(stub.emitMessagesConsumedCalls).toEqual([]);
        expect(stub.steeringActiveCalls.at(-1)).toBe(false);

        harness.deferSoftSteer = null;
        harness.promptImpl = null;
        stub.session.queue.close();
        await runPromise;
    });

    it('keeps the next prompt and ready blocked until a completion-time rejection is fully restored', async () => {
        let rejectSoftSteer!: (error: Error) => void;
        harness.deferSoftSteer = new Promise<void>((_, reject) => { rejectSoftSteer = reject; });
        let releaseQueuedState!: () => void;
        let queuedStateHeld = false;
        const { stub, releasePrompt, runPromise } = await startTurn();

        stub.session.queue.push('mid-turn correction', createMode(), 'steer');
        stub.session.queue.push('second', createMode(), 'second');
        await expect(steerHandlerOf(stub)({ localId: 'steer' })).resolves.toEqual({ steered: true });

        // ACP rejects the inject only after the foreground prompt is gone, and
        // the durable "back to queued" write is slow.
        harness.deferSteerState = new Promise<void>((resolve) => {
            releaseQueuedState = () => {
                queuedStateHeld = false;
                resolve();
            };
        });
        releasePrompt();
        rejectSoftSteer(new Error('session/prompt rejected'));
        await vi.waitFor(() => expect(harness.steerStateCalls).toContainEqual(
            { localIds: ['steer'], state: 'queued' }
        ));
        queuedStateHeld = true;
        expect(harness.promptCount).toBe(1);
        expect(stub.sessionEvents.filter((event) => event.type === 'ready')).toEqual([]);

        releaseQueuedState();
        // Only now may the next prompt start, and the row is delivered by it.
        await vi.waitFor(() => expect(harness.promptCount).toBe(2));
        expect(JSON.stringify(harness.promptContents[1])).toContain('mid-turn correction');
        expect(stub.emitMessagesConsumedCalls).toEqual([]);
        expect(stub.steerIndeterminateCalls).toEqual([]);
        void queuedStateHeld;

        harness.deferSteerState = null;
        stub.session.queue.close();
        await runPromise;
    });

    it('refuses a new steer once a stalled runtime has been cancelled from stderr', async () => {
        let releasePrompt!: () => void;
        harness.promptImpl = () => new Promise<void>((resolve) => {
            releasePrompt = resolve;
        });
        const stub = createSessionStub(
            [{ message: 'first', mode: createMode(), localId: 'first' }],
            { keepOpen: true }
        );
        const runPromise = opencodeRemoteLauncher(stub.session as never);
        await vi.waitFor(() => expect(harness.promptCount).toBe(1));
        await vi.waitFor(() => expect(stub.steeringActiveCalls.at(-1)).toBe(true));

        // A dispatched steer whose concurrent prompt the runtime cancelled and
        // will never answer.
        harness.deferSoftSteer = new Promise<void>(() => {});
        stub.session.queue.push('mid-turn correction', createMode(), 'steer');
        await expect(steerHandlerOf(stub)({ localId: 'steer' })).resolves.toEqual({ steered: true });

        harness.stderrHandler!({
            type: 'quota_exceeded',
            message: 'API quota exceeded. Retrying in 30 seconds',
            raw: 'quota exceeded'
        });
        await vi.waitFor(() => expect(harness.cancelPrompt).toHaveBeenCalledWith('acp-session-1'));

        // The cancelled runtime accepts no further mid-turn steer, and the
        // killed steer's bookkeeping no longer gates the next turn.
        expect(stub.steeringActiveCalls.at(-1)).toBe(false);
        stub.session.queue.push('second', createMode(), 'second');
        await expect(steerHandlerOf(stub)({ localId: 'second' })).resolves.toEqual({
            steered: false,
            error: 'No active steerable turn'
        });
        expect(harness.softSteerCalls).toHaveLength(1);

        harness.deferSoftSteer = null;
        releasePrompt();
        harness.promptImpl = null;
        await vi.waitFor(() => expect(harness.promptCount).toBe(2));
        stub.session.queue.close();
        await runPromise;
    });

    it('completes a pending restore without sending anywhere once a switch has begun', async () => {
        let rejectSoftSteer!: (error: Error) => void;
        harness.deferSoftSteer = new Promise<void>((_, reject) => { rejectSoftSteer = reject; });
        let releaseQueuedState!: () => void;
        const { stub, releasePrompt, runPromise } = await startTurn();

        stub.session.queue.push('mid-turn correction', createMode(), 'steer');
        await expect(steerHandlerOf(stub)({ localId: 'steer' })).resolves.toEqual({ steered: true });

        // ACP rejects only after the foreground prompt is gone, and the durable
        // "back to queued" write is slow, so a restore is still pending.
        harness.deferSteerState = new Promise<void>((resolve) => { releaseQueuedState = resolve; });
        releasePrompt();
        rejectSoftSteer(new Error('session/prompt rejected'));
        await vi.waitFor(() => expect(harness.steerStateCalls).toContainEqual(
            { localIds: ['steer'], state: 'queued' }
        ));

        // A switch begins before cleanup runs: the gate closes synchronously
        // and the abort releases the foreground drain.
        const switchPromise = (stub.rpcHandlers.get('switch') as () => Promise<void>)();
        await vi.waitFor(() => expect(harness.cleanupEvents).toContain('cleanup:disconnect'));
        await expect(steerHandlerOf(stub)({ localId: 'first' })).resolves.toMatchObject({ steered: false });

        releaseQueuedState();
        await switchPromise;

        // The restore still finishes its bookkeeping, but nothing is sent into
        // the backend this session is leaving, and no counter is force-settled:
        // the steer's ACP request had already settled when ACP rejected it.
        expect(harness.softSteerCalls).toHaveLength(1);
        expect(harness.abortSoftSteersCalls).toBe(0);
        expect(stub.emitMessagesConsumedCalls).toEqual([]);
        expect(stub.steerIndeterminateCalls).toEqual([]);

        harness.deferSteerState = null;
        harness.deferSoftSteer = null;
        stub.session.queue.close();
        await runPromise;
    });

    it('force-settles a killed soft steer so the next turn\'s model update is not blocked', async () => {
        harness.sessionModelsMetadata = { currentModelId: 'ollama/first', availableModels: [] };
        // The steer was accepted on dispatch but the runtime never answers its
        // concurrent prompt: the stall cancel kills that ACP request.
        harness.deferSoftSteer = new Promise<void>(() => {});
        const { stub, releasePrompt, runPromise } = await startTurn();

        stub.session.queue.push('mid-turn correction', createMode(), 'steer');
        await expect(steerHandlerOf(stub)({ localId: 'steer' })).resolves.toEqual({ steered: true });

        harness.stderrHandler!({
            type: 'quota_exceeded',
            message: 'API quota exceeded. Retrying in 30 seconds',
            raw: 'quota exceeded'
        });
        await vi.waitFor(() => expect(harness.cancelPrompt).toHaveBeenCalledWith('acp-session-1'));
        // The killed steer's backend counters are reset, so the
        // response-complete wait behind the next turn's model/effort update is
        // not held open by a request that will never answer.
        await vi.waitFor(() => expect(harness.abortSoftSteersCalls).toBe(1));

        releasePrompt();
        harness.promptImpl = null;
        // Next normal turn switches model (which waits for response-complete
        // in the real backend) and must still run and reach ready.
        stub.session.queue.push('second', createMode('ollama/second'), 'second');
        await vi.waitFor(() => expect(harness.promptCount).toBe(2));
        expect(harness.setModelArgs).toContainEqual({ sessionId: 'acp-session-1', modelId: 'ollama/second', flavor: 'opencode' });
        await vi.waitFor(() => expect(stub.sessionEvents).toContainEqual({ type: 'ready' }));
        expect(harness.softSteerCalls).toHaveLength(1);

        harness.deferSoftSteer = null;
        stub.session.queue.close();
        await runPromise;
    });

    it('does not touch ACP soft-steer bookkeeping on an ordinary abort with no steer', async () => {
        const { stub, releasePrompt, runPromise } = await startTurn();

        // No soft request was ever dispatched by this session, so cancelling
        // must leave the foreground handler alone — otherwise the cancelled
        // tool's final tool_result and the trailing text would be dropped.
        await (stub.rpcHandlers.get('abort') as () => Promise<void>)();
        expect(harness.abortSoftSteersCalls).toBe(0);
        expect(harness.cancelPrompt).toHaveBeenCalledWith('acp-session-1');

        await stopTurn(stub, releasePrompt, runPromise);
    });

    it('does not touch ACP soft-steer bookkeeping on an ordinary stall cancel with no steer', async () => {
        const { stub, releasePrompt, runPromise } = await startTurn();

        harness.stderrHandler!({
            type: 'quota_exceeded',
            message: 'API quota exceeded. Retrying in 30 seconds',
            raw: 'quota exceeded'
        });
        await vi.waitFor(() => expect(harness.cancelPrompt).toHaveBeenCalledWith('acp-session-1'));
        expect(harness.abortSoftSteersCalls).toBe(0);

        await stopTurn(stub, releasePrompt, runPromise);
    });

    it('rejects a steer once the foreground ACP request answered but prompt() is still draining', async () => {
        const { stub, releasePrompt, runPromise } = await startTurn();

        // ACP has answered session/prompt; only the update drain remains, so
        // the turn is over from the agent's point of view.
        harness.promptRequestInFlight = false;
        stub.session.queue.push('mid-turn correction', createMode(), 'steer');

        await expect(steerHandlerOf(stub)({ localId: 'steer' })).resolves.toEqual({
            steered: false,
            error: 'No active steerable turn'
        });
        // No reservation was even taken: the row is untouched for its turn.
        expect(harness.steerStateCalls).toEqual([]);
        expect(harness.softSteerCalls).toEqual([]);
        expect(stub.session.queue.peekByLocalId('steer')).not.toBeNull();

        harness.promptRequestInFlight = null;
        await stopTurn(stub, releasePrompt, runPromise);
    });

    it('restores the row when the foreground request answers during dispatching persistence', async () => {
        let releaseSteerState!: () => void;
        harness.deferSteerState = new Promise<void>((resolve) => { releaseSteerState = resolve; });
        const { stub, releasePrompt, runPromise } = await startTurn();

        stub.session.queue.push('mid-turn correction', createMode(), 'steer');
        const steerPromise = steerHandlerOf(stub)({ localId: 'steer' });
        await vi.waitFor(() => expect(harness.steerStateCalls).toContainEqual(
            { localIds: ['steer'], state: 'dispatching' }
        ));

        // The ACP request answers while the durable write is still pending.
        harness.promptRequestInFlight = false;
        releaseSteerState();

        await expect(steerPromise).resolves.toEqual({ steered: false, error: 'Active turn changed' });
        expect(harness.softSteerCalls).toEqual([]);
        expect(harness.steerStateCalls).toEqual([
            { localIds: ['steer'], state: 'dispatching' },
            { localIds: ['steer'], state: 'queued' }
        ]);
        expect(stub.session.queue.peekByLocalId('steer')).not.toBeNull();

        harness.promptRequestInFlight = null;
        harness.deferSteerState = null;
        await stopTurn(stub, releasePrompt, runPromise);
    });

    it('stops advertising steerability before draining a deferred steer completion', async () => {
        let releaseSoftSteer!: () => void;
        harness.deferSoftSteer = new Promise<void>((resolve) => { releaseSoftSteer = resolve; });
        const { stub, releasePrompt, runPromise } = await startTurn();

        stub.session.queue.push('mid-turn correction', createMode(), 'steer');
        await expect(steerHandlerOf(stub)({ localId: 'steer' })).resolves.toEqual({ steered: true });
        await vi.waitFor(() => expect(stub.steeringActiveCalls.at(-1)).toBe(true));

        // The foreground turn returns while the steer is still pending: the
        // drain waits, and the advertisement must already be false so no
        // queued row offers a steer that would be rejected.
        releasePrompt();
        await vi.waitFor(() => expect(harness.events).toContain('prompt:end'));
        expect(stub.steeringActiveCalls.at(-1)).toBe(false);
        expect(harness.promptCount).toBe(1);

        releaseSoftSteer();
        await vi.waitFor(() => expect(stub.emitMessagesConsumedCalls).toContainEqual(
            { localIds: ['steer'], options: { steered: true } }
        ));

        harness.deferSoftSteer = null;
        await stopTurn(stub, releasePrompt, runPromise);
    });

    it('keeps an unsent steer gating the queue after a stall cancel, and restores it in FIFO order', async () => {
        let releaseSteerState!: () => void;
        harness.deferSteerState = new Promise<void>((resolve) => { releaseSteerState = resolve; });
        const { stub, releasePrompt, runPromise } = await startTurn();

        stub.session.queue.push('steer row', createMode(), 'steer');
        stub.session.queue.push('newer row', createMode(), 'newer');
        const steerPromise = steerHandlerOf(stub)({ localId: 'steer' });
        await vi.waitFor(() => expect(harness.steerStateCalls).toContainEqual(
            { localIds: ['steer'], state: 'dispatching' }
        ));

        // Stall cancels the runtime while the steer is still only in
        // persistence — nothing was transmitted yet.
        harness.stderrHandler!({
            type: 'quota_exceeded',
            message: 'API quota exceeded. Retrying in 30 seconds',
            raw: 'quota exceeded'
        });
        await vi.waitFor(() => expect(harness.cancelPrompt).toHaveBeenCalledWith('acp-session-1'));
        expect(harness.abortSoftSteersCalls).toBe(0);

        releasePrompt();
        await vi.waitFor(() => expect(harness.events).toContain('prompt:end'));
        // The held row still gates the turn: no ready, and the newer queued
        // message must not overtake it.
        expect(harness.promptCount).toBe(1);
        expect(stub.sessionEvents.filter((event) => event.type === 'ready')).toEqual([]);

        releaseSteerState();
        await expect(steerPromise).resolves.toEqual({ steered: false, error: 'Active turn changed' });
        expect(harness.softSteerCalls).toEqual([]);

        await vi.waitFor(() => expect(harness.promptCount).toBe(2));
        // Restored at its original FIFO position: ahead of the newer row.
        expect(harness.promptContents[1]).toEqual([{ type: 'text', text: 'steer row\nnewer row' }]);
        expect(stub.emitMessagesConsumedCalls).toEqual([]);

        harness.deferSteerState = null;
        stub.session.queue.close();
        await runPromise;
    });

    it('keeps a restoring steer gating the queue after a stall cancel, even though its request already settled', async () => {
        let rejectSoftSteer!: (error: Error) => void;
        harness.deferSoftSteer = new Promise<void>((_, reject) => { rejectSoftSteer = reject; });
        let releaseQueuedState!: () => void;
        const { stub, releasePrompt, runPromise } = await startTurn();

        stub.session.queue.push('steer row', createMode(), 'steer');
        stub.session.queue.push('newer row', createMode(), 'newer');
        // Dispatched, then rejected outright: the ACP request is finished, but
        // the definite rejection is restoring the row through a slow queued ACK.
        await expect(steerHandlerOf(stub)({ localId: 'steer' })).resolves.toEqual({ steered: true });
        harness.deferSteerState = new Promise<void>((resolve) => { releaseQueuedState = resolve; });
        rejectSoftSteer(new Error('session/prompt rejected'));
        await vi.waitFor(() => expect(harness.steerStateCalls).toContainEqual(
            { localIds: ['steer'], state: 'queued' }
        ));

        // A stall lands mid-restore. The soft request is already settled, so
        // this must not force-settle the backend nor release the row's drain
        // tracking.
        harness.stderrHandler!({
            type: 'quota_exceeded',
            message: 'API quota exceeded. Retrying in 30 seconds',
            raw: 'quota exceeded'
        });
        await vi.waitFor(() => expect(harness.cancelPrompt).toHaveBeenCalledWith('acp-session-1'));
        // Two turns of the event loop are enough for the cancel's finally to
        // have run: the settled request must not trigger a counter force-settle.
        await new Promise<void>((resolve) => setImmediate(resolve));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(harness.abortSoftSteersCalls).toBe(0);

        releasePrompt();
        await vi.waitFor(() => expect(harness.events).toContain('prompt:end'));
        // The newer row must not overtake a steer row that is still being
        // restored, and no ready may fire while it is held.
        expect(harness.promptCount).toBe(1);
        expect(stub.sessionEvents.filter((event) => event.type === 'ready')).toEqual([]);

        releaseQueuedState();
        await vi.waitFor(() => expect(harness.promptCount).toBe(2));
        expect(harness.promptContents[1]).toEqual([{ type: 'text', text: 'steer row\nnewer row' }]);
        expect(stub.emitMessagesConsumedCalls).toEqual([]);
        expect(stub.steerIndeterminateCalls).toEqual([]);

        harness.deferSteerState = null;
        harness.deferSoftSteer = null;
        stub.session.queue.close();
        await runPromise;
    });

    it('keeps a newer turn\'s soft-steer ownership when an older settled request reports late', async () => {
        let settleFirst!: () => void;
        const firstCompletion = new Promise<void>((resolve) => { settleFirst = resolve; });
        harness.deferSoftSteer = firstCompletion;
        const { stub, releasePrompt, runPromise } = await startTurn();

        // Turn 1: a steer whose request this turn's Stop force-settles.
        stub.session.queue.push('first steer', createMode(), 'steer-1');
        await expect(steerHandlerOf(stub)({ localId: 'steer-1' })).resolves.toEqual({ steered: true });
        await (stub.rpcHandlers.get('abort') as () => Promise<void>)();
        expect(harness.abortSoftSteersCalls).toBe(1);
        releasePrompt();

        // Turn 2 runs and dispatches its own still-unanswered soft request.
        let releaseSecond!: () => void;
        harness.promptImpl = () => new Promise<void>((resolve) => { releaseSecond = resolve; });
        stub.session.queue.push('second turn', createMode(), 'turn-2');
        await vi.waitFor(() => expect(harness.promptCount).toBe(2));
        harness.deferSoftSteer = new Promise<void>(() => {});
        stub.session.queue.push('second steer', createMode(), 'steer-2');
        await expect(steerHandlerOf(stub)({ localId: 'steer-2' })).resolves.toEqual({ steered: true });
        expect(harness.softSteerCalls).toHaveLength(2);

        // Turn 1's request finally answers, long after its own ownership was
        // settled. It may only clear its own record and flag.
        harness.deferSoftSteer = null;
        settleFirst();
        await new Promise<void>((resolve) => setImmediate(resolve));

        // Turn 2's ownership survived that late report, so its Stop still
        // recognises the outstanding request and recovers the counters.
        await (stub.rpcHandlers.get('abort') as () => Promise<void>)();
        expect(harness.abortSoftSteersCalls).toBe(2);

        harness.promptImpl = null;
        releaseSecond();
        stub.session.queue.close();
        await runPromise;
    });

    it('handles a steer accepted before an abort exactly once', async () => {
        let releaseSoftSteer!: () => void;
        harness.deferSoftSteer = new Promise<void>((resolve) => { releaseSoftSteer = resolve; });
        const { stub, releasePrompt, runPromise } = await startTurn();

        stub.session.queue.push('mid-turn correction', createMode(), 'steer');
        await expect(steerHandlerOf(stub)({ localId: 'steer' })).resolves.toEqual({ steered: true });

        await (stub.rpcHandlers.get('abort') as () => Promise<void>)();
        // The still-pending steer's ACP bookkeeping is force-settled so it
        // cannot hold the next turn's message handler.
        expect(harness.abortSoftSteersCalls).toBe(1);
        releaseSoftSteer();

        await vi.waitFor(() => expect(stub.emitMessagesConsumedCalls).toContainEqual(
            { localIds: ['steer'], options: { steered: true } }
        ));
        expect(stub.emitMessagesConsumedCalls.filter((call) => call.localIds.includes('steer'))).toHaveLength(1);
        expect(stub.steerIndeterminateCalls).toEqual([]);

        harness.deferSoftSteer = null;
        await stopTurn(stub, releasePrompt, runPromise);
    });

    it('does not resurrect a steer row the user explicitly cancelled after a restore', async () => {
        harness.softSteerDispatchError = new Error('session/prompt rejected');
        const { stub, releasePrompt, runPromise } = await startTurn();

        stub.session.queue.push('mid-turn correction', createMode(), 'steer');
        await expect(steerHandlerOf(stub)({ localId: 'steer' })).resolves.toEqual({
            steered: false,
            error: 'Failed to soft-steer into active turn'
        });
        expect(stub.session.queue.peekByLocalId('steer')).not.toBeNull();

        // Explicit cancel of the restored row: it must not come back, and the
        // next prompt must not be given the abandoned input.
        expect(stub.session.queue.cancelByLocalId('steer')).toBe(true);
        expect(stub.session.queue.peekByLocalId('steer')).toBeNull();
        expect(stub.emitMessagesConsumedCalls).toEqual([]);

        await stopTurn(stub, releasePrompt, runPromise);
        expect(harness.promptContents.every((content) => JSON.stringify(content).includes('mid-turn correction') === false))
            .toBe(true);
    });
});

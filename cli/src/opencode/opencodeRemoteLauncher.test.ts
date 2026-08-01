import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import type { OpencodeMode, PermissionMode } from './types';

const harness = vi.hoisted(() => ({
    setModelArgs: [] as Array<{ sessionId: string; modelId: string; flavor?: string }>,
    setConfigOptionArgs: [] as Array<{ sessionId: string; configId: string; value: string }>,
    promptCount: 0,
    promptContents: [] as unknown[],
    refreshSessionInfoCalls: [] as Array<{ sessionId: string; cwd: string }>,
    bridgeOptions: null as { enableChangeTitle?: boolean; skillLookup?: { workingDirectory: string; flavor: string } } | null,
    events: [] as string[],
    setModelImpl: null as null | ((sessionId: string, modelId: string) => Promise<void>),
    setConfigOptionImpl: null as null | ((sessionId: string, configId: string, value: string) => Promise<void>),
    thoughtLevelOption: null as null | { id: string; currentValue?: string; options: Array<{ value: string; name?: string }> },
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
    newSessionImpl: null as null | (() => Promise<string>)
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
            if (harness.promptImpl) {
                await harness.promptImpl();
            } else {
                await new Promise<void>((resolve) => setImmediate(resolve));
            }
            harness.events.push('prompt:end');
        }),
        cancelPrompt: vi.fn(async () => {
            if (harness.cancelPromptImpl) {
                await harness.cancelPromptImpl();
            }
        }),
        respondToPermission: vi.fn(async () => {}),
        onStderrError: vi.fn(),
        setSessionInfoUpdateListener: vi.fn(),
        refreshSessionInfo: vi.fn(async (sessionId: string, cwd: string) => {
            harness.refreshSessionInfoCalls.push({ sessionId, cwd });
        }),
        onPermissionRequest: vi.fn(),
        disconnect: vi.fn(async () => {}),
        getSessionModelsMetadata: vi.fn(() => harness.sessionModelsMetadata),
        getThoughtLevelConfigOption: vi.fn(() => harness.thoughtLevelOption ?? undefined),
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
            server: { stop: () => {} },
            mcpServers: {}
        };
    }
}));

vi.mock('./utils/permissionHandler', () => ({
    OpencodePermissionHandler: class {
        async cancelAll(): Promise<void> {}
    }
}));

vi.mock('@/ui/ink/OpencodeDisplay', () => ({
    OpencodeDisplay: () => null
}));

const compactHarness = vi.hoisted(() => ({
    calls: [] as Array<{ baseUrl: string; sessionId: string; providerId: string; modelId: string; signal?: AbortSignal }>,
    result: { ok: true } as { ok: true } | { ok: false; error: string },
    summaryCalls: [] as Array<{ baseUrl: string; sessionId: string; signal?: AbortSignal }>,
    summaryResult: { found: false } as { found: true; text: string } | { found: false },
    // Lets a test simulate a REST call that only settles once its signal is
    // aborted (mirroring how a real fetch() behaves under AbortSignal) —
    // needed to test that handleAbort() actually unblocks an in-flight
    // /compact instead of the default immediate-resolve behavior below.
    triggerImpl: null as null | ((opts: { baseUrl: string; sessionId: string; providerId: string; modelId: string; signal?: AbortSignal }) => Promise<{ ok: true } | { ok: false; error: string }>),
    // Same idea, for the GET that runs right after a successful POST — this
    // is what a PR-review round found was missing a signal entirely.
    summaryImpl: null as null | ((opts: { baseUrl: string; sessionId: string; signal?: AbortSignal }) => Promise<{ found: true; text: string } | { found: false }>)
}));

vi.mock('./utils/opencodeCompactBridge', () => ({
    splitProviderModel: (combined: string | null | undefined) => {
        if (!combined) return null;
        const idx = combined.indexOf('/');
        if (idx <= 0 || idx === combined.length - 1) return null;
        return { providerId: combined.slice(0, idx), modelId: combined.slice(idx + 1) };
    },
    triggerOpencodeCompact: vi.fn(async (opts: { baseUrl: string; sessionId: string; providerId: string; modelId: string; signal?: AbortSignal }) => {
        compactHarness.calls.push(opts);
        if (compactHarness.triggerImpl) {
            return compactHarness.triggerImpl(opts);
        }
        return compactHarness.result;
    }),
    fetchCompactionSummary: vi.fn(async (opts: { baseUrl: string; sessionId: string; signal?: AbortSignal }) => {
        compactHarness.summaryCalls.push(opts);
        if (compactHarness.summaryImpl) {
            return compactHarness.summaryImpl(opts);
        }
        return compactHarness.summaryResult;
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
    const rpcHandlers = new Map<string, (params: unknown) => unknown>();
    const setModelReasoningEffort = vi.fn();
    const pushKeepAlive = vi.fn();
    const emitMessagesConsumedCalls: Array<{ localIds: string[]; options?: { clearQueuedThinkingGrace?: boolean } }> = [];
    const thinkingChangeCalls: boolean[] = [];

    const client = {
        rpcHandlerManager: {
            registerHandler(method: string, handler: (params: unknown) => unknown) {
                rpcHandlers.set(method, handler);
            }
        },
        sendAgentMessage(_message: unknown) {},
        sendClaudeSessionMessage(_message: unknown) {},
        sendUserMessage(_text: string) {},
        sendSessionEvent(event: { type: string; [key: string]: unknown }) {
            sessionEvents.push(event);
        },
        emitMessagesConsumed(localIds: string[], options?: { clearQueuedThinkingGrace?: boolean }) {
            emitMessagesConsumedCalls.push({ localIds, options });
        }
    };

    const session = {
        path: '/tmp/hapi-opencode-test',
        logPath: '/tmp/hapi-opencode-test/test.log',
        client,
        queue,
        sessionId: null as string | null,
        thinking: false,
        getPermissionMode() {
            return 'default' as const;
        },
        setModel(_model: string | null) {},
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

    return { session, sessionEvents, sentAgentMessages, rpcHandlers, setModelReasoningEffort, pushKeepAlive, emitMessagesConsumedCalls, thinkingChangeCalls };
}

function createCompactMode(model?: string): OpencodeMode {
    return {
        permissionMode: 'default' as PermissionMode,
        model,
        operation: 'compact'
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
        harness.setModelImpl = null;
        harness.setConfigOptionImpl = null;
        harness.thoughtLevelOption = null;
        compactHarness.calls = [];
        compactHarness.result = { ok: true };
        compactHarness.summaryCalls = [];
        compactHarness.summaryResult = { found: false };
        compactHarness.triggerImpl = null;
        compactHarness.summaryImpl = null;
        harness.promptImpl = null;
        harness.sessionModelsMetadata = undefined;
        harness.cancelPromptImpl = null;
        harness.newSessionImpl = null;
        inkHarness.lastRenderProps = null;
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

    it('a queued /compact operation posts to the REST bridge using the session baseUrl and current model, and reports started/completed', async () => {
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
            disconnect: vi.fn(async () => {}),
            getSessionModelsMetadata: vi.fn(() => ({
                currentModelId: 'ollama/qwen3.6:35b-a3b-q8_0-mtp',
                availableModels: []
            })),
            suppressUpdatesDuring: vi.fn(async <T>(fn: () => Promise<T>): Promise<T> => fn())
        }));

        const { session, sessionEvents } = createSessionStub([
            { message: '', mode: createCompactMode() }
        ]);

        await opencodeRemoteLauncher(session as never);

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

    it('switch-to-local also interrupts an in-flight fetchCompactionSummary GET (not just the triggerOpencodeCompact POST)', async () => {
        // Reproduces a second PR-review round's finding: the fix above only
        // wired the abort signal through triggerOpencodeCompact (the POST).
        // fetchCompactionSummary (the GET runCompactOperation() calls right
        // after a successful POST) still had no way to be interrupted, so
        // Stop/switch-to-local could still block for as long as *that* call
        // took even after the POST-side fix landed. Here the POST resolves
        // immediately (ok:true) and the GET is the one that only settles on
        // abort.
        harness.sessionModelsMetadata = { currentModelId: 'ollama/x', availableModels: [] };
        let capturedSignal: AbortSignal | undefined;
        compactHarness.summaryImpl = (opts) => new Promise((resolve) => {
            capturedSignal = opts.signal;
            opts.signal?.addEventListener('abort', () => {
                resolve({ found: false });
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
        while (compactHarness.summaryCalls.length === 0) {
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

    it('sends the fetched compaction summary as a reasoning-type agent message', async () => {
        compactHarness.summaryResult = { found: true, text: '## Objective\n- Did the thing' };
        harness.sessionModelsMetadata = { currentModelId: 'ollama/qwen3.6:35b-a3b-q8_0-mtp', availableModels: [] };

        const { session, sentAgentMessages } = createSessionStub([
            { message: '', mode: createCompactMode() }
        ]);

        await opencodeRemoteLauncher(session as never);

        expect(compactHarness.summaryCalls).toEqual([
            { baseUrl: 'http://127.0.0.1:48273', sessionId: 'acp-session-1', signal: expect.any(AbortSignal) }
        ]);
        expect(sentAgentMessages).toEqual([
            { type: 'reasoning', message: '## Objective\n- Did the thing', id: expect.any(String) }
        ]);
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

        expect(compactHarness.summaryCalls).toEqual([]);
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

    it('a switch-to-local firing during the inline model switch that precedes a compact batch still interrupts that compact once it runs, instead of the abort landing on a not-yet-created controller', async () => {
        // Reproduces a hostile-review whole-feature-sweep finding: the
        // dequeue loop applies the inline model/effort switch to every batch
        // (including operation:'compact' ones) *before* branching into
        // runCompactOperation() — which is where compactAbortController used
        // to get created. backend.setModel()/setConfigOption() are real
        // async ACP round-trips that yield to the event loop, so an abort
        // firing in that window used to hit a still-null
        // compactAbortController (a no-op), and by the time the switch
        // resolved and runCompactOperation() created a *fresh* controller,
        // all memory of the abort was gone — the unbounded compact REST call
        // then ran to completion uninterrupted.
        //
        // Uses 'switch' (not plain 'abort'/Stop) since a later round split
        // handleAbort()'s behavior: only switch-to-local/exit
        // (leavingRemote=true) actually aborts compactAbortController.signal
        // — plain Stop now only suppresses the result and deliberately
        // leaves the signal alone (see compactResultSuppressed's doc
        // comment). The controller-must-already-exist regression this test
        // protects against still applies identically to switch/exit.
        harness.sessionModelsMetadata = { currentModelId: 'ollama/launch-default', availableModels: [] };
        let resolveSetModel: (() => void) | null = null;
        harness.setModelImpl = () => new Promise<void>((resolve) => {
            resolveSetModel = resolve;
        });

        let capturedSignal: AbortSignal | undefined;
        compactHarness.triggerImpl = (opts) => {
            capturedSignal = opts.signal;
            return Promise.resolve({ ok: true });
        };

        const { session, rpcHandlers } = createSessionStub([
            { message: '', mode: createCompactMode('ollama/switched') }
        ]);

        const launcherPromise = opencodeRemoteLauncher(session as never, {
            onCompactAvailabilityChange: () => {}
        });

        // Wait until the model switch is actually in flight. setModelArgs is
        // pushed synchronously before setModelImpl() is awaited (see the
        // base mock above), so by the time this is non-empty, resolveSetModel
        // is already assigned too.
        while (harness.setModelArgs.length === 0) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(compactHarness.calls).toEqual([]);

        const switchHandler = rpcHandlers.get('switch') as (() => Promise<void>) | undefined;
        expect(switchHandler).toBeDefined();
        await switchHandler!();

        // Release the switch; the loop now proceeds into the compact batch.
        // (Cast re-widens the type: TS narrows `resolveSetModel` to `never`
        // here otherwise, since its only visible assignment is inside the
        // nested Promise executor above and TS's control-flow analysis
        // doesn't account for that closure running before this point.)
        (resolveSetModel as (() => void) | null)?.();

        while (compactHarness.calls.length === 0) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }

        // The controller the switch acted on during the model switch must be
        // the SAME one threaded into the compact REST call — not a fresh,
        // never-aborted one created after the fact.
        expect(capturedSignal?.aborted).toBe(true);

        session.queue.close();
        await Promise.race([
            launcherPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('launcher did not exit in time')), 2000))
        ]);
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
        let attempts = 0;
        harness.setModelImpl = async () => {
            attempts++;
            throw new Error('Transient backend failure');
        };
        const { session, sessionEvents } = createSessionStub([
            { message: 'first', mode: createMode('ollama/a') },
            { message: 'second', mode: createMode('ollama/b') }
        ]);

        await opencodeRemoteLauncher(session as never);

        expect(attempts).toBe(1);
        const failureMessages = sessionEvents.filter(
            (event) =>
                event.type === 'message' &&
                typeof event.message === 'string' &&
                event.message.includes('Failed to switch model')
        );
        expect(failureMessages.length).toBe(1);
        expect(failureMessages[0]?.message).toContain('ollama/b');
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
            disconnect: vi.fn(async () => {}),
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
            currentValue: 'low'
        });
    });

    it('listOpencodeReasoningEffortOptions handler returns unavailable when backend has no thought level option', async () => {
        const { session, rpcHandlers } = createSessionStub([
            { message: 'first', mode: createMode() }
        ]);
        await opencodeRemoteLauncher(session as never);

        const handler = rpcHandlers.get('listOpencodeReasoningEffortOptions');
        expect(handler).toBeDefined();
        const result = await handler!(undefined) as Record<string, unknown>;
        expect(result).toEqual({
            success: false,
            error: 'OpenCode reasoning effort options are not available'
        });
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

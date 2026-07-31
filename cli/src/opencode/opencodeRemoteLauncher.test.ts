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
    sessionModelsMetadata: undefined as undefined | { currentModelId: string; availableModels: unknown[] }
}));

vi.mock('./utils/opencodeBackend', () => ({
    allocateFreePort: vi.fn(async () => 48273),
    createOpencodeBackend: vi.fn(() => ({
        initialize: vi.fn(async () => {}),
        newSession: vi.fn(async () => 'acp-session-1'),
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
        cancelPrompt: vi.fn(async () => {}),
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
    summaryCalls: [] as Array<{ baseUrl: string; sessionId: string }>,
    summaryResult: { found: false } as { found: true; text: string } | { found: false },
    // Lets a test simulate a REST call that only settles once its signal is
    // aborted (mirroring how a real fetch() behaves under AbortSignal) —
    // needed to test that handleAbort() actually unblocks an in-flight
    // /compact instead of the default immediate-resolve behavior below.
    triggerImpl: null as null | ((opts: { baseUrl: string; sessionId: string; providerId: string; modelId: string; signal?: AbortSignal }) => Promise<{ ok: true } | { ok: false; error: string }>)
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
    fetchCompactionSummary: vi.fn(async (opts: { baseUrl: string; sessionId: string }) => {
        compactHarness.summaryCalls.push(opts);
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

import { opencodeRemoteLauncher } from './opencodeRemoteLauncher';

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

    return { session, sessionEvents, sentAgentMessages, rpcHandlers, setModelReasoningEffort, pushKeepAlive };
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
        harness.promptImpl = null;
        harness.sessionModelsMetadata = undefined;
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

    it('sends the fetched compaction summary as a reasoning-type agent message', async () => {
        compactHarness.summaryResult = { found: true, text: '## Objective\n- Did the thing' };
        harness.sessionModelsMetadata = { currentModelId: 'ollama/qwen3.6:35b-a3b-q8_0-mtp', availableModels: [] };

        const { session, sentAgentMessages } = createSessionStub([
            { message: '', mode: createCompactMode() }
        ]);

        await opencodeRemoteLauncher(session as never);

        expect(compactHarness.summaryCalls).toEqual([
            { baseUrl: 'http://127.0.0.1:48273', sessionId: 'acp-session-1' }
        ]);
        expect(sentAgentMessages).toEqual([
            { type: 'reasoning', message: '## Objective\n- Did the thing', id: expect.any(String) }
        ]);
    });

    it('suppresses the Compaction completed result if the item is cancelled after being dequeued', async () => {
        // A /compact item's REST call can run for minutes, well past the
        // point messageQueue.cancelByLocalId (runOpencode.ts) could still
        // catch it — isLocalIdCancelled is how the launcher finds out a
        // cancel landed while it was running.
        harness.sessionModelsMetadata = { currentModelId: 'ollama/x', availableModels: [] };
        const isLocalIdCancelled = vi.fn((id: string) => id === 'compact-1');

        const { session, sessionEvents, sentAgentMessages } = createSessionStub([
            { message: '', mode: createCompactMode('ollama/x'), localId: 'compact-1' }
        ]);

        await opencodeRemoteLauncher(session as never, { isLocalIdCancelled });

        expect(isLocalIdCancelled).toHaveBeenCalledWith('compact-1');
        const messages = sessionEvents.filter((event) => event.type === 'message').map((event) => event.message);
        // "Compaction started" is never suppressed (it wasn't before this
        // redesign either) — only the eventual result is.
        expect(messages).toEqual(['📦 Compaction started']);
        expect(sentAgentMessages).toEqual([]);
    });

    it('suppresses a Compaction failed result too if the item is cancelled after being dequeued', async () => {
        harness.sessionModelsMetadata = { currentModelId: 'ollama/x', availableModels: [] };
        const { triggerOpencodeCompact } = await import('./utils/opencodeCompactBridge');
        (triggerOpencodeCompact as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => ({ ok: false, error: 'boom' }));
        const isLocalIdCancelled = vi.fn(() => true);

        const { session, sessionEvents } = createSessionStub([
            { message: '', mode: createCompactMode('ollama/x'), localId: 'compact-2' }
        ]);

        await opencodeRemoteLauncher(session as never, { isLocalIdCancelled });

        const messages = sessionEvents.filter((event) => event.type === 'message').map((event) => event.message);
        expect(messages).toEqual(['📦 Compaction started']);
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

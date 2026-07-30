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
        getThoughtLevelConfigOption: vi.fn(() => harness.thoughtLevelOption ?? undefined)
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
    calls: [] as Array<{ baseUrl: string; sessionId: string; providerId: string; modelId: string }>,
    result: { ok: true } as { ok: true } | { ok: false; error: string },
    summaryCalls: [] as Array<{ baseUrl: string; sessionId: string }>,
    summaryResult: { found: false } as { found: true; text: string } | { found: false }
}));

vi.mock('./utils/opencodeCompactBridge', () => ({
    splitProviderModel: (combined: string | null | undefined) => {
        if (!combined) return null;
        const idx = combined.indexOf('/');
        if (idx <= 0 || idx === combined.length - 1) return null;
        return { providerId: combined.slice(0, idx), modelId: combined.slice(idx + 1) };
    },
    triggerOpencodeCompact: vi.fn(async (opts: { baseUrl: string; sessionId: string; providerId: string; modelId: string }) => {
        compactHarness.calls.push(opts);
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

function createSessionStub(items: Array<{ message: string; mode: OpencodeMode }>) {
    const queue = new MessageQueue2<OpencodeMode>((mode) => JSON.stringify(mode));
    items.forEach(({ message, mode }, index) => {
        if (index === 0 && items.length > 1) {
            queue.pushIsolateAndClear(message, mode);
        } else {
            queue.push(message, mode);
        }
    });
    queue.close();

    const sessionEvents: Array<{ type: string; [key: string]: unknown }> = [];
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
        sendAgentMessage(_message: unknown) {},
        sendSessionEvent(event: { type: string; [key: string]: unknown }) {
            client.sendSessionEvent(event);
        },
        sendUserMessage(_text: string) {}
    };

    return { session, sessionEvents, rpcHandlers, setModelReasoningEffort, pushKeepAlive };
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
        harness.promptImpl = null;
        harness.sessionModelsMetadata = undefined;
    });

    it('waits for an in-flight prompt to finish before starting a compact call', async () => {
        let resolvePrompt: (() => void) | null = null;
        harness.promptImpl = () => new Promise<void>((resolve) => {
            resolvePrompt = resolve;
        });

        const { session } = createSessionStub([
            { message: 'first', mode: createMode('ollama/x') }
        ]);

        let capturedTrigger: (() => Promise<{ ok: true } | { ok: false; error: string }>) | null = null;
        const launcherPromise = opencodeRemoteLauncher(session as never, {
            onCompactTriggerReady: (trigger) => {
                capturedTrigger = trigger;
            }
        });

        // Deterministically wait until the prompt is confirmed in-flight
        // (it will not resolve until we call resolvePrompt below).
        while (!harness.events.includes('prompt:start')) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(capturedTrigger).not.toBeNull();

        const compactPromise = capturedTrigger!();
        // Give the trigger several ticks to run ahead if it were (incorrectly)
        // not serialized — it must still be queued behind the in-flight
        // prompt via runExclusive, not calling the REST bridge yet.
        for (let i = 0; i < 5; i++) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(compactHarness.calls).toEqual([]);
        expect(harness.events).toEqual(['prompt:start']);

        resolvePrompt!();
        await launcherPromise;
        await compactPromise;

        expect(harness.events).toEqual(['prompt:start', 'prompt:end']);
        expect(compactHarness.calls.length).toBe(1);
    });

    it('blocks a new prompt from starting while a compact call is in progress', async () => {
        // Compact fires before any turn has been dequeued, so
        // currentBackendModel hasn't been seeded from a batch yet — the
        // trigger needs getSessionModelsMetadata (seeded right after
        // session/new) to resolve a provider/model pair.
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

        const { session } = createSessionStub([
            { message: 'only', mode: createMode('ollama/x') }
        ]);

        // `onCompactTriggerReady` fires synchronously before the launcher's
        // while-loop starts dequeuing. Invoking the trigger right inside that
        // callback (rather than polling for it afterwards) guarantees its
        // `runExclusive` call acquires the mutex before the main loop ever
        // gets a chance to — otherwise which side "wins" the race to call
        // `runExclusive` first would depend on unrelated scheduling details
        // (e.g. whether the queue already has data buffered), not on the
        // property this test is meant to verify.
        let compactPromise: Promise<{ ok: true } | { ok: false; error: string }> | null = null;
        const launcherPromise = opencodeRemoteLauncher(session as never, {
            onCompactTriggerReady: (trigger) => {
                compactPromise = trigger();
            }
        });

        // Give the main loop plenty of ticks to (incorrectly) start the
        // queued prompt if it weren't serialized behind the compact call.
        for (let i = 0; i < 10; i++) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(compactHarness.calls.length).toBe(1);
        expect(harness.promptCount).toBe(0);
        expect(harness.events).toEqual([]);

        resolveCompact!();
        await compactPromise;
        await launcherPromise;

        expect(harness.promptCount).toBe(1);
        expect(harness.events).toEqual(['prompt:start', 'prompt:end']);
    });

    it('registers a compact trigger that posts to the REST bridge using the session baseUrl and current model', async () => {
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
            }))
        }));

        const { session } = createSessionStub([
            { message: 'first', mode: createMode() }
        ]);

        let capturedTrigger: (() => Promise<{ ok: true } | { ok: false; error: string }>) | null = null;
        await opencodeRemoteLauncher(session as never, {
            onCompactTriggerReady: (trigger) => {
                capturedTrigger = trigger;
            }
        });

        expect(capturedTrigger).not.toBeNull();
        const result = await capturedTrigger!();
        expect(result).toEqual({ ok: true });
        expect(compactHarness.calls).toEqual([
            {
                baseUrl: 'http://127.0.0.1:48273',
                sessionId: 'acp-session-1',
                providerId: 'ollama',
                modelId: 'qwen3.6:35b-a3b-q8_0-mtp'
            }
        ]);
    });

    it('attaches the fetched summary text to a successful compact result', async () => {
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
            }))
        }));
        compactHarness.summaryResult = { found: true, text: '## Objective\n- Did the thing' };

        const { session } = createSessionStub([
            { message: 'first', mode: createMode() }
        ]);

        let capturedTrigger: (() => Promise<{ ok: true; summaryText?: string } | { ok: false; error: string }>) | null = null;
        await opencodeRemoteLauncher(session as never, {
            onCompactTriggerReady: (trigger) => {
                capturedTrigger = trigger;
            }
        });

        const result = await capturedTrigger!();
        expect(result).toEqual({ ok: true, summaryText: '## Objective\n- Did the thing' });
        expect(compactHarness.summaryCalls).toEqual([
            { baseUrl: 'http://127.0.0.1:48273', sessionId: 'acp-session-1' }
        ]);
    });

    it('does not look up a summary when the compact REST call itself failed', async () => {
        const { triggerOpencodeCompact } = await import('./utils/opencodeCompactBridge');
        (triggerOpencodeCompact as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => ({ ok: false, error: 'boom' }));

        const { session } = createSessionStub([
            { message: 'first', mode: createMode('ollama/x') }
        ]);

        let capturedTrigger: (() => Promise<{ ok: true } | { ok: false; error: string }>) | null = null;
        await opencodeRemoteLauncher(session as never, {
            onCompactTriggerReady: (trigger) => {
                capturedTrigger = trigger;
            }
        });

        const result = await capturedTrigger!();
        expect(result).toEqual({ ok: false, error: 'boom' });
        expect(compactHarness.summaryCalls).toEqual([]);
    });

    it('compact trigger reports a clear failure when the session has no model metadata', async () => {
        // Default harness mock's getSessionModelsMetadata returns undefined.
        const { session } = createSessionStub([
            { message: 'first', mode: createMode() }
        ]);

        let capturedTrigger: (() => Promise<{ ok: true } | { ok: false; error: string }>) | null = null;
        await opencodeRemoteLauncher(session as never, {
            onCompactTriggerReady: (trigger) => {
                capturedTrigger = trigger;
            }
        });

        const result = await capturedTrigger!();
        expect(result.ok).toBe(false);
        expect(compactHarness.calls).toEqual([]);
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

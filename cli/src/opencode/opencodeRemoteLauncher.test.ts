import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import type { OpencodeMode, PermissionMode } from './types';

const harness = vi.hoisted(() => ({
    setModelArgs: [] as Array<{ sessionId: string; modelId: string; flavor?: string }>,
    setConfigOptionArgs: [] as Array<{ sessionId: string; configId: string; value: string }>,
    promptCount: 0,
    promptContents: [] as unknown[],
    events: [] as string[],
    setModelImpl: null as null | ((sessionId: string, modelId: string) => Promise<void>),
    setConfigOptionImpl: null as null | ((sessionId: string, configId: string, value: string) => Promise<void>),
    thoughtLevelOption: null as null | { id: string; currentValue?: string; options: Array<{ value: string; name?: string }> }
}));

vi.mock('./utils/opencodeBackend', () => ({
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
            await new Promise<void>((resolve) => setImmediate(resolve));
            harness.events.push('prompt:end');
        }),
        cancelPrompt: vi.fn(async () => {}),
        respondToPermission: vi.fn(async () => {}),
        onStderrError: vi.fn(),
        onPermissionRequest: vi.fn(),
        disconnect: vi.fn(async () => {}),
        getSessionModelsMetadata: vi.fn(() => undefined),
        getThoughtLevelConfigOption: vi.fn(() => harness.thoughtLevelOption ?? undefined)
    }))
}));

vi.mock('@/codex/utils/buildHapiMcpBridge', () => ({
    buildHapiMcpBridge: async () => ({
        server: { stop: () => {} },
        mcpServers: {}
    })
}));

vi.mock('./utils/permissionHandler', () => ({
    OpencodePermissionHandler: class {
        async cancelAll(): Promise<void> {}
    }
}));

vi.mock('@/ui/ink/OpencodeDisplay', () => ({
    OpencodeDisplay: () => null
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
        harness.events = [];
        harness.setModelImpl = null;
        harness.setConfigOptionImpl = null;
        harness.thoughtLevelOption = null;
    });

    it('calls setModel with opencode flavor between turns when the queued model differs', async () => {
        const { session } = createSessionStub([
            { message: 'first', mode: createMode('ollama/exaone:4.5-33b-q8') },
            { message: 'second', mode: createMode('mlx/qwen3:0.6b') }
        ]);

        await opencodeRemoteLauncher(session as never);

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

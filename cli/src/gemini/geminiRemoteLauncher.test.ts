import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import type { GeminiMode, PermissionMode } from './types';

const harness = vi.hoisted(() => ({
    setModelArgs: [] as Array<{ sessionId: string; modelId: string }>,
    promptCount: 0,
    events: [] as string[],
    setModelImpl: null as null | ((sessionId: string, modelId: string) => Promise<void>)
}));

vi.mock('./utils/geminiBackend', () => ({
    createGeminiBackend: vi.fn(() => ({
        initialize: vi.fn(async () => {}),
        newSession: vi.fn(async () => 'acp-session-1'),
        loadSession: vi.fn(async () => 'acp-session-1'),
        setModel: vi.fn(async (sessionId: string, modelId: string) => {
            harness.events.push(`setModel:${modelId}`);
            harness.setModelArgs.push({ sessionId, modelId });
            if (harness.setModelImpl) {
                await harness.setModelImpl(sessionId, modelId);
            }
        }),
        prompt: vi.fn(async () => {
            harness.events.push('prompt:start');
            harness.promptCount++;
            await new Promise<void>((resolve) => setImmediate(resolve));
            harness.events.push('prompt:end');
        }),
        cancelPrompt: vi.fn(async () => {}),
        respondToPermission: vi.fn(async () => {}),
        onStderrError: vi.fn(),
        onPermissionRequest: vi.fn(),
        disconnect: vi.fn(async () => {})
    }))
}));

vi.mock('@/codex/utils/buildHapiMcpBridge', () => ({
    buildHapiMcpBridge: async () => ({
        server: { stop: () => {} },
        mcpServers: {}
    })
}));

vi.mock('./utils/permissionHandler', () => ({
    GeminiPermissionHandler: class {
        async cancelAll(): Promise<void> {}
    }
}));

vi.mock('./utils/config', () => ({
    resolveGeminiRuntimeConfig: () => ({
        model: 'gemini-3-flash-preview',
        modelSource: 'default'
    })
}));

vi.mock('@/ui/ink/GeminiDisplay', () => ({
    GeminiDisplay: () => null
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        warn: vi.fn(),
        info: vi.fn()
    }
}));

import { geminiRemoteLauncher } from './geminiRemoteLauncher';

function createMode(model?: string): GeminiMode {
    return {
        permissionMode: 'default' as PermissionMode,
        model
    };
}

function createSessionStub(items: Array<{ message: string; mode: GeminiMode }>) {
    const queue = new MessageQueue2<GeminiMode>((mode) => JSON.stringify(mode));
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
        path: '/tmp/hapi-gemini-test',
        logPath: '/tmp/hapi-gemini-test/test.log',
        client,
        queue,
        sessionId: null as string | null,
        thinking: false,
        getPermissionMode() {
            return 'default' as const;
        },
        setModel(_model: string | null) {},
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

    return { session, sessionEvents, rpcHandlers };
}

describe('geminiRemoteLauncher inline model switch', () => {
    afterEach(() => {
        harness.setModelArgs = [];
        harness.promptCount = 0;
        harness.events = [];
        harness.setModelImpl = null;
    });

    it('calls setModel between turns when the queued model differs from the running backend model', async () => {
        const { session } = createSessionStub([
            { message: 'first', mode: createMode('gemini-3-flash-preview') },
            { message: 'second', mode: createMode('gemini-2.5-pro') }
        ]);

        await geminiRemoteLauncher(session as never, {});

        expect(harness.setModelArgs).toEqual([
            { sessionId: 'acp-session-1', modelId: 'gemini-2.5-pro' }
        ]);
        expect(harness.promptCount).toBe(2);
    });

    it('does not call setModel when the model is unchanged across turns', async () => {
        const { session } = createSessionStub([
            { message: 'first', mode: createMode('gemini-3-flash-preview') },
            { message: 'second', mode: createMode('gemini-3-flash-preview') }
        ]);

        await geminiRemoteLauncher(session as never, {});

        expect(harness.setModelArgs).toEqual([]);
        expect(harness.promptCount).toBe(2);
    });

    it('latches inline switching off after a method-not-found response and notifies the user once', async () => {
        harness.setModelImpl = async () => {
            throw new Error('Method not found: session/set_model');
        };
        const { session, sessionEvents } = createSessionStub([
            { message: 'first', mode: createMode('gemini-3-flash-preview') },
            { message: 'second', mode: createMode('gemini-2.5-pro') },
            { message: 'third', mode: createMode('gemini-2.5-flash') }
        ]);

        await geminiRemoteLauncher(session as never, {});

        // Only one setModel attempt — latched off after the first method-not-found
        expect(harness.setModelArgs).toEqual([
            { sessionId: 'acp-session-1', modelId: 'gemini-2.5-pro' }
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
            { message: 'first', mode: createMode('gemini-3-flash-preview') },
            { message: 'second', mode: createMode('gemini-2.5-pro') }
        ]);

        await geminiRemoteLauncher(session as never, {});

        expect(attempts).toBe(1);
        const failureMessages = sessionEvents.filter(
            (event) =>
                event.type === 'message' &&
                typeof event.message === 'string' &&
                event.message.includes('Failed to switch model')
        );
        expect(failureMessages.length).toBe(1);
        expect(failureMessages[0]?.message).toContain('gemini-2.5-pro');
        expect(harness.promptCount).toBe(2);
    });

    it('serializes setModel after the previous prompt resolves', async () => {
        const { session } = createSessionStub([
            { message: 'first', mode: createMode('gemini-3-flash-preview') },
            { message: 'second', mode: createMode('gemini-2.5-pro') }
        ]);

        await geminiRemoteLauncher(session as never, {});

        // Order must be: prompt(1) start/end → setModel → prompt(2) start/end
        expect(harness.events).toEqual([
            'prompt:start',
            'prompt:end',
            'setModel:gemini-2.5-pro',
            'prompt:start',
            'prompt:end'
        ]);
    });
});

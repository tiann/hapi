import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockOpencodeSession = vi.hoisted(() => ({
    setModel: vi.fn(),
    setPermissionMode: vi.fn(),
    pushKeepAlive: vi.fn(),
    thinking: false,
    stopKeepAlive: vi.fn()
}));

const harness = vi.hoisted(() => ({
    bootstrapArgs: [] as Array<Record<string, unknown>>,
    opencodeLoopArgs: [] as Array<Record<string, unknown>>,
    opencodeLoopError: null as Error | null,
    session: {
        onUserMessage: vi.fn(),
        onCancelQueuedMessage: vi.fn(),
        rpcHandlerManager: {
            registerHandler: vi.fn()
        }
    }
}));

vi.mock('@/agent/sessionFactory', () => ({
    bootstrapSession: vi.fn(async (options: Record<string, unknown>) => {
        harness.bootstrapArgs.push(options);
        return {
            api: {},
            session: harness.session
        };
    })
}));

vi.mock('./loop', () => ({
    opencodeLoop: vi.fn(async (options: Record<string, unknown>) => {
        harness.opencodeLoopArgs.push(options);
        if (harness.opencodeLoopError) {
            throw harness.opencodeLoopError;
        }
        const onSessionReady = options.onSessionReady as ((session: unknown) => void) | undefined;
        if (onSessionReady) {
            onSessionReady(mockOpencodeSession);
        }
    })
}));

vi.mock('@/claude/registerKillSessionHandler', () => ({
    registerKillSessionHandler: vi.fn()
}));

const lifecycleMock = vi.hoisted(() => ({
    registerProcessHandlers: vi.fn(),
    cleanupAndExit: vi.fn(async () => {}),
    markCrash: vi.fn(),
    setExitCode: vi.fn(),
    setArchiveReason: vi.fn(),
    setSessionEndReason: vi.fn()
}));

vi.mock('@/agent/runnerLifecycle', () => ({
    createModeChangeHandler: vi.fn(() => vi.fn()),
    createRunnerLifecycle: vi.fn(() => lifecycleMock),
    setControlledByUser: vi.fn()
}));

vi.mock('./utils/startOpencodeHookServer', () => ({
    startOpencodeHookServer: vi.fn(async () => ({
        port: 4242,
        stop: vi.fn()
    }))
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn()
    }
}));

vi.mock('@/utils/attachmentFormatter', () => ({
    formatMessageWithAttachments: vi.fn((text: string) => text)
}));

import { runOpencode } from './runOpencode';

describe('runOpencode set-session-config handler', () => {
    beforeEach(() => {
        harness.bootstrapArgs.length = 0;
        harness.opencodeLoopArgs.length = 0;
        harness.opencodeLoopError = null;
        mockOpencodeSession.setModel.mockReset();
        mockOpencodeSession.setPermissionMode.mockReset();
        mockOpencodeSession.pushKeepAlive.mockReset();
        harness.session.onUserMessage.mockReset();
        harness.session.rpcHandlerManager.registerHandler.mockReset();
        lifecycleMock.registerProcessHandlers.mockClear();
        lifecycleMock.cleanupAndExit.mockClear();
        lifecycleMock.markCrash.mockClear();
        lifecycleMock.setExitCode.mockClear();
        lifecycleMock.setArchiveReason.mockClear();
        lifecycleMock.setSessionEndReason.mockClear();
    });

    function getConfigHandler(): (payload: unknown) => Promise<unknown> {
        const registerCalls = harness.session.rpcHandlerManager.registerHandler.mock.calls;
        const configHandler = registerCalls.find(
            (call: unknown[]) => call[0] === 'set-session-config'
        );
        expect(configHandler).toBeDefined();
        return configHandler![1] as (payload: unknown) => Promise<unknown>;
    }

    it('applies model change via set-session-config RPC', async () => {
        await runOpencode({});

        const handler = getConfigHandler();
        const result = await handler({ model: 'ollama/exaone:4.5-33b-q8' }) as Record<string, unknown>;
        const applied = result.applied as Record<string, unknown>;
        expect(applied.model).toBe('ollama/exaone:4.5-33b-q8');
    });

    it('pushes a keepAlive immediately after a config change so the hub UI reflects it', async () => {
        await runOpencode({});

        // Reset to ignore pushKeepAlive fired from initial onSessionReady setup
        mockOpencodeSession.pushKeepAlive.mockClear();

        const handler = getConfigHandler();
        await handler({ model: 'ollama/exaone:4.5-33b-q8' });

        expect(mockOpencodeSession.pushKeepAlive).toHaveBeenCalledTimes(1);
    });

    it('stores the chosen model on the session for keepalive runtime metadata', async () => {
        await runOpencode({});

        const handler = getConfigHandler();
        await handler({ model: 'mlx/qwen3:0.6b' });

        expect(mockOpencodeSession.setModel).toHaveBeenLastCalledWith('mlx/qwen3:0.6b');
    });

    it('accepts null model (Default) and forwards null to the session', async () => {
        await runOpencode({});

        const handler = getConfigHandler();
        const result = await handler({ model: null }) as Record<string, unknown>;
        const applied = result.applied as Record<string, unknown>;

        expect(applied.model).toBeNull();
        expect(mockOpencodeSession.setModel).toHaveBeenLastCalledWith(null);
    });

    it('rejects non-string, non-null model values', async () => {
        await runOpencode({});

        const handler = getConfigHandler();
        await expect(handler({ model: 123 })).rejects.toThrow();
        await expect(handler({ model: '' })).rejects.toThrow();
        await expect(handler({ model: '   ' })).rejects.toThrow();
    });

    it('only includes changed fields in applied response', async () => {
        await runOpencode({});

        const handler = getConfigHandler();
        const result = await handler({ permissionMode: 'default' }) as Record<string, unknown>;
        const applied = result.applied as Record<string, unknown>;
        expect(applied.permissionMode).toBe('default');
        expect(applied).not.toHaveProperty('model');
    });

    it('still applies permissionMode-only payloads (no model field)', async () => {
        await runOpencode({});

        const handler = getConfigHandler();
        const result = await handler({ permissionMode: 'yolo' }) as Record<string, unknown>;
        const applied = result.applied as Record<string, unknown>;
        expect(applied.permissionMode).toBe('yolo');
    });

    it('passes initial model from opts through to the loop', async () => {
        await runOpencode({ model: 'ollama/exaone:4.5-33b-q8' });

        expect(harness.opencodeLoopArgs[0]?.model).toBe('ollama/exaone:4.5-33b-q8');
    });
});

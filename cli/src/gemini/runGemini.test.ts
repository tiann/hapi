import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGeminiSession = vi.hoisted(() => ({
    setModel: vi.fn(),
    setPermissionMode: vi.fn(),
    pushKeepAlive: vi.fn(),
    thinking: false,
    stopKeepAlive: vi.fn()
}));

const harness = vi.hoisted(() => ({
    bootstrapArgs: [] as Array<Record<string, unknown>>,
    geminiLoopArgs: [] as Array<Record<string, unknown>>,
    geminiLoopError: null as Error | null,
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
    geminiLoop: vi.fn(async (options: Record<string, unknown>) => {
        harness.geminiLoopArgs.push(options);
        if (harness.geminiLoopError) {
            throw harness.geminiLoopError;
        }
        const onSessionReady = options.onSessionReady as ((session: unknown) => void) | undefined;
        if (onSessionReady) {
            onSessionReady(mockGeminiSession);
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

vi.mock('@/claude/utils/startHookServer', () => ({
    startHookServer: vi.fn(async () => ({
        port: 1234,
        token: 'token',
        stop: vi.fn()
    }))
}));

vi.mock('@/modules/common/hooks/generateHookSettings', () => ({
    cleanupHookSettingsFile: vi.fn(),
    generateHookSettingsFile: vi.fn(() => '/tmp/gemini-hooks.json')
}));

const resolveGeminiRuntimeConfigMock = vi.hoisted(() => vi.fn());

vi.mock('./utils/config', () => ({
    resolveGeminiRuntimeConfig: resolveGeminiRuntimeConfigMock
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn()
    }
}));

vi.mock('@/utils/attachmentFormatter', () => ({
    formatMessageWithAttachments: vi.fn((text: string) => text)
}));

import { runGemini } from './runGemini';

describe('runGemini', () => {
    beforeEach(() => {
        harness.bootstrapArgs.length = 0;
        harness.geminiLoopArgs.length = 0;
        harness.geminiLoopError = null;
        mockGeminiSession.setModel.mockReset();
        mockGeminiSession.setPermissionMode.mockReset();
        harness.session.onUserMessage.mockReset();
        harness.session.rpcHandlerManager.registerHandler.mockReset();
        lifecycleMock.registerProcessHandlers.mockClear();
        lifecycleMock.cleanupAndExit.mockClear();
        lifecycleMock.markCrash.mockClear();
        lifecycleMock.setExitCode.mockClear();
        lifecycleMock.setArchiveReason.mockClear();
        lifecycleMock.setSessionEndReason.mockClear();
        resolveGeminiRuntimeConfigMock.mockReset();
    });

    it('persists a resolved config model before bootstrapping the session', async () => {
        resolveGeminiRuntimeConfigMock.mockReturnValue({
            model: 'gemini-3-pro-preview',
            modelSource: 'local'
        });

        await runGemini({});

        expect(harness.bootstrapArgs[0]?.model).toBe('gemini-3-pro-preview');
        expect(harness.geminiLoopArgs[0]?.model).toBe('gemini-3-pro-preview');
    });

    it('does not persist the hardcoded default fallback model so it floats with machine config', async () => {
        resolveGeminiRuntimeConfigMock.mockReturnValue({
            model: 'gemini-3-flash-preview',
            modelSource: 'default'
        });

        await runGemini({});

        expect(harness.bootstrapArgs[0]?.model).toBeUndefined();
        expect(harness.geminiLoopArgs[0]?.model).toBe('gemini-3-flash-preview');
    });

    it('applies model change via set-session-config RPC', async () => {
        resolveGeminiRuntimeConfigMock.mockReturnValue({
            model: 'gemini-3-flash-preview',
            modelSource: 'default'
        });

        await runGemini({});

        const registerCalls = harness.session.rpcHandlerManager.registerHandler.mock.calls;
        const configHandler = registerCalls.find(
            (call: unknown[]) => call[0] === 'set-session-config'
        );
        expect(configHandler).toBeDefined();

        const handler = configHandler![1] as (payload: unknown) => Promise<unknown>;
        const result = await handler({ model: 'gemini-2.5-flash' }) as Record<string, unknown>;
        const applied = result.applied as Record<string, unknown>;
        expect(applied.model).toBe('gemini-2.5-flash');
    });

    it('pushes a keepAlive immediately after a config change so the hub UI reflects it', async () => {
        resolveGeminiRuntimeConfigMock.mockReturnValue({
            model: 'gemini-3-flash-preview',
            modelSource: 'default'
        });

        await runGemini({});

        // Reset to ignore pushKeepAlive fired from initial onSessionReady setup
        mockGeminiSession.pushKeepAlive.mockClear();

        const registerCalls = harness.session.rpcHandlerManager.registerHandler.mock.calls;
        const configHandler = registerCalls.find(
            (call: unknown[]) => call[0] === 'set-session-config'
        );
        const handler = configHandler![1] as (payload: unknown) => Promise<unknown>;
        await handler({ model: 'gemini-2.5-flash' });

        expect(mockGeminiSession.pushKeepAlive).toHaveBeenCalledTimes(1);
    });

    it('rejects invalid model in set-session-config RPC', async () => {
        resolveGeminiRuntimeConfigMock.mockReturnValue({
            model: 'gemini-3-flash-preview',
            modelSource: 'default'
        });

        await runGemini({});

        const registerCalls = harness.session.rpcHandlerManager.registerHandler.mock.calls;
        const configHandler = registerCalls.find(
            (call: unknown[]) => call[0] === 'set-session-config'
        );
        const handler = configHandler![1] as (payload: unknown) => Promise<unknown>;
        await expect(handler({ model: 123 })).rejects.toThrow();
    });

    it('accepts null model (Auto) in set-session-config RPC', async () => {
        resolveGeminiRuntimeConfigMock.mockReturnValue({
            model: 'gemini-3-flash-preview',
            modelSource: 'default'
        });

        await runGemini({});

        const registerCalls = harness.session.rpcHandlerManager.registerHandler.mock.calls;
        const configHandler = registerCalls.find(
            (call: unknown[]) => call[0] === 'set-session-config'
        );
        const handler = configHandler![1] as (payload: unknown) => Promise<unknown>;
        const result = await handler({ model: null }) as Record<string, unknown>;
        const applied = result.applied as Record<string, unknown>;
        // null (Default) should be passed through to hub for DB clearing
        expect(applied.model).toBeNull();
    });

    it('only includes changed fields in applied response', async () => {
        resolveGeminiRuntimeConfigMock.mockReturnValue({
            model: 'gemini-3-flash-preview',
            modelSource: 'default'
        });

        await runGemini({});

        const registerCalls = harness.session.rpcHandlerManager.registerHandler.mock.calls;
        const configHandler = registerCalls.find(
            (call: unknown[]) => call[0] === 'set-session-config'
        );
        const handler = configHandler![1] as (payload: unknown) => Promise<unknown>;
        const result = await handler({ permissionMode: 'default' }) as Record<string, unknown>;
        const applied = result.applied as Record<string, unknown>;
        expect(applied.permissionMode).toBe('default');
        expect(applied).not.toHaveProperty('model');
    });

    it('stores null model in session on Default selection for keepalive', async () => {
        resolveGeminiRuntimeConfigMock.mockReturnValue({
            model: 'gemini-2.5-pro',
            modelSource: 'default'
        });

        await runGemini({});

        const registerCalls = harness.session.rpcHandlerManager.registerHandler.mock.calls;
        const configHandler = registerCalls.find(
            (call: unknown[]) => call[0] === 'set-session-config'
        );
        const handler = configHandler![1] as (payload: unknown) => Promise<unknown>;

        // First set an explicit model
        await handler({ model: 'gemini-2.5-flash' });
        expect(mockGeminiSession.setModel).toHaveBeenLastCalledWith('gemini-2.5-flash');

        // Then select Default (null) — session should store null, not concrete model
        await handler({ model: null });
        expect(mockGeminiSession.setModel).toHaveBeenLastCalledWith(null);
    });

    it('passes machine default (not startup model) to geminiLoop for fallback', async () => {
        // Session started with explicit model, but machine default differs
        resolveGeminiRuntimeConfigMock.mockImplementation((opts?: { model?: string }) => {
            if (opts?.model) {
                return { model: opts.model, modelSource: 'explicit' };
            }
            return { model: 'gemini-2.5-pro', modelSource: 'default' };
        });

        await runGemini({ model: 'gemini-2.5-flash' });

        // geminiLoop should receive machine default as fallback, not the explicit startup model
        expect(harness.geminiLoopArgs[0]?.model).toBe('gemini-2.5-pro');
    });

    it('passes resumeSessionId through to geminiLoop', async () => {
        resolveGeminiRuntimeConfigMock.mockReturnValue({
            model: 'gemini-2.5-pro',
            modelSource: 'default'
        });

        await runGemini({ resumeSessionId: 'a6157ffa-f692-4b73-82d5-63d42177f4f9' });

        expect(harness.geminiLoopArgs[0]?.resumeSessionId).toBe('a6157ffa-f692-4b73-82d5-63d42177f4f9');
    });

    it('does not set resumeSessionId when not provided', async () => {
        resolveGeminiRuntimeConfigMock.mockReturnValue({
            model: 'gemini-2.5-pro',
            modelSource: 'default'
        });

        await runGemini({});

        expect(harness.geminiLoopArgs[0]?.resumeSessionId).toBeUndefined();
    });

    it('preserves crash session end reason instead of overwriting it as completed', async () => {
        resolveGeminiRuntimeConfigMock.mockReturnValue({
            model: 'gemini-2.5-pro',
            modelSource: 'default'
        });
        harness.geminiLoopError = new Error('loop failed');

        await runGemini({});

        expect(lifecycleMock.markCrash).toHaveBeenCalledWith(harness.geminiLoopError);
        expect(lifecycleMock.setSessionEndReason).not.toHaveBeenCalledWith('completed');
        expect(lifecycleMock.cleanupAndExit).toHaveBeenCalled();
    });
});

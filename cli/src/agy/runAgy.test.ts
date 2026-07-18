import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAgySession = vi.hoisted(() => ({
    setModel: vi.fn(),
    setPermissionMode: vi.fn(),
    stopKeepAlive: vi.fn()
}));

const harness = vi.hoisted(() => ({
    bootstrapArgs: [] as Array<Record<string, unknown>>,
    agyLoopArgs: [] as Array<Record<string, unknown>>,
    session: {
        onUserMessage: vi.fn(),
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
            session: harness.session,
            sessionInfo: { id: 'test-agy-session' },
            reportStartedToRunner: vi.fn(async () => {})
        };
    })
}));

vi.mock('./loop', () => ({
    agyLoop: vi.fn(async (options: Record<string, unknown>) => {
        harness.agyLoopArgs.push(options);
        const onSessionReady = options.onSessionReady as ((session: unknown) => void) | undefined;
        if (onSessionReady) {
            onSessionReady(mockAgySession);
        }
    })
}));

vi.mock('@/claude/registerKillSessionHandler', () => ({
    registerKillSessionHandler: vi.fn()
}));

vi.mock('@/agent/runnerLifecycle', () => ({
    createModeChangeHandler: vi.fn(() => vi.fn()),
    createRunnerLifecycle: vi.fn(() => ({
        registerProcessHandlers: vi.fn(),
        cleanupAndExit: vi.fn(async () => {}),
        markCrash: vi.fn(),
        setExitCode: vi.fn(),
        setArchiveReason: vi.fn()
    })),
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
    generateHookSettingsFile: vi.fn(() => '/tmp/agy-hooks.json')
}));

const resolveAgyRuntimeConfigMock = vi.hoisted(() => vi.fn());

vi.mock('./utils/config', () => ({
    resolveAgyRuntimeConfig: resolveAgyRuntimeConfigMock
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn()
    }
}));

vi.mock('@/utils/attachmentFormatter', () => ({
    formatMessageWithAttachments: vi.fn((text: string) => text)
}));

import { runAgy } from './runAgy';

describe('runAgy', () => {
    beforeEach(() => {
        harness.bootstrapArgs.length = 0;
        harness.agyLoopArgs.length = 0;
        mockAgySession.setModel.mockReset();
        mockAgySession.setPermissionMode.mockReset();
        harness.session.onUserMessage.mockReset();
        harness.session.rpcHandlerManager.registerHandler.mockReset();
        resolveAgyRuntimeConfigMock.mockReset();
    });

    it('persists a resolved config model before bootstrapping the session', async () => {
        resolveAgyRuntimeConfigMock.mockReturnValue({
            model: 'Gemini 3.1 Pro (High)',
            modelSource: 'local'
        });

        await runAgy({});

        expect(harness.bootstrapArgs[0]?.model).toBe('Gemini 3.1 Pro (High)');
        expect(harness.agyLoopArgs[0]?.model).toBe('Gemini 3.1 Pro (High)');
    });

    it('does not persist the hardcoded default fallback model', async () => {
        resolveAgyRuntimeConfigMock.mockReturnValue({
            model: 'Gemini 3.5 Flash (High)',
            modelSource: 'default'
        });

        await runAgy({});

        expect(harness.bootstrapArgs[0]?.model).toBeUndefined();
        expect(harness.agyLoopArgs[0]?.model).toBe('Gemini 3.5 Flash (High)');
    });

    it('applies model change via set-session-config RPC', async () => {
        resolveAgyRuntimeConfigMock.mockReturnValue({
            model: 'Gemini 3.5 Flash (High)',
            modelSource: 'default'
        });

        await runAgy({});

        const registerCalls = harness.session.rpcHandlerManager.registerHandler.mock.calls;
        const configHandler = registerCalls.find(
            (call: unknown[]) => call[0] === 'set-session-config'
        );
        expect(configHandler).toBeDefined();

        const handler = configHandler![1] as (payload: unknown) => Promise<unknown>;
        const result = await handler({ model: 'Gemini 3.5 Flash (Low)' }) as Record<string, unknown>;
        const applied = result.applied as Record<string, unknown>;
        expect(applied.model).toBe('Gemini 3.5 Flash (Low)');
    });

    it('rejects invalid model in set-session-config RPC', async () => {
        resolveAgyRuntimeConfigMock.mockReturnValue({
            model: 'Gemini 3.5 Flash (High)',
            modelSource: 'default'
        });

        await runAgy({});

        const registerCalls = harness.session.rpcHandlerManager.registerHandler.mock.calls;
        const configHandler = registerCalls.find(
            (call: unknown[]) => call[0] === 'set-session-config'
        );
        const handler = configHandler![1] as (payload: unknown) => Promise<unknown>;
        await expect(handler({ model: 123 })).rejects.toThrow();
    });

    it('accepts null model (Auto) in set-session-config RPC', async () => {
        resolveAgyRuntimeConfigMock.mockReturnValue({
            model: 'Gemini 3.5 Flash (High)',
            modelSource: 'default'
        });

        await runAgy({});

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
        resolveAgyRuntimeConfigMock.mockReturnValue({
            model: 'Gemini 3.5 Flash (High)',
            modelSource: 'default'
        });

        await runAgy({});

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
        resolveAgyRuntimeConfigMock.mockReturnValue({
            model: 'Gemini 3.1 Pro (High)',
            modelSource: 'default'
        });

        await runAgy({});

        const registerCalls = harness.session.rpcHandlerManager.registerHandler.mock.calls;
        const configHandler = registerCalls.find(
            (call: unknown[]) => call[0] === 'set-session-config'
        );
        const handler = configHandler![1] as (payload: unknown) => Promise<unknown>;

        // First set an explicit model
        await handler({ model: 'Gemini 3.5 Flash (Low)' });
        expect(mockAgySession.setModel).toHaveBeenLastCalledWith('Gemini 3.5 Flash (Low)');

        // Then select Default (null) — session should store null, not concrete model
        await handler({ model: null });
        expect(mockAgySession.setModel).toHaveBeenLastCalledWith(null);
    });

    it('passes machine default (not startup model) to agyLoop for fallback', async () => {
        // Session started with explicit model, but machine default differs
        resolveAgyRuntimeConfigMock.mockImplementation((opts?: { model?: string }) => {
            if (opts?.model) {
                return { model: opts.model, modelSource: 'explicit' };
            }
            return { model: 'Gemini 3.1 Pro (High)', modelSource: 'default' };
        });

        await runAgy({ model: 'Gemini 3.5 Flash (Low)' });

        // agyLoop should receive machine default as fallback, not the explicit startup model
        expect(harness.agyLoopArgs[0]?.model).toBe('Gemini 3.1 Pro (High)');
    });

    it('passes resumeSessionId through to agyLoop', async () => {
        resolveAgyRuntimeConfigMock.mockReturnValue({
            model: 'Gemini 3.1 Pro (High)',
            modelSource: 'default'
        });

        await runAgy({ resumeSessionId: 'a6157ffa-f692-4b73-82d5-63d42177f4f9' });

        expect(harness.agyLoopArgs[0]?.resumeSessionId).toBe('a6157ffa-f692-4b73-82d5-63d42177f4f9');
    });

    it('passes native agy process options through to agyLoop', async () => {
        resolveAgyRuntimeConfigMock.mockReturnValue({
            model: 'Gemini 3.1 Pro (High)',
            modelSource: 'default'
        });

        await runAgy({
            additionalDirectories: ['/tmp/extra'],
            logFile: '/tmp/agy.log',
            printTimeout: '90s'
        });

        expect(harness.agyLoopArgs[0]?.additionalDirectories).toEqual(['/tmp/extra']);
        expect(harness.agyLoopArgs[0]?.logFile).toBe('/tmp/agy.log');
        expect(harness.agyLoopArgs[0]?.printTimeout).toBe('90s');
    });

    it('does not set resumeSessionId when not provided', async () => {
        resolveAgyRuntimeConfigMock.mockReturnValue({
            model: 'Gemini 3.1 Pro (High)',
            modelSource: 'default'
        });

        await runAgy({});

        expect(harness.agyLoopArgs[0]?.resumeSessionId).toBeUndefined();
    });

    it('rejects unsupported startup model before bootstrapping', async () => {
        await expect(runAgy({ model: 'not-a-live-agy-model' })).rejects.toThrow('Invalid Antigravity agy model');
        expect(harness.bootstrapArgs).toHaveLength(0);
    });

    it('rejects unsupported Antigravity agy model in set-session-config RPC', async () => {
        resolveAgyRuntimeConfigMock.mockReturnValue({
            model: 'Gemini 3.5 Flash (High)',
            modelSource: 'default'
        });

        await runAgy({});

        const registerCalls = harness.session.rpcHandlerManager.registerHandler.mock.calls;
        const configHandler = registerCalls.find(
            (call: unknown[]) => call[0] === 'set-session-config'
        );
        const handler = configHandler![1] as (payload: unknown) => Promise<unknown>;
        await expect(handler({ model: 'not-a-live-agy-model' })).rejects.toThrow('Invalid Antigravity agy model');
    });

});

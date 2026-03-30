import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
    bootstrapArgs: [] as Array<Record<string, unknown>>,
    geminiLoopArgs: [] as Array<Record<string, unknown>>,
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
            session: harness.session
        };
    })
}));

vi.mock('./loop', () => ({
    geminiLoop: vi.fn(async (options: Record<string, unknown>) => {
        harness.geminiLoopArgs.push(options);
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
        harness.session.onUserMessage.mockReset();
        harness.session.rpcHandlerManager.registerHandler.mockReset();
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

    it('does not persist the hardcoded default fallback model', async () => {
        resolveGeminiRuntimeConfigMock.mockReturnValue({
            model: 'gemini-2.5-pro',
            modelSource: 'default'
        });

        await runGemini({});

        expect(harness.bootstrapArgs[0]?.model).toBeUndefined();
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
});

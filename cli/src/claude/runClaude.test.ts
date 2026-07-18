import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockClaudeSession = vi.hoisted(() => {
    const state: {
        permissionMode?: string | null;
        model?: string | null;
        effort?: string | null;
    } = {};

    return {
        state,
        reset() {
            state.permissionMode = undefined;
            state.model = undefined;
            state.effort = undefined;
        },
        getPermissionMode: vi.fn(() => state.permissionMode),
        setPermissionMode: vi.fn((value: string | null) => { state.permissionMode = value; }),
        getModel: vi.fn(() => state.model),
        setModel: vi.fn((value: string | null) => { state.model = value; }),
        getEffort: vi.fn(() => state.effort),
        setEffort: vi.fn((value: string | null) => { state.effort = value; }),
        addSessionFoundCallback: vi.fn(),
        stopKeepAlive: vi.fn()
    };
});

const harness = vi.hoisted(() => ({
    loopArgs: [] as Array<Record<string, unknown>>,
    session: {
        onUserMessage: vi.fn(),
        updateMetadata: vi.fn(),
        rpcHandlerManager: {
            registerHandler: vi.fn()
        }
    }
}));

vi.mock('@/agent/sessionFactory', () => ({
    bootstrapSession: vi.fn(async () => ({
        api: {},
        session: harness.session,
        sessionInfo: { id: 'session-1' },
        reportStartedToRunner: vi.fn(async () => {})
    }))
}));

vi.mock('@/claude/loop', () => ({
    loop: vi.fn(async (options: Record<string, unknown>) => {
        harness.loopArgs.push(options);
        const onSessionReady = options.onSessionReady as ((session: unknown) => void) | undefined;
        onSessionReady?.(mockClaudeSession);
    })
}));

vi.mock('@/claude/sdk/metadataExtractor', () => ({
    extractSDKMetadataAsync: vi.fn()
}));

vi.mock('@/claude/utils/startHappyServer', () => ({
    startHappyServer: vi.fn(async () => ({ url: 'http://127.0.0.1:1', toolNames: [], stop: vi.fn() }))
}));

vi.mock('@/claude/utils/startHookServer', () => ({
    startHookServer: vi.fn(async () => ({ port: 1, token: 'token', stop: vi.fn() }))
}));

vi.mock('@/modules/common/hooks/generateHookSettings', () => ({
    generateHookSettingsFile: vi.fn(() => '/tmp/hapi-hook-settings.json'),
    cleanupHookSettingsFile: vi.fn()
}));

vi.mock('./registerKillSessionHandler', () => ({
    registerKillSessionHandler: vi.fn()
}));

vi.mock('@/agent/runnerLifecycle', () => ({
    createModeChangeHandler: vi.fn(() => vi.fn()),
    createRunnerLifecycle: vi.fn(() => ({
        registerProcessHandlers: vi.fn(),
        cleanup: vi.fn(async () => {}),
        cleanupAndExit: vi.fn(async () => {}),
        markCrash: vi.fn(),
        setExitCode: vi.fn(),
        setArchiveReason: vi.fn()
    })),
    setControlledByUser: vi.fn()
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn(),
        infoDeveloper: vi.fn(),
        logFilePath: '/tmp/hapi.log'
    }
}));

vi.mock('@/ui/doctor', () => ({
    getEnvironmentInfo: vi.fn(() => ({}))
}));

vi.mock('@/utils/attachmentFormatter', () => ({
    formatMessageWithAttachments: vi.fn((text: string) => text)
}));

vi.mock('@/utils/invokedCwd', () => ({
    getInvokedCwd: vi.fn(() => '/tmp/project')
}));

import { runClaude } from './runClaude';

describe('runClaude special command queueing', () => {
    beforeEach(() => {
        harness.loopArgs.length = 0;
        harness.session.onUserMessage.mockReset();
        harness.session.updateMetadata.mockReset();
        harness.session.rpcHandlerManager.registerHandler.mockReset();
        mockClaudeSession.reset();
    });

    it('isolates /goal user messages so Claude native slash handling sees the command at the start', async () => {
        await runClaude({});

        const userMessageHandler = harness.session.onUserMessage.mock.calls[0]?.[0] as (message: unknown) => void;
        userMessageHandler({
            content: {
                text: 'hello'
            },
            meta: {}
        });
        userMessageHandler({
            content: {
                text: '  /goal keep going until verified  ',
                attachments: [{ name: 'ignored.txt' }]
            },
            meta: {}
        });

        const queue = harness.loopArgs[0]?.messageQueue as { queue: Array<{ message: string; isolate?: boolean }> };
        expect(queue.queue).toHaveLength(1);
        expect(queue.queue[0]).toMatchObject({
            message: '/goal keep going until verified',
            isolate: true
        });
    });

    it('isolates /compact user messages so Claude Code native slash handling sees the command at the start', async () => {
        await runClaude({});

        const userMessageHandler = harness.session.onUserMessage.mock.calls[0]?.[0] as (message: unknown) => void;
        userMessageHandler({
            content: {
                text: 'hello'
            },
            meta: {}
        });
        userMessageHandler({
            content: {
                text: '  /compact now  ',
                attachments: [{ name: 'ignored.txt' }]
            },
            meta: {}
        });

        const queue = harness.loopArgs[0]?.messageQueue as { queue: Array<{ message: string; isolate?: boolean }> };
        expect(queue.queue).toHaveLength(1);
        expect(queue.queue[0]).toMatchObject({
            message: '/compact now',
            isolate: true
        });
    });

    it('clears stale invalid CC-api effort when model changes to an Auto-only model', async () => {
        await runClaude({ agentFlavor: 'cc-api', model: 'glm-5.2[1m]', effort: 'max' });

        const handler = harness.session.rpcHandlerManager.registerHandler.mock.calls
            .find(([name]) => name === 'set-session-config')?.[1] as (payload: unknown) => Promise<unknown>;

        await expect(handler({ model: 'minimax-m3' })).resolves.toEqual({
            applied: {
                permissionMode: 'default',
                model: 'minimax-m3',
                effort: null
            }
        });
        expect(mockClaudeSession.setModel).toHaveBeenLastCalledWith('minimax-m3');
        expect(mockClaudeSession.setEffort).toHaveBeenLastCalledWith(null);
    });

    it('sanitizes known invalid CC-api effort even when resuming', async () => {
        await runClaude({
            agentFlavor: 'cc-api',
            model: 'kimi-k3',
            effort: 'high',
            claudeArgs: [
                '--resume', 'known-model-session-1',
                '--model', 'kimi-k3',
                '--effort', 'high',
                '--verbose'
            ]
        });

        expect(harness.loopArgs[0]).toMatchObject({
            model: 'kimi-k3',
            effort: null,
            claudeArgs: [
                '--resume', 'known-model-session-1',
                '--model', 'kimi-k3',
                '--verbose'
            ]
        });
        expect(mockClaudeSession.setEffort).toHaveBeenLastCalledWith(null);
    });

    it('preserves valid initial CC-api effort args before launching the loop', async () => {
        await runClaude({
            agentFlavor: 'cc-api',
            model: 'glm-5.2[1m]',
            effort: 'max',
            claudeArgs: ['--model', 'glm-5.2[1m]', '--effort=max']
        });

        expect(harness.loopArgs[0]).toMatchObject({
            model: 'glm-5.2[1m]',
            effort: 'max',
            claudeArgs: ['--model', 'glm-5.2[1m]', '--effort=max']
        });
        expect(mockClaudeSession.setEffort).toHaveBeenLastCalledWith('max');
    });

    it('preserves persisted effort for an unlisted CC-api model resumed by the Runner', async () => {
        await runClaude({
            agentFlavor: 'cc-api',
            model: 'custom-cc-api-model',
            effort: 'high',
            claudeArgs: [
                '--resume', 'custom-session-1',
                '--model', 'custom-cc-api-model',
                '--effort', 'high'
            ]
        });

        expect(harness.loopArgs[0]).toMatchObject({
            model: 'custom-cc-api-model',
            effort: 'high',
            claudeArgs: [
                '--resume', 'custom-session-1',
                '--model', 'custom-cc-api-model',
                '--effort', 'high'
            ]
        });

        const handler = harness.session.rpcHandlerManager.registerHandler.mock.calls
            .find(([name]) => name === 'set-session-config')?.[1] as (payload: unknown) => Promise<unknown>;
        await expect(handler({ permissionMode: 'acceptEdits' })).resolves.toEqual({
            applied: {
                permissionMode: 'acceptEdits',
                model: 'custom-cc-api-model',
                effort: 'high'
            }
        });
        expect(mockClaudeSession.setEffort).toHaveBeenLastCalledWith('high');
    });

    it('rejects an unlisted CC-api model on a fresh launch', async () => {
        await expect(runClaude({
            agentFlavor: 'cc-api',
            model: 'custom-cc-api-model',
            effort: 'high'
        })).rejects.toThrow('Unknown CC-api model')

        expect(harness.loopArgs).toHaveLength(0)
    });

    it.each([
        {
            label: 'CC-api',
            agentFlavor: 'cc-api' as const,
            expectedError: 'Unknown CC-api model'
        },
        {
            label: 'CC-deepseek',
            agentFlavor: 'claude-deepseek' as const,
            expectedError: 'Unknown CC-deepseek model'
        }
    ])('rejects an unlisted $label model supplied with equals syntax', async ({ agentFlavor, expectedError }) => {
        await expect(runClaude({
            agentFlavor,
            claudeArgs: ['--model=custom-unlisted-model']
        })).rejects.toThrow(expectedError)

        expect(harness.loopArgs).toHaveLength(0)
    });

    it('validates the raw CC-api model even when the structured model looks safe', async () => {
        await expect(runClaude({
            agentFlavor: 'cc-api',
            model: 'kimi-k3',
            claudeArgs: ['--model=custom-unlisted-model']
        })).rejects.toThrow('Unknown CC-api model')

        expect(harness.loopArgs).toHaveLength(0)
    });

    it('does not sanitize non-CC-api effort args', async () => {
        await runClaude({
            agentFlavor: 'claude-ark',
            model: 'kimi-k2.7-code',
            effort: 'high',
            claudeArgs: ['--model', 'kimi-k2.7-code', '--effort', 'high']
        });

        expect(harness.loopArgs[0]).toMatchObject({
            model: 'kimi-k2.7-code',
            effort: 'high',
            claudeArgs: ['--model', 'kimi-k2.7-code', '--effort', 'high']
        });
        expect(mockClaudeSession.setEffort).toHaveBeenLastCalledWith('high');
    });

    it('rejects explicit invalid CC-api effort for the current model', async () => {
        await runClaude({ agentFlavor: 'cc-api', model: 'kimi-k3' });

        const handler = harness.session.rpcHandlerManager.registerHandler.mock.calls
            .find(([name]) => name === 'set-session-config')?.[1] as (payload: unknown) => Promise<unknown>;

        await expect(handler({ effort: 'high' })).rejects.toThrow('Effort selection is not supported for the current CC-api model');
    });

    it('rejects unlisted CC-api model changes on an active session', async () => {
        await runClaude({ agentFlavor: 'cc-api', model: 'kimi-k3', effort: 'max' });

        const handler = harness.session.rpcHandlerManager.registerHandler.mock.calls
            .find(([name]) => name === 'set-session-config')?.[1] as (payload: unknown) => Promise<unknown>;

        await expect(handler({ model: 'custom-cc-api-model' })).rejects.toThrow('Unknown CC-api model');
        expect(mockClaudeSession.setModel).toHaveBeenLastCalledWith('kimi-k3');
    });

    it('preserves the selected CC-deepseek model and official effort', async () => {
        await runClaude({ agentFlavor: 'claude-deepseek', model: 'deepseek-v4-flash', effort: 'high' });

        expect(harness.loopArgs[0]).toMatchObject({
            model: 'deepseek-v4-flash',
            effort: 'high'
        });
        expect(mockClaudeSession.setModel).toHaveBeenLastCalledWith('deepseek-v4-flash');
        expect(mockClaudeSession.setEffort).toHaveBeenLastCalledWith('high');
    });

    it('sanitizes an invalid persisted CC-deepseek effort before launch', async () => {
        await runClaude({
            agentFlavor: 'claude-deepseek',
            model: 'deepseek-v4-pro[1m]',
            effort: 'medium',
            claudeArgs: [
                '--resume', 'deepseek-session-1',
                '--model', 'deepseek-v4-pro[1m]',
                '--effort', 'medium'
            ]
        });

        expect(harness.loopArgs[0]).toMatchObject({
            model: 'deepseek-v4-pro[1m]',
            effort: null,
            claudeArgs: [
                '--resume', 'deepseek-session-1',
                '--model', 'deepseek-v4-pro[1m]'
            ]
        });
    });

    it('rejects an unlisted persisted CC-deepseek model instead of replacing it with the default', async () => {
        await expect(runClaude({
            agentFlavor: 'claude-deepseek',
            model: 'deepseek-chat',
            effort: 'max',
            claudeArgs: [
                '--resume', 'deepseek-session-unlisted',
                '--model', 'deepseek-chat',
                '--effort', 'max'
            ]
        })).rejects.toThrow('Unknown CC-deepseek model')

        expect(harness.loopArgs).toHaveLength(0)
    });

    it('rejects unsupported CC-deepseek models and effort levels at runtime', async () => {
        await runClaude({ agentFlavor: 'claude-deepseek', model: 'deepseek-v4-pro[1m]', effort: 'max' });

        const handler = harness.session.rpcHandlerManager.registerHandler.mock.calls
            .find(([name]) => name === 'set-session-config')?.[1] as (payload: unknown) => Promise<unknown>;

        await expect(handler({ model: 'deepseek-chat' })).rejects.toThrow('Unknown CC-deepseek model');
        await expect(handler({ effort: 'medium' })).rejects.toThrow('Effort selection is not supported for the current CC-deepseek model');
        await expect(handler({ model: 'deepseek-v4-flash', effort: 'high' })).resolves.toEqual({
            applied: {
                permissionMode: 'default',
                model: 'deepseek-v4-flash',
                effort: 'high'
            }
        });
    });
});

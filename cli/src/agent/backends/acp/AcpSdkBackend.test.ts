import { afterEach, describe, expect, it, vi } from 'vitest';
import agySteeredTurn from './__fixtures__/agy-steered-turn.json';
import type { AgentMessage, PermissionRequest } from '@/agent/types';
import { logger } from '@/ui/logger';
import { AcpSdkBackend } from './AcpSdkBackend';
import { AcpMessageHandler } from './AcpMessageHandler';
import { ACP_INDETERMINATE_SYMBOL, AcpStdioTransport, buildAcpStdioSpawnOptions } from './AcpStdioTransport';
import { ACP_SESSION_UPDATE_TYPES } from './constants';

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

type BackendStatics = {
    UPDATE_QUIET_PERIOD_MS: number;
    UPDATE_DRAIN_TIMEOUT_MS: number;
    PRE_PROMPT_UPDATE_QUIET_PERIOD_MS: number;
    PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS: number;
    LATE_FLUSH_INTERVAL_MS: number;
    LATE_FLUSH_QUIET_PERIOD_MS: number;
    LATE_FLUSH_WINDOW_MS: number;
};

const backendStatics = AcpSdkBackend as unknown as BackendStatics;
const originalStatics = {
    updateQuietPeriodMs: backendStatics.UPDATE_QUIET_PERIOD_MS,
    updateDrainTimeoutMs: backendStatics.UPDATE_DRAIN_TIMEOUT_MS,
    prePromptUpdateQuietPeriodMs: backendStatics.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS,
    prePromptUpdateDrainTimeoutMs: backendStatics.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS,
    lateFlushIntervalMs: backendStatics.LATE_FLUSH_INTERVAL_MS,
    lateFlushQuietPeriodMs: backendStatics.LATE_FLUSH_QUIET_PERIOD_MS,
    lateFlushWindowMs: backendStatics.LATE_FLUSH_WINDOW_MS
};
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

function setPlatform(value: string) {
    Object.defineProperty(process, 'platform', {
        value,
        configurable: true
    });
}

afterEach(() => {
    backendStatics.UPDATE_QUIET_PERIOD_MS = originalStatics.updateQuietPeriodMs;
    backendStatics.UPDATE_DRAIN_TIMEOUT_MS = originalStatics.updateDrainTimeoutMs;
    backendStatics.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS = originalStatics.prePromptUpdateQuietPeriodMs;
    backendStatics.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS = originalStatics.prePromptUpdateDrainTimeoutMs;
    backendStatics.LATE_FLUSH_INTERVAL_MS = originalStatics.lateFlushIntervalMs;
    backendStatics.LATE_FLUSH_QUIET_PERIOD_MS = originalStatics.lateFlushQuietPeriodMs;
    backendStatics.LATE_FLUSH_WINDOW_MS = originalStatics.lateFlushWindowMs;
    if (originalPlatformDescriptor) {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
});

describe('AcpSdkBackend', () => {
    it('closes an opening transport without sending initialize', async () => {
        const opening = Promise.withResolvers<AcpStdioTransport>();
        const transport = {
            onNotification: vi.fn(),
            onStderrError: vi.fn(),
            registerRequestHandler: vi.fn(),
            sendRequest: vi.fn(),
            close: vi.fn(async () => {})
        };
        const create = vi.spyOn(AcpStdioTransport, 'create').mockReturnValueOnce(opening.promise);
        const backend = new AcpSdkBackend({ command: 'agent' });
        const initializing = backend.initialize().catch((error: unknown) => error);
        const settled = vi.fn();
        try {
            const disconnect = backend.disconnect({ waitForTransport: true }).then(settled);
            await Promise.resolve();
            expect(settled).not.toHaveBeenCalled();
            opening.resolve(transport as unknown as AcpStdioTransport);
            await disconnect;
            expect(transport.sendRequest).not.toHaveBeenCalled();
            expect(await initializing).toMatchObject({ name: 'AbortError' });
            expect(transport.close).toHaveBeenCalledOnce();
        } finally {
            opening.resolve(transport as unknown as AcpStdioTransport);
            await initializing;
            create.mockRestore();
        }
    });

    it('retries a transient initialize failure without shutdown', async () => {
        const transport = {
            onNotification: vi.fn(),
            onStderrError: vi.fn(),
            registerRequestHandler: vi.fn(),
            sendRequest: vi.fn()
                .mockRejectedValueOnce(new Error('transient initialize failure'))
                .mockResolvedValueOnce({ protocolVersion: 1, agentCapabilities: { loadSession: true } }),
            close: vi.fn(async () => {})
        };
        const create = vi.spyOn(AcpStdioTransport, 'create')
            .mockResolvedValueOnce(transport as unknown as AcpStdioTransport);
        const backend = new AcpSdkBackend({ command: 'agent' });
        vi.useFakeTimers();
        try {
            const initializing = backend.initialize();
            void initializing.catch(() => undefined);
            await vi.advanceTimersByTimeAsync(1_500);
            await expect(initializing).resolves.toBeUndefined();
            expect(transport.sendRequest).toHaveBeenCalledTimes(2);
            expect(backend.supportsLoadSession()).toBe(true);
            expect(transport.close).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
            await backend.disconnect();
            create.mockRestore();
        }
    });

    it.each([false, true])('cancels initialize retries on shutdown (already backing off: %s)', async (backingOff) => {
        const reply = Promise.withResolvers<never>();
        const transport = {
            onNotification: vi.fn(),
            onStderrError: vi.fn(),
            registerRequestHandler: vi.fn(),
            sendRequest: vi.fn(() => reply.promise),
            close: vi.fn(async () => { reply.reject(new Error('transport closed')); })
        };
        const create = vi.spyOn(AcpStdioTransport, 'create')
            .mockResolvedValueOnce(transport as unknown as AcpStdioTransport);
        const backend = new AcpSdkBackend({ command: 'agent' });
        const rejected = vi.fn();
        vi.useFakeTimers();
        const initializing = backend.initialize().catch(rejected);
        try {
            await vi.advanceTimersByTimeAsync(0);
            expect(transport.sendRequest).toHaveBeenCalledOnce();
            if (backingOff) {
                reply.reject(new Error('initialize failed'));
                await vi.advanceTimersByTimeAsync(0);
                expect(rejected).not.toHaveBeenCalled();
            }
            await backend.disconnect({ waitForTransport: true });
            await vi.advanceTimersByTimeAsync(0);
            expect(rejected).toHaveBeenCalledOnce();
            expect(transport.sendRequest).toHaveBeenCalledOnce();
        } finally {
            await vi.runAllTimersAsync();
            await initializing;
            vi.useRealTimers();
            create.mockRestore();
        }
    });

    it('forwards ACP session_info_update titles without requiring an active prompt', () => {
        const backend = new AcpSdkBackend({ command: 'agent' });
        const updates: Array<{ sessionId: string | null; title: string | null }> = [];
        backend.setSessionInfoUpdateListener((update) => updates.push(update));

        const backendInternal = backend as unknown as {
            handleSessionUpdate: (params: unknown) => void;
        };
        backendInternal.handleSessionUpdate({
            sessionId: 'session-1',
            update: {
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.sessionInfoUpdate,
                title: 'Native session title'
            }
        });
        backendInternal.handleSessionUpdate({
            sessionId: 'session-1',
            update: {
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.sessionInfoUpdate,
                updatedAt: '2026-07-12T00:00:00Z'
            }
        });

        expect(updates).toEqual([{ sessionId: 'session-1', title: 'Native session title' }]);
    });

    it('reports echoed user prompts after flushing the output before them', async () => {
        const backend = new AcpSdkBackend({ command: 'agy' });
        const events: string[] = [];
        backend.setUserMessageChunkListener((text) => events.push(`echo:${text}`));
        const backendInternal = backend as unknown as {
            handleSessionUpdate: (params: unknown) => void;
            sessionUpdateQueue: Promise<void>;
            messageHandler: { handleUpdate: (update: unknown) => Promise<void>; drainBuffers: () => void } | null;
        };
        backendInternal.messageHandler = {
            handleUpdate: async (update) => {
                events.push(`update:${(update as { sessionUpdate: string }).sessionUpdate}`);
            },
            drainBuffers: () => events.push('drain')
        };

        backendInternal.handleSessionUpdate({
            sessionId: 'session-1',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Working' } }
        });
        backendInternal.handleSessionUpdate({
            sessionId: 'session-1',
            update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'also lint' } }
        });
        await backendInternal.sessionUpdateQueue;

        expect(events).toEqual([
            'update:agent_message_chunk',
            'update:user_message_chunk',
            'drain',
            'echo:also lint'
        ]);
    });

    it('refreshes native titles through ACP session/list', async () => {
        const backend = new AcpSdkBackend({ command: 'opencode' });
        const calls: Array<{ method: string; params: unknown; options: unknown }> = [];
        const backendInternal = backend as unknown as {
            transport: {
                sendRequest: (method: string, params: unknown, options?: unknown) => Promise<unknown>;
            } | null;
        };
        backendInternal.transport = {
            sendRequest: async (method, params, options) => {
                calls.push({ method, params, options });
                return {
                    sessions: [
                        { sessionId: 'other', title: 'Other title' },
                        { sessionId: 'session-1', title: 'Native OpenCode title' }
                    ]
                };
            }
        };
        const updates: Array<{ sessionId: string | null; title: string | null }> = [];
        backend.setSessionInfoUpdateListener((update) => updates.push(update));

        await backend.refreshSessionInfo('session-1', '/workspace');

        expect(calls).toEqual([{
            method: 'session/list',
            params: { cwd: '/workspace' },
            options: { timeoutMs: 5000 }
        }]);
        expect(updates).toEqual([{ sessionId: 'session-1', title: 'Native OpenCode title' }]);
    });

    it('retries session/list while an asynchronously generated title is still a placeholder', async () => {
        vi.useFakeTimers();
        try {
            const backend = new AcpSdkBackend({ command: 'opencode' });
            const titles = ['New session - 2026-07-12T00:00:00.000Z', 'Native OpenCode title'];
            const backendInternal = backend as unknown as {
                transport: { sendRequest: () => Promise<unknown> } | null;
            };
            backendInternal.transport = {
                sendRequest: async () => ({
                    sessions: [{ sessionId: 'session-1', title: titles.shift() }]
                })
            };
            const updates: Array<{ sessionId: string | null; title: string | null }> = [];
            backend.setSessionInfoUpdateListener((update) => updates.push(update));

            await backend.refreshSessionInfo('session-1', '/workspace');
            await vi.runAllTimersAsync();

            expect(updates).toEqual([
                { sessionId: 'session-1', title: 'New session - 2026-07-12T00:00:00.000Z' },
                { sessionId: 'session-1', title: 'Native OpenCode title' }
            ]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('hides the ACP stdio window on Windows without shell:true (#2021 Job Object)', () => {
        setPlatform('win32');

        expect(buildAcpStdioSpawnOptions({ TEST_ENV: '1' })).toMatchObject({
            env: { TEST_ENV: '1' },
            stdio: ['pipe', 'pipe', 'pipe'],
            // shell:false so Assign targets the agent PID, not cmd.exe (#2021).
            shell: false,
            windowsHide: true,
            detached: false,
        });
    });

    it('detaches ACP stdio on POSIX so Stop owns a private process group (#2021)', () => {
        setPlatform('linux');
        expect(buildAcpStdioSpawnOptions()).toMatchObject({
            detached: true,
            shell: false,
        });
    });

    it('allows the permission handler to resolve requests immediately', async () => {
        const backend = new AcpSdkBackend({ command: 'opencode' });
        let capturedRequestId: string | null = null;

        backend.onPermissionRequest((request) => {
            capturedRequestId = request.id;
            void backend.respondToPermission(request.sessionId, request, {
                outcome: 'selected',
                optionId: 'allow-once'
            });
        });

        const backendInternal = backend as unknown as {
            handlePermissionRequest: (params: unknown, requestId: string | number | null) => Promise<unknown>;
        };

        await expect(backendInternal.handlePermissionRequest({
            sessionId: 'session-1',
            toolCall: {
                toolCallId: 'tool-approve',
                title: 'hapi_change_title',
                rawInput: { title: 'Rename chat' }
            },
            options: [
                {
                    optionId: 'allow-once',
                    name: 'Allow once',
                    kind: 'allow_once'
                }
            ]
        }, null)).resolves.toEqual({
            outcome: {
                outcome: 'selected',
                optionId: 'allow-once'
            }
        });

        expect(capturedRequestId).toMatch(/^tool-approve#[0-9a-f-]{36}$/);
    });

    it('uses session/set_model by default (gemini flavor)', async () => {
        const backend = new AcpSdkBackend({ command: 'gemini' });
        const calls: Array<{ method: string; params: unknown }> = [];
        const backendInternal = backend as unknown as {
            transport: { sendRequest: (method: string, params: unknown) => Promise<unknown>; close: () => Promise<void> } | null;
        };
        backendInternal.transport = {
            sendRequest: async (method, params) => {
                calls.push({ method, params });
                return null;
            },
            close: async () => {}
        };

        await backend.setModel('session-1', 'gemini-2.5-pro');

        expect(calls).toEqual([
            { method: 'session/set_model', params: { sessionId: 'session-1', modelId: 'gemini-2.5-pro' } }
        ]);
    });

    it('uses session/set_config_option when flavor is opencode and captures thought_level', async () => {
        const backend = new AcpSdkBackend({ command: 'opencode' });
        const calls: Array<{ method: string; params: unknown }> = [];
        const backendInternal = backend as unknown as {
            transport: { sendRequest: (method: string, params: unknown) => Promise<unknown>; close: () => Promise<void> } | null;
        };
        backendInternal.transport = {
            sendRequest: async (method, params) => {
                calls.push({ method, params });
                if (method === 'session/set_config_option') {
                    return {
                        models: {
                            currentModelId: 'opencode/hy3-free',
                            availableModels: []
                        },
                        configOptions: [{
                            id: 'effort',
                            category: 'thought_level',
                            currentValue: 'high',
                            options: [
                                { value: 'low', name: 'Low' },
                                { value: 'medium', name: 'Medium' },
                                { value: 'high', name: 'High' }
                            ]
                        }]
                    };
                }
                return null;
            },
            close: async () => {}
        };

        await backend.setModel('session-1', 'opencode/hy3-free', { flavor: 'opencode' });

        expect(calls).toEqual([
            {
                method: 'session/set_config_option',
                params: {
                    sessionId: 'session-1',
                    configId: 'model',
                    value: 'opencode/hy3-free'
                }
            }
        ]);
        expect(backend.getThoughtLevelConfigOption('session-1')).toMatchObject({
            id: 'effort',
            currentValue: 'high',
            options: [
                { value: 'low', name: 'Low' },
                { value: 'medium', name: 'Medium' },
                { value: 'high', name: 'High' }
            ]
        });
    });

    it('captures availableModels and currentModelId from session/new response', async () => {
        const backend = new AcpSdkBackend({ command: 'opencode' });
        const backendInternal = backend as unknown as {
            transport: { sendRequest: (method: string, params: unknown) => Promise<unknown>; close: () => Promise<void> } | null;
        };
        const fixtureModels = [
            { modelId: 'ollama/exaone:4.5-33b-q8', name: 'Ollama (SER8)/EXAONE 4.5 33B Q8' },
            { modelId: 'mlx/qwen3:0.6b', name: 'MLX/Qwen3 0.6B' }
        ];
        backendInternal.transport = {
            sendRequest: async (method) => {
                if (method === 'session/new') {
                    return {
                        sessionId: 'opencode-session-7',
                        models: {
                            availableModels: fixtureModels,
                            currentModelId: 'ollama/exaone:4.5-33b-q8'
                        }
                    };
                }
                return null;
            },
            close: async () => {}
        };

        const sessionId = await backend.newSession({ cwd: '/tmp/x', mcpServers: [] });

        expect(sessionId).toBe('opencode-session-7');
        expect(backend.getSessionModelsMetadata(sessionId)).toEqual({
            availableModels: fixtureModels,
            currentModelId: 'ollama/exaone:4.5-33b-q8'
        });
    });

    it('captures Grok reasoning efforts from x.ai session metadata and switches with set_mode', async () => {
        const backend = new AcpSdkBackend({ command: 'grok' });
        const calls: Array<{ method: string; params: unknown }> = [];
        const backendInternal = backend as unknown as {
            transport: { sendRequest: (method: string, params: unknown) => Promise<unknown>; close: () => Promise<void> } | null;
        };
        backendInternal.transport = {
            sendRequest: async (method, params) => {
                calls.push({ method, params });
                if (method === 'session/new') {
                    return {
                        sessionId: 'grok-session-1',
                        models: {
                            currentModelId: 'grok-4.5',
                            availableModels: [{
                                modelId: 'grok-4.5',
                                name: 'Grok 4.5',
                                _meta: {
                                    reasoningEfforts: [
                                        { value: 'high', label: 'High Effort', default: true },
                                        { value: 'low', label: 'Low Effort', default: false }
                                    ]
                                }
                            }]
                        },
                        _meta: {
                            availableCommands: [
                                { name: 'auto', description: 'Auto-approve safe tool calls' },
                                { name: '/swarm', description: 'Run a native swarm' }
                            ],
                            'x.ai/sessionConfig': {
                                options: [
                                    { id: 'high', category: 'mode', label: 'High Effort', selected: false },
                                    { id: 'low', category: 'mode', label: 'Low Effort', selected: true }
                                ]
                            }
                        }
                    };
                }
                if (method === 'session/set_mode') return { meta: null };
                return null;
            },
            close: async () => {}
        };

        const sessionId = await backend.newSession({ cwd: '/tmp/x', mcpServers: [] });

        expect(backend.getSessionModelsMetadata(sessionId)).toEqual({
            availableModels: [{
                modelId: 'grok-4.5',
                name: 'Grok 4.5',
                reasoningEfforts: [
                    { value: 'high', name: 'High Effort', isDefault: true },
                    { value: 'low', name: 'Low Effort', isDefault: false }
                ]
            }],
            currentModelId: 'grok-4.5'
        });
        expect(backend.getThoughtLevelConfigOption(sessionId)).toMatchObject({
            currentValue: 'low',
            options: [
                { value: 'high', name: 'High Effort' },
                { value: 'low', name: 'Low Effort' }
            ]
        });
        expect(backend.hasAvailableCommand(sessionId, 'auto')).toBe(true);
        expect(backend.hasAvailableCommand(sessionId, 'swarm')).toBe(true);
        expect(backend.getAvailableCommands(sessionId)).toEqual([
            { name: 'auto', description: 'Auto-approve safe tool calls' },
            { name: 'swarm', description: 'Run a native swarm' }
        ]);

        await backend.setMode(sessionId, 'high');

        expect(calls).toContainEqual({
            method: 'session/set_mode',
            params: { sessionId, modeId: 'high' }
        });
        expect(backend.getThoughtLevelConfigOption(sessionId)?.currentValue).toBe('high');
    });

    it('merges configOptions model variants into availableModels when both are present', async () => {
        const backend = new AcpSdkBackend({ command: 'agent' });
        const backendInternal = backend as unknown as {
            transport: { sendRequest: (method: string, params: unknown) => Promise<unknown>; close: () => Promise<void> } | null;
        };
        backendInternal.transport = {
            sendRequest: async (method) => {
                if (method === 'session/new') {
                    return {
                        sessionId: 'cursor-session-variants',
                        models: {
                            availableModels: [
                                { modelId: 'composer-2.5[fast=true]', name: 'composer-2.5' }
                            ],
                            currentModelId: 'composer-2.5[fast=true]'
                        },
                        configOptions: [
                            {
                                id: 'model-opt',
                                category: 'model',
                                currentValue: 'composer-2.5[fast=true]',
                                options: [
                                    { value: 'composer-2.5[fast=true]', name: 'composer-2.5' },
                                    { value: 'composer-2.5[fast=false]', name: 'composer-2.5' }
                                ]
                            }
                        ]
                    };
                }
                return null;
            },
            close: async () => {}
        };

        const sessionId = await backend.newSession({ cwd: '/tmp/x', mcpServers: [] });

        expect(backend.getSessionModelsMetadata(sessionId)?.availableModels.map((entry) => entry.modelId).sort()).toEqual([
            'composer-2.5[fast=false]',
            'composer-2.5[fast=true]'
        ]);
    });

    it('captures model metadata from configOptions when models block is missing', async () => {
        const backend = new AcpSdkBackend({ command: 'opencode' });
        const backendInternal = backend as unknown as {
            transport: { sendRequest: (method: string, params: unknown) => Promise<unknown>; close: () => Promise<void> } | null;
        };
        backendInternal.transport = {
            sendRequest: async (method) => {
                if (method === 'session/new') {
                    return {
                        sessionId: 'opencode-session-config-options',
                        configOptions: [
                            {
                                id: 'model',
                                category: 'model',
                                currentValue: 'opencode/big-pickle',
                                options: [
                                    { value: 'opencode/big-pickle', name: 'OpenCode Zen/Big Pickle' },
                                    { value: 'deepseek/deepseek-chat', name: 'DeepSeek/DeepSeek Chat' }
                                ]
                            }
                        ]
                    };
                }
                return null;
            },
            close: async () => {}
        };

        const sessionId = await backend.newSession({ cwd: '/tmp/x', mcpServers: [] });

        expect(backend.getSessionModelsMetadata(sessionId)).toEqual({
            availableModels: [
                { modelId: 'opencode/big-pickle', name: 'OpenCode Zen/Big Pickle' },
                { modelId: 'deepseek/deepseek-chat', name: 'DeepSeek/DeepSeek Chat' }
            ],
            currentModelId: 'opencode/big-pickle'
        });
    });

    it('flattens Zed-style grouped configOptions into model metadata (dsh shape)', async () => {
        const backend = new AcpSdkBackend({ command: 'agent' });
        const backendInternal = backend as unknown as {
            transport: { sendRequest: (method: string, params: unknown) => Promise<unknown>; close: () => Promise<void> } | null;
        };
        backendInternal.transport = {
            sendRequest: async (method) => {
                if (method === 'session/new') {
                    return {
                        sessionId: 'dsh-session-grouped',
                        configOptions: [
                            {
                                id: 'model',
                                name: 'Model',
                                category: 'model',
                                type: 'select',
                                currentValue: '["deepseek-official","deepseek-flash"]',
                                options: [
                                    {
                                        group: 'deepseek-official',
                                        name: 'DeepSeek',
                                        options: [
                                            { value: '["deepseek-official","deepseek-flash"]', name: 'DeepSeek-V41-Flash' },
                                            { value: '["deepseek-official","deepseek-v4-pro"]', name: 'DeepSeek-V4-Pro' }
                                        ]
                                    }
                                ]
                            },
                            {
                                id: 'reasoning_effort',
                                category: 'thought_level',
                                currentValue: 'high',
                                options: [
                                    { value: 'off', name: 'Off' },
                                    { value: 'high', name: 'High' }
                                ]
                            }
                        ]
                    };
                }
                return null;
            },
            close: async () => {}
        };

        const sessionId = await backend.newSession({ cwd: '/tmp/x', mcpServers: [] });

        expect(backend.getSessionModelsMetadata(sessionId)).toEqual({
            availableModels: [
                { modelId: '["deepseek-official","deepseek-flash"]', name: 'DeepSeek-V41-Flash' },
                { modelId: '["deepseek-official","deepseek-v4-pro"]', name: 'DeepSeek-V4-Pro' }
            ],
            currentModelId: '["deepseek-official","deepseek-flash"]'
        });
        expect(backend.getConfigOptionByCategory(sessionId, 'model')?.options).toEqual([
            { value: '["deepseek-official","deepseek-flash"]', name: 'DeepSeek-V41-Flash' },
            { value: '["deepseek-official","deepseek-v4-pro"]', name: 'DeepSeek-V4-Pro' }
        ]);
        // Flat options (thought_level) keep parsing unchanged.
        expect(backend.getThoughtLevelConfigOption(sessionId)).toMatchObject({
            id: 'reasoning_effort',
            currentValue: 'high'
        });
    });

    it('returns undefined session metadata when session/new omits models', async () => {
        const backend = new AcpSdkBackend({ command: 'gemini' });
        const backendInternal = backend as unknown as {
            transport: { sendRequest: (method: string, params: unknown) => Promise<unknown>; close: () => Promise<void> } | null;
        };
        backendInternal.transport = {
            sendRequest: async (method) => {
                if (method === 'session/new') {
                    return { sessionId: 'gemini-session-3' };
                }
                return null;
            },
            close: async () => {}
        };

        const sessionId = await backend.newSession({ cwd: '/tmp/x', mcpServers: [] });

        expect(sessionId).toBe('gemini-session-3');
        expect(backend.getSessionModelsMetadata(sessionId)).toBeUndefined();
    });

    it('falls back to session/set_model when opencode set_config_option is not found', async () => {
        const backend = new AcpSdkBackend({ command: 'opencode' });
        const calls: Array<{ method: string; params: unknown }> = [];
        const backendInternal = backend as unknown as {
            transport: { sendRequest: (method: string, params: unknown) => Promise<unknown>; close: () => Promise<void> } | null;
        };
        const fixtureModels = [
            { modelId: 'ollama/a', name: 'a' },
            { modelId: 'ollama/b', name: 'b' }
        ];
        backendInternal.transport = {
            sendRequest: async (method, params) => {
                calls.push({ method, params });
                if (method === 'session/new') {
                    return {
                        sessionId: 's1',
                        models: { availableModels: fixtureModels, currentModelId: 'ollama/a' },
                        configOptions: [{
                            id: 'effort',
                            category: 'thought_level',
                            currentValue: 'high',
                            options: [{ value: 'high', name: 'High' }]
                        }]
                    };
                }
                if (method === 'session/set_config_option') {
                    throw new Error('Method not found');
                }
                if (method === 'session/set_model') {
                    // OpenCode 1.14.30: response carries only an opaque _meta block.
                    return { _meta: { opencode: { modelId: 'ollama/b' } } };
                }
                return null;
            },
            close: async () => {}
        };

        await backend.newSession({ cwd: '/tmp/x', mcpServers: [] });
        expect(backend.getThoughtLevelConfigOption('s1')).toBeDefined();
        await backend.setModel('s1', 'ollama/b', { flavor: 'opencode' });

        expect(calls.slice(1)).toEqual([
            {
                method: 'session/set_config_option',
                params: { sessionId: 's1', configId: 'model', value: 'ollama/b' }
            },
            { method: 'session/set_model', params: { sessionId: 's1', modelId: 'ollama/b' } }
        ]);
        expect(backend.getSessionModelsMetadata('s1')).toEqual({
            availableModels: fixtureModels,
            currentModelId: 'ollama/b'
        });
        expect(backend.getThoughtLevelConfigOption('s1')).toBeUndefined();
    });

    it('rethrows non method-not-found errors from opencode set_config_option without falling back', async () => {
        const backend = new AcpSdkBackend({ command: 'opencode' });
        const backendInternal = backend as unknown as {
            transport: { sendRequest: (method: string, params: unknown) => Promise<unknown>; close: () => Promise<void> } | null;
        };
        backendInternal.transport = {
            sendRequest: async (method) => {
                if (method === 'session/set_config_option') {
                    throw new Error('Invalid params');
                }
                return null;
            },
            close: async () => {}
        };

        await expect(backend.setModel('session-1', 'm/b', { flavor: 'opencode' })).rejects.toThrow('Invalid params');
    });

    it('uses session/set_model when flavor is grok', async () => {
        const backend = new AcpSdkBackend({ command: 'grok' });
        const calls: Array<{ method: string; params: unknown }> = [];
        const backendInternal = backend as unknown as {
            transport: { sendRequest: (method: string, params: unknown) => Promise<unknown>; close: () => Promise<void> } | null;
        };
        backendInternal.transport = {
            sendRequest: async (method, params) => {
                calls.push({ method, params });
                return null;
            },
            close: async () => {}
        };

        await backend.setModel('session-1', 'grok-4.5', { flavor: 'grok' });

        expect(calls).toEqual([
            { method: 'session/set_model', params: { sessionId: 'session-1', modelId: 'grok-4.5' } }
        ]);
    });



    it('captures and sets OpenCode thought-level config option', async () => {
        const backend = new AcpSdkBackend({ command: 'opencode' });
        const calls: Array<{ method: string; params: unknown }> = [];
        const backendInternal = backend as unknown as {
            transport: { sendRequest: (method: string, params: unknown) => Promise<unknown>; close: () => Promise<void> } | null;
        };
        backendInternal.transport = {
            sendRequest: async (method, params) => {
                calls.push({ method, params });
                if (method === 'session/new') {
                    return {
                        sessionId: 's1',
                        configOptions: [{
                            id: 'effort',
                            name: 'Effort',
                            category: 'thought_level',
                            type: 'select',
                            currentValue: 'low',
                            options: [
                                { value: 'low', name: 'Low' },
                                { value: 'high', name: 'High' }
                            ]
                        }]
                    };
                }
                if (method === 'session/set_config_option') {
                    return {
                        configOptions: [{
                            id: 'effort',
                            category: 'thought_level',
                            currentValue: 'high',
                            options: [{ value: 'high', name: 'High' }]
                        }]
                    };
                }
                return null;
            },
            close: async () => {}
        };

        await backend.newSession({ cwd: '/tmp/x', mcpServers: [] });
        expect(backend.getThoughtLevelConfigOption('s1')).toMatchObject({
            id: 'effort',
            currentValue: 'low',
            options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }]
        });

        await backend.setConfigOption('s1', 'effort', 'high');

        expect(calls).toContainEqual({
            method: 'session/set_config_option',
            params: { sessionId: 's1', configId: 'effort', value: 'high' }
        });
        expect(backend.getThoughtLevelConfigOption('s1')).toMatchObject({
            id: 'effort',
            currentValue: 'high'
        });
    });

    it('emits turn_complete after trailing tool updates from the same turn', async () => {
        backendStatics.UPDATE_QUIET_PERIOD_MS = 25;
        backendStatics.UPDATE_DRAIN_TIMEOUT_MS = 200;
        backendStatics.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS = 1;
        backendStatics.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS = 50;
        backendStatics.LATE_FLUSH_INTERVAL_MS = 5;
        backendStatics.LATE_FLUSH_QUIET_PERIOD_MS = 10;
        backendStatics.LATE_FLUSH_WINDOW_MS = 50;

        const backend = new AcpSdkBackend({ command: 'opencode' });
        const backendInternal = backend as unknown as {
            transport: {
                sendRequest: (...args: unknown[]) => Promise<unknown>;
                close: () => Promise<void>;
            } | null;
            handleSessionUpdate: (params: unknown) => void;
        };

        const messages: AgentMessage[] = [];
        backendInternal.transport = {
            sendRequest: async () => {
                setTimeout(() => {
                    backendInternal.handleSessionUpdate({
                        sessionId: 'session-1',
                        update: {
                            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
                            content: { type: 'text', text: 'final answer' }
                        }
                    });
                }, 0);

                await sleep(5);

                setTimeout(() => {
                    backendInternal.handleSessionUpdate({
                        sessionId: 'session-1',
                        update: {
                            sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
                            toolCallId: 'tool-1',
                            title: 'Read',
                            rawInput: { path: 'README.md' },
                            status: 'in_progress'
                        }
                    });
                }, 1);

                setTimeout(() => {
                    backendInternal.handleSessionUpdate({
                        sessionId: 'session-1',
                        update: {
                            sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCallUpdate,
                            toolCallId: 'tool-1',
                            status: 'completed',
                            rawOutput: { ok: true }
                        }
                    });
                }, 2);

                return { stopReason: 'end_turn' };
            },
            close: async () => {}
        };

        await backend.prompt('session-1', [{ type: 'text', text: 'hello' }], (message) => {
            messages.push(message);
        });

        expect(messages.map((message) => message.type)).toEqual([
            'text',
            'tool_call',
            'tool_result',
            'turn_complete'
        ]);
    });

    it('reports when the prompt is sent and answered, apart from its own waits', async () => {
        const backend = new AcpSdkBackend({ command: 'agent' });
        const events: string[] = [];
        const backendInternal = backend as unknown as {
            transport: { sendRequest: () => Promise<unknown>; close: () => Promise<void> } | null;
            waitForSessionUpdateQuiet: (quietMs: number, timeoutMs: number) => Promise<void>;
        };
        backendInternal.waitForSessionUpdateQuiet = async () => { events.push('wait'); };
        backendInternal.transport = {
            sendRequest: async () => {
                events.push('request');
                return { stopReason: 'end_turn' };
            },
            close: async () => {}
        };

        await backend.prompt('session-1', [{ type: 'text', text: 'hello' }], () => {}, {
            timing: {
                onSent: () => events.push('sent'),
                onAnswered: () => events.push('answered')
            }
        });
        events.push('resolved');

        expect(events).toEqual(['wait', 'request', 'sent', 'answered', 'wait', 'resolved']);
    });

    it('waits for transport dispatch before firing timing.onSent', async () => {
        const backend = new AcpSdkBackend({ command: 'agent' });
        const events: string[] = [];
        let resolveDispatched!: () => void;
        let resolveCompleted!: (value: unknown) => void;
        const dispatched = new Promise<void>((resolve) => { resolveDispatched = resolve; });
        const completed = new Promise<unknown>((resolve) => { resolveCompleted = resolve; });
        const backendInternal = backend as unknown as {
            transport: {
                sendRequestWithDispatch: (
                    method: string,
                    params: unknown,
                    options?: { timeoutMs?: number; dispatchTimeoutMs?: number }
                ) => { dispatched: Promise<void>; completed: Promise<unknown> };
                close: () => Promise<void>;
            } | null;
            waitForSessionUpdateQuiet: (quietMs: number, timeoutMs: number) => Promise<void>;
        };
        backendInternal.waitForSessionUpdateQuiet = async () => {};
        const sendRequestWithDispatch = vi.fn(() => {
            events.push('request');
            return { dispatched, completed };
        });
        backendInternal.transport = {
            sendRequestWithDispatch,
            close: async () => {}
        };

        const promptPromise = backend.prompt('session-1', [{ type: 'text', text: 'hello' }], () => {}, {
            timing: {
                onSent: () => events.push('sent'),
                onAnswered: () => events.push('answered')
            }
        });

        await vi.waitFor(() => expect(sendRequestWithDispatch).toHaveBeenCalledTimes(1));
        expect(sendRequestWithDispatch).toHaveBeenCalledWith(
            'session/prompt',
            { sessionId: 'session-1', prompt: [{ type: 'text', text: 'hello' }] },
            { timeoutMs: Infinity }
        );
        expect(events).toEqual(['request']);

        resolveDispatched();
        await vi.waitFor(() => expect(events).toEqual(['request', 'sent']));

        resolveCompleted({ stopReason: 'end_turn' });
        await promptPromise;
        expect(events).toEqual(['request', 'sent', 'answered']);
    });

    it('does not fire timing.onSent when transport dispatch rejects', async () => {
        const backend = new AcpSdkBackend({ command: 'agent' });
        const onSent = vi.fn();
        const onAnswered = vi.fn();
        const dispatchError = new Error('stdin write failed');
        const backendInternal = backend as unknown as {
            transport: {
                sendRequestWithDispatch: () => { dispatched: Promise<void>; completed: Promise<unknown> };
                close: () => Promise<void>;
            } | null;
            waitForSessionUpdateQuiet: (quietMs: number, timeoutMs: number) => Promise<void>;
        };
        backendInternal.waitForSessionUpdateQuiet = async () => {};
        backendInternal.transport = {
            sendRequestWithDispatch: () => ({
                dispatched: Promise.reject(dispatchError),
                completed: Promise.reject(dispatchError)
            }),
            close: async () => {}
        };

        await expect(
            backend.prompt('session-1', [{ type: 'text', text: 'hello' }], () => {}, {
                timing: { onSent, onAnswered }
            })
        ).rejects.toThrow('stdin write failed');
        expect(onSent).not.toHaveBeenCalled();
        expect(onAnswered).toHaveBeenCalledTimes(1);
    });

    it('seals a Cursor done footer before quiet drain so harness text stays separate (#2268)', async () => {
        backendStatics.UPDATE_QUIET_PERIOD_MS = 40;
        backendStatics.UPDATE_DRAIN_TIMEOUT_MS = 200;
        backendStatics.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS = 1;
        backendStatics.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS = 50;
        backendStatics.LATE_FLUSH_INTERVAL_MS = 5;
        backendStatics.LATE_FLUSH_QUIET_PERIOD_MS = 10;
        backendStatics.LATE_FLUSH_WINDOW_MS = 50;

        const doneFooter =
            'AGENT_NOTIFY_SUMMARY {"version":1,"agent":"a","project":"hapi","status":"done","summary":"Topic closed"}';
        const backend = new AcpSdkBackend({ command: 'agent', flavor: 'cursor' });
        const backendInternal = backend as unknown as {
            transport: {
                sendRequest: (...args: unknown[]) => Promise<unknown>;
                close: () => Promise<void>;
            } | null;
            handleSessionUpdate: (params: unknown) => void;
            sessionUpdateQueue: Promise<void>;
        };

        const messages: AgentMessage[] = [];
        backendInternal.transport = {
            sendRequest: async () => {
                // Hold the sessionUpdateQueue so the final answer is still queued
                // when session/prompt resolves — seal must await the queue first
                // (#2268 Minor).
                backendInternal.sessionUpdateQueue = backendInternal.sessionUpdateQueue.then(() => sleep(20));
                backendInternal.handleSessionUpdate({
                    sessionId: 'session-1',
                    update: {
                        sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
                        content: { type: 'text', text: `Finished.\n\n${doneFooter}` }
                    }
                });
                // Harness wake after native response resolves, during quiet window.
                setTimeout(() => {
                    backendInternal.handleSessionUpdate({
                        sessionId: 'session-1',
                        update: {
                            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
                            content: { type: 'text', text: 'Shell finished; here is a redundant summary.' }
                        }
                    });
                }, 35);
                return { stopReason: 'end_turn' };
            },
            close: async () => {}
        };

        await backend.prompt('session-1', [{ type: 'text', text: 'finish' }], (message) => {
            messages.push(message);
        });

        const textMessages = messages.filter((message) => message.type === 'text');
        expect(textMessages.map((message) => message.text)).toEqual([
            `Finished.\n\n${doneFooter}`,
            'Shell finished; here is a redundant summary.'
        ]);
    });

    it('combines OpenCode usage_update and prompt usage into a usage message', async () => {
        backendStatics.UPDATE_QUIET_PERIOD_MS = 25;
        backendStatics.UPDATE_DRAIN_TIMEOUT_MS = 200;
        backendStatics.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS = 1;
        backendStatics.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS = 50;
        backendStatics.LATE_FLUSH_INTERVAL_MS = 5;
        backendStatics.LATE_FLUSH_QUIET_PERIOD_MS = 10;
        backendStatics.LATE_FLUSH_WINDOW_MS = 50;

        const backend = new AcpSdkBackend({ command: 'opencode' });
        const backendInternal = backend as unknown as {
            transport: {
                sendRequest: (...args: unknown[]) => Promise<unknown>;
                close: () => Promise<void>;
            } | null;
            handleSessionUpdate: (params: unknown) => void;
        };

        const messages: AgentMessage[] = [];
        backendInternal.transport = {
            sendRequest: async () => {
                setTimeout(() => {
                    backendInternal.handleSessionUpdate({
                        sessionId: 'session-1',
                        update: {
                            sessionUpdate: 'usage_update',
                            used: 13_879,
                            size: 65_536,
                        }
                    });
                }, 0);

                await sleep(5);

                return {
                    stopReason: 'end_turn',
                    usage: {
                        totalTokens: 13_897,
                        inputTokens: 8_119,
                        outputTokens: 2,
                        thoughtTokens: 11,
                        cachedReadTokens: 5_760,
                        cachedWriteTokens: 5
                    }
                };
            },
            close: async () => {}
        };

        await backend.prompt('session-1', [{ type: 'text', text: 'hello' }], (message) => {
            messages.push(message);
        });

        expect(messages).toContainEqual({
            type: 'usage',
            inputTokens: 8_119,
            outputTokens: 2,
            cacheReadTokens: 5_760,
            cacheCreationTokens: 5,
            thoughtTokens: 11,
            totalTokens: 13_897,
            contextTokens: 13_879,
            contextWindow: 65_536
        });
    });

    it('emits straggler chunks before turn_complete', async () => {
        backendStatics.UPDATE_QUIET_PERIOD_MS = 5;
        backendStatics.UPDATE_DRAIN_TIMEOUT_MS = 50;
        backendStatics.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS = 1;
        backendStatics.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS = 50;
        backendStatics.LATE_FLUSH_INTERVAL_MS = 5;
        backendStatics.LATE_FLUSH_QUIET_PERIOD_MS = 30;
        backendStatics.LATE_FLUSH_WINDOW_MS = 500;

        const backend = new AcpSdkBackend({ command: 'opencode' });
        const backendInternal = backend as unknown as {
            transport: {
                sendRequest: (...args: unknown[]) => Promise<unknown>;
                close: () => Promise<void>;
            } | null;
            handleSessionUpdate: (params: unknown) => void;
        };

        const messages: AgentMessage[] = [];
        backendInternal.transport = {
            sendRequest: async () => {
                // Schedule a late chunk to arrive *after* session/prompt returns,
                // simulating a slow-tailing model that keeps emitting past the
                // initial post-prompt drain.
                setTimeout(() => {
                    backendInternal.handleSessionUpdate({
                        sessionId: 'session-1',
                        update: {
                            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
                            content: { type: 'text', text: 'late tail' }
                        }
                    });
                }, 20);
                return { stopReason: 'end_turn' };
            },
            close: async () => {}
        };

        await backend.prompt('session-1', [{ type: 'text', text: 'hi' }], (m) => messages.push(m));

        const lateIdx = messages.findIndex((m) => m.type === 'text' && m.text === 'late tail');
        const turnCompleteIdx = messages.findIndex((m) => m.type === 'turn_complete');

        expect(lateIdx).toBeGreaterThanOrEqual(0);
        expect(turnCompleteIdx).toBeGreaterThan(lateIdx);
    });

    it('skips session/prompt when shouldSend is false after pre-prompt drain', async () => {
        backendStatics.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS = 1;
        backendStatics.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS = 50;
        backendStatics.UPDATE_QUIET_PERIOD_MS = 1;
        backendStatics.UPDATE_DRAIN_TIMEOUT_MS = 50;
        backendStatics.LATE_FLUSH_WINDOW_MS = 1;

        const backend = new AcpSdkBackend({ command: 'opencode' });
        const backendInternal = backend as unknown as {
            transport: {
                sendRequest: (...args: unknown[]) => Promise<unknown>;
                close: () => Promise<void>;
            } | null;
        };
        let sendCalls = 0;
        backendInternal.transport = {
            sendRequest: async () => {
                sendCalls += 1;
                return { stopReason: 'end_turn' };
            },
            close: async () => {}
        };

        const sent = await backend.prompt(
            'session-1',
            [{ type: 'text', text: 'hi' }],
            () => {},
            { shouldSend: () => false }
        );
        expect(sent).toBe(false);
        expect(sendCalls).toBe(0);
    });

    it('attributes pre-prompt straggler chunks to the previous turn\'s onUpdate', async () => {
        backendStatics.UPDATE_QUIET_PERIOD_MS = 25;
        backendStatics.UPDATE_DRAIN_TIMEOUT_MS = 200;
        backendStatics.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS = 20;
        backendStatics.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS = 200;
        backendStatics.LATE_FLUSH_INTERVAL_MS = 5;
        backendStatics.LATE_FLUSH_QUIET_PERIOD_MS = 10;
        backendStatics.LATE_FLUSH_WINDOW_MS = 30;

        const backend = new AcpSdkBackend({ command: 'opencode' });
        const backendInternal = backend as unknown as {
            transport: {
                sendRequest: (...args: unknown[]) => Promise<unknown>;
                close: () => Promise<void>;
            } | null;
            handleSessionUpdate: (params: unknown) => void;
        };

        const turn1: AgentMessage[] = [];
        const turn2: AgentMessage[] = [];
        backendInternal.transport = {
            sendRequest: async () => ({ stopReason: 'end_turn' }),
            close: async () => {}
        };

        await backend.prompt('session-1', [{ type: 'text', text: 'hi' }], (m) => turn1.push(m));

        // Straggler arrives after turn 1 fully resolved but before turn 2 starts.
        // Pre-prompt drain in turn 2 should route it via turn 1's handler.
        backendInternal.handleSessionUpdate({
            sessionId: 'session-1',
            update: {
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
                content: { type: 'text', text: 'straggler from turn 1' }
            }
        });

        await backend.prompt('session-1', [{ type: 'text', text: 'again' }], (m) => turn2.push(m));

        const turn1Text = turn1.filter((m): m is Extract<AgentMessage, { type: 'text' }> => m.type === 'text').map((m) => m.text);
        const turn2Text = turn2.filter((m): m is Extract<AgentMessage, { type: 'text' }> => m.type === 'text').map((m) => m.text);

        expect(turn1Text).toContain('straggler from turn 1');
        expect(turn2Text).not.toContain('straggler from turn 1');
    });

    it('exits the late-flush wait once the model is quiet', async () => {
        backendStatics.UPDATE_QUIET_PERIOD_MS = 5;
        backendStatics.UPDATE_DRAIN_TIMEOUT_MS = 50;
        backendStatics.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS = 1;
        backendStatics.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS = 50;
        backendStatics.LATE_FLUSH_INTERVAL_MS = 5;
        backendStatics.LATE_FLUSH_QUIET_PERIOD_MS = 20;
        backendStatics.LATE_FLUSH_WINDOW_MS = 5000;

        const backend = new AcpSdkBackend({ command: 'opencode' });
        const backendInternal = backend as unknown as {
            transport: {
                sendRequest: (...args: unknown[]) => Promise<unknown>;
                close: () => Promise<void>;
            } | null;
        };

        backendInternal.transport = {
            sendRequest: async () => ({ stopReason: 'end_turn' }),
            close: async () => {}
        };

        const started = Date.now();
        await backend.prompt('session-1', [{ type: 'text', text: 'hi' }], () => {});
        const elapsed = Date.now() - started;

        // With no late chunks arriving, drainLateBuffers should exit on the
        // first quiet check well before the 5s window. Anything under ~500ms
        // proves we're not blocking on the full window.
        expect(elapsed).toBeLessThan(500);
    });

    it('catches stragglers when session/prompt paused before resolving', async () => {
        // Regression: if the model emitted chunks early in the turn, paused,
        // then sent stopReason, lastSessionUpdateAt is already stale when
        // drainLateBuffers starts. It must anchor the quiet window to entry
        // time, not just lastSessionUpdateAt, otherwise a chunk arriving just
        // after session/prompt resolves is missed.
        backendStatics.UPDATE_QUIET_PERIOD_MS = 5;
        backendStatics.UPDATE_DRAIN_TIMEOUT_MS = 50;
        backendStatics.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS = 1;
        backendStatics.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS = 50;
        backendStatics.LATE_FLUSH_INTERVAL_MS = 5;
        backendStatics.LATE_FLUSH_QUIET_PERIOD_MS = 50;
        backendStatics.LATE_FLUSH_WINDOW_MS = 500;

        const backend = new AcpSdkBackend({ command: 'opencode' });
        const backendInternal = backend as unknown as {
            transport: {
                sendRequest: (...args: unknown[]) => Promise<unknown>;
                close: () => Promise<void>;
            } | null;
            handleSessionUpdate: (params: unknown) => void;
        };

        const messages: AgentMessage[] = [];
        backendInternal.transport = {
            sendRequest: async () => {
                // Chunk arrives early, then a long pause stales lastSessionUpdateAt.
                backendInternal.handleSessionUpdate({
                    sessionId: 'session-1',
                    update: {
                        sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
                        content: { type: 'text', text: 'early' }
                    }
                });
                await sleep(200);
                // After sendRequest resolves, schedule a straggler.
                setTimeout(() => {
                    backendInternal.handleSessionUpdate({
                        sessionId: 'session-1',
                        update: {
                            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
                            content: { type: 'text', text: 'post-pause straggler' }
                        }
                    });
                }, 10);
                return { stopReason: 'end_turn' };
            },
            close: async () => {}
        };

        await backend.prompt('session-1', [{ type: 'text', text: 'hi' }], (m) => messages.push(m));

        const stragglerIdx = messages.findIndex((m) => m.type === 'text' && m.text === 'post-pause straggler');
        const turnCompleteIdx = messages.findIndex((m) => m.type === 'turn_complete');

        expect(stragglerIdx).toBeGreaterThanOrEqual(0);
        expect(turnCompleteIdx).toBeGreaterThan(stragglerIdx);
    });

    it('forwards usage_update to onUpdate during an active prompt', async () => {
        backendStatics.UPDATE_QUIET_PERIOD_MS = 25;
        backendStatics.UPDATE_DRAIN_TIMEOUT_MS = 200;
        backendStatics.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS = 1;
        backendStatics.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS = 50;
        backendStatics.LATE_FLUSH_INTERVAL_MS = 5;
        backendStatics.LATE_FLUSH_QUIET_PERIOD_MS = 10;
        backendStatics.LATE_FLUSH_WINDOW_MS = 50;

        const backend = new AcpSdkBackend({ command: 'agent' });
        const backendInternal = backend as unknown as {
            transport: {
                sendRequest: (...args: unknown[]) => Promise<unknown>;
                close: () => Promise<void>;
            } | null;
            handleSessionUpdate: (params: unknown) => void;
        };

        const messages: AgentMessage[] = [];
        backendInternal.transport = {
            sendRequest: async () => {
                backendInternal.handleSessionUpdate({
                    sessionId: 'session-1',
                    update: { sessionUpdate: 'usage_update', used: 1_000, size: 200_000 }
                });
                await sleep(5);
                backendInternal.handleSessionUpdate({
                    sessionId: 'session-1',
                    update: { sessionUpdate: 'usage_update', used: 2_500, size: 200_000 }
                });
                await sleep(5);
                return { stopReason: 'end_turn' };
            },
            close: async () => {}
        };

        await backend.prompt('session-1', [{ type: 'text', text: 'hi' }], (m) => messages.push(m));

        const realtimeUsage = messages.filter(
            (m): m is Extract<AgentMessage, { type: 'usage' }> =>
                m.type === 'usage' && m.contextTokens !== undefined
        );
        expect(realtimeUsage.map((m) => m.contextTokens)).toEqual([1_000, 2_500]);
    });

    it('forwards title changes from session_info_update', () => {
        const backend = new AcpSdkBackend({ command: 'agent' });
        const updates: Array<{ sessionId: string | null; title: string | null }> = [];
        backend.setSessionInfoUpdateListener((update) => updates.push(update));

        const backendInternal = backend as unknown as {
            activeSessionId: string | null;
            handleSessionUpdate: (params: unknown) => void;
        };
        backendInternal.activeSessionId = 'session-1';

        backendInternal.handleSessionUpdate({
            sessionId: 'session-1',
            update: {
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.sessionInfoUpdate,
                title: 'Native ACP title'
            }
        });
        backendInternal.handleSessionUpdate({
            sessionId: 'session-1',
            update: {
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.sessionInfoUpdate,
                title: null
            }
        });
        backendInternal.handleSessionUpdate({
            sessionId: 'session-1',
            update: {
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.sessionInfoUpdate,
                title: 123
            }
        });
        backendInternal.handleSessionUpdate({
            sessionId: 'other-session',
            update: {
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.sessionInfoUpdate,
                title: 'Wrong session'
            }
        });

        expect(updates).toEqual([
            { sessionId: 'session-1', title: 'Native ACP title' },
            { sessionId: 'session-1', title: null }
        ]);
    });

    it('emits a context-only usage on finalize when the prompt response carries no usage', async () => {
        backendStatics.UPDATE_QUIET_PERIOD_MS = 25;
        backendStatics.UPDATE_DRAIN_TIMEOUT_MS = 200;
        backendStatics.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS = 1;
        backendStatics.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS = 50;
        backendStatics.LATE_FLUSH_INTERVAL_MS = 5;
        backendStatics.LATE_FLUSH_QUIET_PERIOD_MS = 10;
        backendStatics.LATE_FLUSH_WINDOW_MS = 50;

        const backend = new AcpSdkBackend({ command: 'opencode' });
        const backendInternal = backend as unknown as {
            transport: {
                sendRequest: (...args: unknown[]) => Promise<unknown>;
                close: () => Promise<void>;
            } | null;
            handleSessionUpdate: (params: unknown) => void;
        };

        const messages: AgentMessage[] = [];
        backendInternal.transport = {
            sendRequest: async () => {
                backendInternal.handleSessionUpdate({
                    sessionId: 'session-1',
                    update: { sessionUpdate: 'usage_update', used: 4_200, size: 200_000 }
                });
                await sleep(5);
                // No `usage` field on the response: simulates slash-handled
                // turns or errored turns that skip the model.
                return { stopReason: 'end_turn' };
            },
            close: async () => {}
        };

        await backend.prompt('session-1', [{ type: 'text', text: 'hi' }], (m) => messages.push(m));

        const usageMessages = messages.filter((m): m is Extract<AgentMessage, { type: 'usage' }> => m.type === 'usage');
        expect(usageMessages.length).toBe(1);
        expect(usageMessages[0]).toMatchObject({
            inputTokens: 0,
            outputTokens: 0,
            contextTokens: 4_200,
            contextWindow: 200_000
        });
    });

    it('authenticateIfAvailable calls _client/authenticate when method is advertised', async () => {
        const backend = new AcpSdkBackend({ command: 'agent' });
        const calls: Array<{ method: string; params: unknown }> = [];
        const backendInternal = backend as unknown as {
            initializeResult: { protocolVersion: number; authMethods?: Array<{ id: string }> } | null;
            transport: { sendRequest: (method: string, params: unknown) => Promise<unknown>; close: () => Promise<void> } | null;
        };
        backendInternal.initializeResult = {
            protocolVersion: 1,
            authMethods: [{ id: 'cursor_login' }]
        };
        backendInternal.transport = {
            sendRequest: async (method, params) => {
                calls.push({ method, params });
                return null;
            },
            close: async () => {}
        };

        await backend.authenticateIfAvailable('cursor_login');

        expect(calls).toEqual([
            { method: '_client/authenticate', params: { methodId: 'cursor_login' } }
        ]);
    });

    it('authenticateIfAvailable does not throw when _client/authenticate is unsupported', async () => {
        const backend = new AcpSdkBackend({ command: 'agent' });
        const backendInternal = backend as unknown as {
            initializeResult: { protocolVersion: number; authMethods?: Array<{ id: string }> } | null;
            transport: { sendRequest: (method: string, params: unknown) => Promise<unknown>; close: () => Promise<void> } | null;
        };
        backendInternal.initializeResult = {
            protocolVersion: 1,
            authMethods: [{ id: 'cursor_login' }]
        };
        backendInternal.transport = {
            sendRequest: async () => {
                throw new Error('"Method not found": _client/authenticate');
            },
            close: async () => {}
        };

        await expect(backend.authenticateIfAvailable('cursor_login')).resolves.toBeUndefined();
    });

    it('authenticateIfAvailable is a no-op when method is not advertised', async () => {
        const backend = new AcpSdkBackend({ command: 'agent' });
        const calls: Array<{ method: string; params: unknown }> = [];
        const backendInternal = backend as unknown as {
            initializeResult: { protocolVersion: number; authMethods?: Array<{ id: string }> } | null;
            transport: { sendRequest: (method: string, params: unknown) => Promise<unknown>; close: () => Promise<void> } | null;
        };
        backendInternal.initializeResult = { protocolVersion: 1, authMethods: [] };
        backendInternal.transport = {
            sendRequest: async (method, params) => {
                calls.push({ method, params });
                return null;
            },
            close: async () => {}
        };

        await backend.authenticateIfAvailable('cursor_login');

        expect(calls).toEqual([]);
    });

    it('supportsLoadSession reflects initialize agentCapabilities', () => {
        const backend = new AcpSdkBackend({ command: 'agent' });
        const backendInternal = backend as unknown as {
            initializeResult: { protocolVersion: number; agentCapabilities?: { loadSession?: boolean } } | null;
        };
        backendInternal.initializeResult = {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true }
        };

        expect(backend.supportsLoadSession()).toBe(true);

        backendInternal.initializeResult = {
            protocolVersion: 1,
            agentCapabilities: { loadSession: false }
        };
        expect(backend.supportsLoadSession()).toBe(false);
    });

    it('supportsSessionResume reflects DSH session capabilities', () => {
        const backend = new AcpSdkBackend({ command: 'dsh' });
        const backendInternal = backend as unknown as {
            initializeResult: {
                protocolVersion: number;
                agentCapabilities?: { sessionCapabilities?: Record<string, unknown> };
            } | null;
        };

        backendInternal.initializeResult = {
            protocolVersion: 1,
            agentCapabilities: { sessionCapabilities: { resume: {} } }
        };
        expect(backend.supportsSessionResume()).toBe(true);

        backendInternal.initializeResult = {
            protocolVersion: 1,
            agentCapabilities: { sessionCapabilities: { list: {} } }
        };
        expect(backend.supportsSessionResume()).toBe(false);
    });

    it('resumeSession sends DSH session/resume and returns the native id', async () => {
        const backend = new AcpSdkBackend({ command: 'dsh' });
        const calls: Array<{ method: string; params: unknown }> = [];
        const backendInternal = backend as unknown as {
            transport: {
                sendRequest: (method: string, params: unknown) => Promise<unknown>;
                close: () => Promise<void>;
            } | null;
        };
        backendInternal.transport = {
            sendRequest: async (method, params) => {
                calls.push({ method, params });
                return { configOptions: [] };
            },
            close: async () => {}
        };

        const sessionId = await backend.resumeSession({
            sessionId: 'dsh-session-1',
            cwd: '/tmp/project',
            mcpServers: []
        });

        expect(sessionId).toBe('dsh-session-1');
        expect(calls).toEqual([{
            method: 'session/resume',
            params: {
                sessionId: 'dsh-session-1',
                cwd: '/tmp/project',
                mcpServers: []
            }
        }]);
    });

    it('does not retry a terminal session/resume rejection (dsh: mismatched cwd / active session)', async () => {
        // dsh answers a resume whose cwd does not realpath-match the stored
        // session (or one that is still active elsewhere) with a TERMINAL
        // invalidParams JSON-RPC error. Retrying it would only delay the
        // caller's fresh-session fallback by the full backoff chain.
        const backend = new AcpSdkBackend({ command: 'dsh' });
        const calls: Array<{ method: string; params: unknown }> = [];
        const backendInternal = backend as unknown as {
            transport: {
                sendRequest: (method: string, params: unknown) => Promise<unknown>;
                close: () => Promise<void>;
            } | null;
        };
        backendInternal.transport = {
            sendRequest: async (method, params) => {
                calls.push({ method, params });
                throw new Error('Session cwd mismatch: session belongs to /other/path (-32602 invalidParams)');
            },
            close: async () => {}
        };

        await expect(backend.resumeSession({
            sessionId: 'dsh-stored-1',
            cwd: '/tmp',
            mcpServers: []
        })).rejects.toThrow('invalidParams');

        // Exactly one session/resume request — no retry of the terminal error.
        expect(calls.filter((call) => call.method === 'session/resume')).toHaveLength(1);
    });

    it('retries a transport-indeterminate session/resume failure and then succeeds', async () => {
        // The child process died mid-request: the failure carries the
        // transport's indeterminate marker (after a respawn the same request
        // can succeed, so retrying it is correct).
        const backend = new AcpSdkBackend({ command: 'dsh' });
        const calls: Array<{ method: string; params: unknown }> = [];
        let attempts = 0;
        const backendInternal = backend as unknown as {
            transport: {
                sendRequest: (method: string, params: unknown) => Promise<unknown>;
                close: () => Promise<void>;
            } | null;
        };
        backendInternal.transport = {
            sendRequest: async (method, params) => {
                calls.push({ method, params });
                attempts += 1;
                if (attempts === 1) {
                    const error = new Error('ACP process exited (code=1, signal=null)');
                    Object.defineProperty(error, ACP_INDETERMINATE_SYMBOL, { value: true });
                    throw error;
                }
                return { configOptions: [] };
            },
            close: async () => {}
        };

        const sessionId = await backend.resumeSession({
            sessionId: 'dsh-stored-1',
            cwd: '/tmp',
            mcpServers: []
        });

        expect(sessionId).toBe('dsh-stored-1');
        expect(calls.filter((call) => call.method === 'session/resume')).toHaveLength(2);
    });

    it('setMode falls back to session/set_config_option when session/set_mode is missing', async () => {
        const backend = new AcpSdkBackend({ command: 'agent' });
        const calls: Array<{ method: string; params: unknown }> = [];
        const backendInternal = backend as unknown as {
            transport: { sendRequest: (method: string, params: unknown) => Promise<unknown>; registerRequestHandler: (method: string, handler: unknown) => void; close: () => Promise<void> } | null;
            sessionConfigOptions: Map<string, Array<{ id: string; category?: string; options: Array<{ value: string }> }>>;
        };
        backendInternal.transport = {
            sendRequest: async (method, params) => {
                calls.push({ method, params });
                if (method === 'session/set_mode') {
                    throw new Error('method not found');
                }
                return null;
            },
            registerRequestHandler: () => {},
            close: async () => {}
        };
        backendInternal.sessionConfigOptions.set('session-1', [
            { id: 'mode-opt', category: 'mode', options: [{ value: 'agent' }, { value: 'plan' }] }
        ]);

        await backend.setMode('session-1', 'plan');

        expect(calls).toEqual([
            { method: 'session/set_mode', params: { sessionId: 'session-1', modeId: 'plan' } },
            { method: 'session/set_config_option', params: { sessionId: 'session-1', configId: 'mode-opt', value: 'plan' } }
        ]);
    });

    it('registerExtensionRequestHandler wires transport handlers', () => {
        const registered = new Map<string, unknown>();
        const backend = new AcpSdkBackend({ command: 'agent' });
        const backendInternal = backend as unknown as {
            transport: { registerRequestHandler: (method: string, handler: unknown) => void; close: () => Promise<void> } | null;
        };
        backendInternal.transport = {
            registerRequestHandler(method, handler) {
                registered.set(method, handler);
            },
            close: async () => {}
        };

        const handler = vi.fn();
        backend.registerExtensionRequestHandler('cursor/ask_question', handler);

        expect(registered.get('cursor/ask_question')).toBe(handler);
    });

    it('beginSoftSteerPrompt sends concurrent session/prompt without cancel', () => {
        const backend = new AcpSdkBackend({ command: 'agent' });
        const calls: Array<{ method: string; params: unknown }> = [];
        const backendInternal = backend as unknown as {
            transport: {
                sendRequestWithDispatch: (method: string, params: unknown, options?: { timeoutMs?: number }) => { dispatched: Promise<void>; completed: Promise<unknown> };
                sendNotification: (method: string, params: unknown) => void;
                close: () => Promise<void>;
            } | null;
            isProcessingMessage: boolean;
        };
        backendInternal.isProcessingMessage = true;
        backendInternal.transport = {
            sendRequestWithDispatch: (method, params) => {
                calls.push({ method, params });
                return { dispatched: Promise.resolve(), completed: Promise.resolve({ stopReason: 'end_turn' }) };
            },
            sendNotification: () => {},
            close: async () => {}
        };

        backend.beginSoftSteerPrompt('session-1', [{ type: 'text', text: 'pivot now' }]);

        expect(calls).toEqual([{
            method: 'session/prompt',
            params: {
                sessionId: 'session-1',
                prompt: [{ type: 'text', text: 'pivot now' }]
            }
        }]);
    });

    it('logs why a soft-steer prompt failed', async () => {
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        const backend = new AcpSdkBackend({ command: 'agent' });
        const backendInternal = backend as unknown as {
            transport: {
                sendRequestWithDispatch: () => { dispatched: Promise<void>; completed: Promise<unknown> };
                sendNotification: () => void;
                close: () => Promise<void>;
            } | null;
            isProcessingMessage: boolean;
        };
        backendInternal.isProcessingMessage = true;
        const failure = Object.assign(new Error('waiting for a permission answer'), { code: -32603 });
        backendInternal.transport = {
            sendRequestWithDispatch: () => ({ dispatched: Promise.resolve(), completed: Promise.reject(failure) }),
            sendNotification: () => {},
            close: async () => {}
        };

        await expect(backend.beginSoftSteerPrompt('session-1', [{ type: 'text', text: 'pivot now' }]).completed)
            .rejects.toBe(failure);

        expect(warn).toHaveBeenCalledWith('[ACP] soft-steer session/prompt failed', {
            message: 'waiting for a permission answer',
            code: -32603
        });
        warn.mockRestore();
    });

    it('beginSoftSteerPrompt settles answered before it drains late output', async () => {
        const backend = new AcpSdkBackend({ command: 'agent' });
        const events: string[] = [];
        const backendInternal = backend as unknown as {
            transport: {
                sendRequestWithDispatch: () => { dispatched: Promise<void>; completed: Promise<unknown> };
                close: () => Promise<void>;
            } | null;
            isProcessingMessage: boolean;
            waitForSessionUpdateQuiet: (quietMs: number, timeoutMs: number) => Promise<void>;
            drainLateBuffers: () => Promise<void>;
        };
        backendInternal.isProcessingMessage = true;
        let releaseDrain!: () => void;
        backendInternal.waitForSessionUpdateQuiet = () => new Promise((resolve) => { releaseDrain = resolve; });
        backendInternal.drainLateBuffers = async () => {};
        backendInternal.transport = {
            sendRequestWithDispatch: () => ({ dispatched: Promise.resolve(), completed: Promise.resolve({ stopReason: 'end_turn' }) }),
            close: async () => {}
        };

        const steer = backend.beginSoftSteerPrompt('session-1', [{ type: 'text', text: 'pivot now' }]);
        void steer.completed.then(() => events.push('completed'));
        await steer.answered;
        events.push('answered');
        await vi.waitFor(() => expect(releaseDrain).toBeTypeOf('function'));
        expect(events).toEqual(['answered']);
        releaseDrain();
        await steer.completed;
        expect(events).toEqual(['answered', 'completed']);
    });

    it('beginSoftSteerPrompt drains buffered output after completion', async () => {
        const backend = new AcpSdkBackend({ command: 'agent' });
        const backendInternal = backend as unknown as {
            transport: {
                sendRequestWithDispatch: (method: string, params: unknown, options?: { timeoutMs?: number }) => { dispatched: Promise<void>; completed: Promise<unknown> };
                close: () => Promise<void>;
            } | null;
            isProcessingMessage: boolean;
            waitForSessionUpdateQuiet: (quietMs: number, timeoutMs: number) => Promise<void>;
            drainLateBuffers: () => Promise<void>;
            messageHandler: { drainBuffers: () => void } | null;
        };
        const events: string[] = [];
        backendInternal.isProcessingMessage = true;
        backendInternal.transport = {
            sendRequestWithDispatch: () => {
                events.push('request');
                return { dispatched: Promise.resolve(), completed: Promise.resolve({ stopReason: 'end_turn' }) };
            },
            close: async () => {}
        };
        backendInternal.waitForSessionUpdateQuiet = async () => {
            events.push('quiet');
        };
        backendInternal.messageHandler = {
            drainBuffers: () => events.push('drain')
        };
        backendInternal.drainLateBuffers = async () => {
            events.push('late');
        };

        await backend.beginSoftSteerPrompt('session-1', [{ type: 'text', text: 'pivot now' }]).completed;

        expect(events).toEqual(['request', 'quiet', 'drain', 'late', 'drain']);
    });

    it('beginSoftSteerPrompt reports the steered prompt usage with the latest context size', async () => {
        // agy 1.5.2 answers each request of a steered turn with only its own share.
        const steerResponse = agySteeredTurn.frames
            .filter((frame) => frame.direction === 'agy->client' && 'result' in frame.message)
            .map((frame) => (frame.message as { result: unknown }).result)
            .at(-1);
        const backend = new AcpSdkBackend({ command: 'agent' });
        const backendInternal = backend as unknown as {
            transport: {
                sendRequestWithDispatch: (method: string, params: unknown, options?: { timeoutMs?: number }) => { dispatched: Promise<void>; completed: Promise<unknown> };
                close: () => Promise<void>;
            } | null;
            isProcessingMessage: boolean;
            latestUsageUpdate: { contextTokens: number | undefined; contextWindow: number | undefined } | null;
            waitForSessionUpdateQuiet: (quietMs: number, timeoutMs: number) => Promise<void>;
            drainLateBuffers: () => Promise<void>;
        };
        backendInternal.isProcessingMessage = true;
        backendInternal.latestUsageUpdate = { contextTokens: 15_300, contextWindow: 1_000_000 };
        backendInternal.transport = {
            sendRequestWithDispatch: () => ({ dispatched: Promise.resolve(), completed: Promise.resolve(steerResponse) }),
            close: async () => {}
        };
        backendInternal.waitForSessionUpdateQuiet = async () => {};
        backendInternal.drainLateBuffers = async () => {};
        const usages: unknown[] = [];

        const stopReason = await backend.beginSoftSteerPrompt(
            'session-1',
            [{ type: 'text', text: 'pivot now' }],
            { onUsage: (usage) => usages.push(usage) }
        ).completed;

        expect(stopReason).toBe('end_turn');
        expect(usages).toEqual([{
            type: 'usage',
            inputTokens: 15286,
            outputTokens: 14,
            totalTokens: 15300,
            thoughtTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            contextTokens: 15_300,
            contextWindow: 1_000_000
        }]);
    });

    it('beginSoftSteerPrompt returns a pending promise without blocking the caller', async () => {
        const backend = new AcpSdkBackend({ command: 'agent' });
        let resolvePrompt: ((value: unknown) => void) | null = null;
        const backendInternal = backend as unknown as {
            transport: {
                sendRequestWithDispatch: (method: string, params: unknown, options?: { timeoutMs?: number }) => { dispatched: Promise<void>; completed: Promise<unknown> };
                sendNotification: (method: string, params: unknown) => void;
                close: () => Promise<void>;
            } | null;
            isProcessingMessage: boolean;
        };
        backendInternal.isProcessingMessage = true;
        backendInternal.transport = {
            sendRequestWithDispatch: () => ({
                dispatched: Promise.resolve(),
                completed: new Promise((resolve) => { resolvePrompt = resolve; })
            }),
            sendNotification: () => {},
            close: async () => {}
        };

        // Must not hang waiting for the ACP prompt response (hub RPC is 30s).
        let settled = false;
        const pending = backend.beginSoftSteerPrompt('session-1', [{ type: 'text', text: 'pivot now' }]).completed.then(() => {
            settled = true;
        });
        expect(resolvePrompt).not.toBeNull();
        expect(settled).toBe(false);
        resolvePrompt!({ stopReason: 'end_turn' });
        await pending;
        expect(settled).toBe(true);
    });

    it('keeps response completion pending until a concurrent soft steer settles', async () => {
        const backend = new AcpSdkBackend({ command: 'agent' });
        let resolvePrompt: ((value: unknown) => void) | null = null;
        const backendInternal = backend as unknown as {
            transport: { sendRequestWithDispatch: () => { dispatched: Promise<void>; completed: Promise<unknown> }; close: () => Promise<void> } | null;
            isProcessingMessage: boolean;
            activePromptRequests: number;
            finishPromptRequest: (epoch: number) => void;
            waitForSessionUpdateQuiet: () => Promise<void>;
            drainLateBuffers: () => Promise<void>;
        };
        backendInternal.isProcessingMessage = true;
        backendInternal.activePromptRequests = 1;
        backendInternal.transport = {
            sendRequestWithDispatch: () => ({
                dispatched: Promise.resolve(),
                completed: new Promise((resolve) => { resolvePrompt = resolve; })
            }),
            close: async () => {}
        };
        backendInternal.waitForSessionUpdateQuiet = async () => {};
        backendInternal.drainLateBuffers = async () => {};

        const pendingSteer = backend.beginSoftSteerPrompt('session-1', [{ type: 'text', text: 'pivot now' }]);
        let responseComplete = false;
        const responseWait = backend.waitForResponseComplete().then(() => { responseComplete = true; });

        backendInternal.finishPromptRequest(0);
        await Promise.resolve();
        expect(backend.processingMessage).toBe(true);
        expect(responseComplete).toBe(false);

        resolvePrompt!({ stopReason: 'end_turn' });
        await pendingSteer.completed;
        await responseWait;
        expect(backend.processingMessage).toBe(false);
        expect(responseComplete).toBe(true);
    });

    it('softSteerPrompt awaits session/prompt completion', async () => {
        const backend = new AcpSdkBackend({ command: 'agent' });
        let resolvePrompt: ((value: unknown) => void) | null = null;
        const backendInternal = backend as unknown as {
            transport: {
                sendRequest: (method: string, params: unknown, options?: { timeoutMs?: number }) => Promise<unknown>;
                sendNotification: (method: string, params: unknown) => void;
                close: () => Promise<void>;
            } | null;
            isProcessingMessage: boolean;
        };
        backendInternal.isProcessingMessage = true;
        backendInternal.transport = {
            sendRequest: () => new Promise((resolve) => {
                resolvePrompt = resolve;
            }),
            sendNotification: () => {},
            close: async () => {}
        };

        let done = false;
        const pending = backend.softSteerPrompt('session-1', [{ type: 'text', text: 'pivot now' }]).then(() => {
            done = true;
        });
        await Promise.resolve();
        expect(done).toBe(false);
        resolvePrompt!({ stopReason: 'end_turn' });
        await pending;
        expect(done).toBe(true);
    });

    it('beginSoftSteerPrompt rejects when no prompt is in flight', () => {
        const backend = new AcpSdkBackend({ command: 'agent' });
        const backendInternal = backend as unknown as {
            transport: { sendRequest: () => Promise<unknown>; close: () => Promise<void> } | null;
            isProcessingMessage: boolean;
        };
        backendInternal.isProcessingMessage = false;
        backendInternal.transport = {
            sendRequest: async () => null,
            close: async () => {}
        };

        expect(() => backend.beginSoftSteerPrompt('session-1', [{ type: 'text', text: 'x' }]))
            .toThrow(/No active ACP prompt/);
    });


    it('suppressUpdatesDuring drops session/update notifications that would otherwise leak into the previous turn\'s onUpdate, then restores normal forwarding', async () => {
        // Reproduces the real /compact duplicate-summary bug: OpenCode keeps
        // streaming session/update notifications (over the same ACP
        // transport) while a raw-HTTP /compact call is in flight outside
        // prompt(), and handleSessionUpdate forwards them unconditionally to
        // whatever messageHandler is still installed from the last prompt()
        // turn — rendering the same content a second time alongside the
        // compact bridge's own explicit summary message.
        //
        // Fast quiet-drain timing so this test doesn't pay the real
        // (production) 200ms/1200ms PRE_PROMPT_* delay suppressUpdatesDuring
        // now waits through before restoring the handler.
        backendStatics.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS = 5;
        backendStatics.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS = 50;

        const backend = new AcpSdkBackend({ command: 'opencode' });
        const backendInternal = backend as unknown as {
            transport: {
                sendRequest: (...args: unknown[]) => Promise<unknown>;
                close: () => Promise<void>;
            } | null;
            handleSessionUpdate: (params: unknown) => void;
            messageHandler: unknown;
            sessionUpdateQueue: Promise<void>;
        };
        backendInternal.transport = {
            sendRequest: async () => ({ stopReason: 'end_turn' }),
            close: async () => {}
        };

        const turn1: AgentMessage[] = [];
        await backend.prompt('session-1', [{ type: 'text', text: 'hi' }], (m) => turn1.push(m));

        const emitPlanUpdate = () => backendInternal.handleSessionUpdate({
            sessionId: 'session-1',
            update: {
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.plan,
                entries: [{ content: 'leaked plan step', priority: 'medium', status: 'pending' }]
            }
        });

        const handlerBeforeSuppression = backendInternal.messageHandler;
        expect(handlerBeforeSuppression).not.toBeNull();

        let handlerDuringSuppression: unknown = 'not-checked';
        const result = await backend.suppressUpdatesDuring(async () => {
            handlerDuringSuppression = backendInternal.messageHandler;
            emitPlanUpdate();
            return 'compact result';
        });

        expect(result).toBe('compact result');
        expect(handlerDuringSuppression).toBeNull();
        await backendInternal.sessionUpdateQueue;
        expect(turn1.some((m) => m.type === 'plan')).toBe(false);

        // The previous turn's handler must be back in place afterward so
        // ordinary straggler-forwarding (covered elsewhere) is unaffected.
        expect(backendInternal.messageHandler).toBe(handlerBeforeSuppression);
        emitPlanUpdate();
        // #958 queues message-handler work (async image registration); await
        // before asserting delivery — upstream assumed sync handleUpdate.
        await backendInternal.sessionUpdateQueue;
        expect(turn1.some((m) => m.type === 'plan')).toBe(true);
    });

    it('waits for a quiet period (reusing the same drain prompt() uses before swapping handlers) before restoring the handler after suppressUpdatesDuring, so a late server-side straggler from an already-aborted operation cannot leak', async () => {
        // Reproduces a hostile-review finding: aborting the client-side HTTP
        // call (e.g. compactAbortController) does not mean the OpenCode
        // server actually stopped the operation — session/update is a
        // separate notification channel from that HTTP request's lifecycle.
        // If suppressUpdatesDuring restored the handler the instant `fn`
        // resolved, a straggler notification arriving moments later (while
        // the server is still winding the operation down) would leak
        // straight into the restored handler.
        backendStatics.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS = 30;
        backendStatics.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS = 300;

        const backend = new AcpSdkBackend({ command: 'opencode' });
        const backendInternal = backend as unknown as {
            transport: {
                sendRequest: (...args: unknown[]) => Promise<unknown>;
                close: () => Promise<void>;
            } | null;
            handleSessionUpdate: (params: unknown) => void;
            messageHandler: unknown;
            sessionUpdateQueue: Promise<void>;
        };
        backendInternal.transport = {
            sendRequest: async () => ({ stopReason: 'end_turn' }),
            close: async () => {}
        };

        const turn1: AgentMessage[] = [];
        await backend.prompt('session-1', [{ type: 'text', text: 'hi' }], (m) => turn1.push(m));

        const emitPlanUpdate = () => backendInternal.handleSessionUpdate({
            sessionId: 'session-1',
            update: {
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.plan,
                entries: [{ content: 'late server-side straggler', priority: 'medium', status: 'pending' }]
            }
        });

        const handlerBeforeSuppression = backendInternal.messageHandler;

        const suppressPromise = backend.suppressUpdatesDuring(async () => {
            // Client gives up almost immediately (mirrors compactAbortController
            // firing), but the server keeps streaming for a little longer —
            // one update right away, one more 15ms later.
            emitPlanUpdate();
            setTimeout(emitPlanUpdate, 15);
            return 'aborted-early';
        });

        // Sampled while suppressUpdatesDuring's own returned promise is
        // still pending (fn already resolved, but the quiet-drain in its
        // `finally` has not) — this is what actually proves restoration is
        // *deferred*, not merely eventually correct.
        await sleep(20);
        const handlerDuringDrainWindow = backendInternal.messageHandler;

        const result = await suppressPromise;

        expect(result).toBe('aborted-early');
        expect(handlerDuringDrainWindow).toBeNull();
        // Neither the immediate update nor the +15ms straggler leaked —
        // messageHandler was null (suppressed) for both.
        await backendInternal.sessionUpdateQueue;
        expect(turn1.some((m) => m.type === 'plan')).toBe(false);

        expect(backendInternal.messageHandler).toBe(handlerBeforeSuppression);

        // Normal forwarding resumes once actually restored.
        emitPlanUpdate();
        await backendInternal.sessionUpdateQueue;
        expect(turn1.some((m) => m.type === 'plan')).toBe(true);
    });

    it('starts the suppression quiet window at operation completion when the previous turn was already idle', async () => {
        backendStatics.UPDATE_QUIET_PERIOD_MS = 5;
        backendStatics.UPDATE_DRAIN_TIMEOUT_MS = 100;
        backendStatics.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS = 30;
        backendStatics.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS = 300;
        backendStatics.LATE_FLUSH_INTERVAL_MS = 5;
        backendStatics.LATE_FLUSH_QUIET_PERIOD_MS = 5;
        backendStatics.LATE_FLUSH_WINDOW_MS = 30;
        const backend = new AcpSdkBackend({ command: 'opencode', flavor: 'opencode', textChunkMode: 'delta' });
        const internal = backend as unknown as {
            transport: unknown;
            handleNotification(method: string, params: unknown): void;
            sessionUpdateQueue: Promise<void>;
            lastSessionUpdateAt: number;
        };
        internal.transport = { sendRequest: async () => ({ stopReason: 'end_turn' }), close: async () => {} };
        const updates: AgentMessage[] = [];
        let timer: ReturnType<typeof setTimeout> | undefined;
        let delivered!: () => void;
        const notificationDelivered = new Promise<void>(resolve => { delivered = resolve; });
        const emitPlan = (text: string) => internal.handleNotification('session/update', {
            sessionId: 'session-1', update: { sessionUpdate: ACP_SESSION_UPDATE_TYPES.plan,
                entries: [{ content: text, priority: 'medium', status: 'pending' }] }
        });
        try {
            await backend.prompt('session-1', [{ type: 'text', text: 'completed turn' }], update => updates.push(update));
            // No notification has arrived during a long idle period before reload.
            internal.lastSessionUpdateAt = Date.now() - 1_000;
            const idleActivity = backend.getLastSessionUpdateAt();
            const result = await backend.suppressUpdatesDuring(async () => {
                timer = setTimeout(() => { emitPlan('late-reload-history'); delivered(); }, 15);
                return 'loaded';
            });
            await notificationDelivered;
            await internal.sessionUpdateQueue;
            expect(result).toBe('loaded');
            expect(JSON.stringify(updates)).not.toContain('late-reload-history');
            expect(backend.getLastSessionUpdateAt()).toBeGreaterThan(idleActivity);
            emitPlan('ordinary-update-after-reload');
            await internal.sessionUpdateQueue;
            expect(JSON.stringify(updates)).toContain('ordinary-update-after-reload');
        } finally {
            if (timer) clearTimeout(timer);
            await backend.disconnect();
        }
    });

    it('restores suppression after a load failure without discarding metadata, usage or the next response', async () => {
        backendStatics.UPDATE_QUIET_PERIOD_MS = 5;
        backendStatics.UPDATE_DRAIN_TIMEOUT_MS = 100;
        backendStatics.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS = 30;
        backendStatics.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS = 300;
        backendStatics.LATE_FLUSH_INTERVAL_MS = 5;
        backendStatics.LATE_FLUSH_QUIET_PERIOD_MS = 5;
        backendStatics.LATE_FLUSH_WINDOW_MS = 30;
        const retryOptions = (AcpSdkBackend as unknown as { INIT_RETRY_OPTIONS: { maxAttempts: number } }).INIT_RETRY_OPTIONS;
        const originalMaxAttempts = retryOptions.maxAttempts;
        retryOptions.maxAttempts = 1;
        const backend = new AcpSdkBackend({ command: 'opencode', flavor: 'opencode', textChunkMode: 'delta' });
        const internal = backend as unknown as {
            transport: unknown;
            handleNotification(method: string, params: unknown): void;
            sessionUpdateQueue: Promise<void>;
            messageHandler: unknown;
            latestUsageUpdate: unknown;
        };
        const emit = (update: unknown) => internal.handleNotification('session/update', { sessionId: 'session-1', update });
        let promptCount = 0;
        internal.transport = {
            close: async () => {},
            sendRequest: async (method: string) => {
                if (method === 'session/load') {
                    emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'failed-load-replay' } });
                    emit({ sessionUpdate: 'session_info_update', title: 'loaded-session-title' });
                    emit({ sessionUpdate: 'usage_update', used: 4_200, size: 200_000 });
                    throw new Error('fixture load rejection');
                }
                if (++promptCount === 2) emit({ sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: 'normal-after-load-failure' } });
                return { stopReason: 'end_turn' };
            }
        };
        const previous: AgentMessage[] = [];
        const titles: unknown[] = [];
        backend.setSessionInfoUpdateListener(update => titles.push(update));
        try {
            await backend.prompt('session-1', [{ type: 'text', text: 'previous prompt' }], update => previous.push(update));
            const previousHandler = internal.messageHandler;
            await expect(backend.suppressUpdatesDuring(() => backend.loadSession({
                sessionId: 'session-1', cwd: '/tmp/project', mcpServers: []
            }))).rejects.toThrow('fixture load rejection');
            await internal.sessionUpdateQueue;
            expect(internal.messageHandler).toBe(previousHandler);
            expect(JSON.stringify(previous)).not.toContain('failed-load-replay');
            expect(titles).toEqual([{ sessionId: 'session-1', title: 'loaded-session-title' }]);
            expect(internal.latestUsageUpdate).toMatchObject({ contextTokens: 4_200, contextWindow: 200_000 });
            const next: AgentMessage[] = [];
            await backend.prompt('session-1', [{ type: 'text', text: 'next prompt' }], update => next.push(update));
            expect(JSON.stringify(previous)).not.toContain('failed-load-replay');
            expect(JSON.stringify(next)).toContain('normal-after-load-failure');
            expect(JSON.stringify(next)).not.toContain('failed-load-replay');
        } finally {
            retryOptions.maxAttempts = originalMaxAttempts;
            await backend.disconnect();
        }
    });

    it('drops updates enqueued while suppressed even if the queue drains after the handler is restored', async () => {
        // If handleSessionUpdate looked up this.messageHandler when the queued
        // microtask ran (instead of capturing it at enqueue), a compact-era
        // update stuck behind earlier async image work would leak into the
        // restored handler after suppressUpdatesDuring returns.
        backendStatics.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS = 5;
        backendStatics.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS = 50;

        const backend = new AcpSdkBackend({ command: 'opencode' });
        const backendInternal = backend as unknown as {
            transport: {
                sendRequest: (...args: unknown[]) => Promise<unknown>;
                close: () => Promise<void>;
            } | null;
            handleSessionUpdate: (params: unknown) => void;
            messageHandler: unknown;
            sessionUpdateQueue: Promise<void>;
        };
        backendInternal.transport = {
            sendRequest: async () => ({ stopReason: 'end_turn' }),
            close: async () => {}
        };

        const turn1: AgentMessage[] = [];
        await backend.prompt('session-1', [{ type: 'text', text: 'hi' }], (m) => turn1.push(m));

        let releaseBlocker!: () => void;
        const blocker = new Promise<void>((resolve) => {
            releaseBlocker = resolve;
        });
        backendInternal.sessionUpdateQueue = backendInternal.sessionUpdateQueue.then(() => blocker);

        await backend.suppressUpdatesDuring(async () => {
            backendInternal.handleSessionUpdate({
                sessionId: 'session-1',
                update: {
                    sessionUpdate: ACP_SESSION_UPDATE_TYPES.plan,
                    entries: [{ content: 'queued-during-suppress', priority: 'medium', status: 'pending' }]
                }
            });
            return 'compact';
        });

        expect(backendInternal.messageHandler).not.toBeNull();
        releaseBlocker();
        await backendInternal.sessionUpdateQueue;
        expect(turn1.some((m) => m.type === 'plan')).toBe(false);
    });

    it('does not let compact thought/text chunks escape through the next prompt pre-swap drain, while preserving the new prompt response', async () => {
        // The reported duplicate was not emitted during /compact itself. In
        // the pre-suppression implementation those chunks stayed in the old
        // handler and prompt()'s next pre-swap drain emitted them as an
        // ordinary assistant reply. This drives that exact backend path.
        backendStatics.UPDATE_QUIET_PERIOD_MS = 1;
        backendStatics.UPDATE_DRAIN_TIMEOUT_MS = 20;
        backendStatics.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS = 1;
        backendStatics.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS = 20;
        backendStatics.LATE_FLUSH_INTERVAL_MS = 1;
        backendStatics.LATE_FLUSH_QUIET_PERIOD_MS = 1;
        backendStatics.LATE_FLUSH_WINDOW_MS = 20;

        const backend = new AcpSdkBackend({ command: 'opencode' });
        const backendInternal = backend as unknown as {
            transport: {
                sendRequest: (method: string, params: unknown, options?: unknown) => Promise<unknown>;
                close: () => Promise<void>;
            } | null;
            handleSessionUpdate: (params: unknown) => void;
            sessionUpdateQueue: Promise<void>;
        };
        let promptRequestCount = 0;
        backendInternal.transport = {
            sendRequest: async (method) => {
                if (method === 'session/prompt') {
                    promptRequestCount += 1;
                    if (promptRequestCount === 2) {
                        backendInternal.handleSessionUpdate({
                            sessionId: 'session-1',
                            update: {
                                sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentThoughtChunk,
                                content: { type: 'text', text: 'new prompt thought' }
                            }
                        });
                        backendInternal.handleSessionUpdate({
                            sessionId: 'session-1',
                            update: {
                                sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
                                content: { type: 'text', text: 'new prompt answer' }
                            }
                        });
                    }
                    return { stopReason: 'end_turn' };
                }
                return null;
            },
            close: async () => {}
        };

        const previousTurn: AgentMessage[] = [];
        await backend.prompt('session-1', [{ type: 'text', text: 'before compact' }], (message) => previousTurn.push(message));

        await backend.suppressUpdatesDuring(async () => {
            backendInternal.handleSessionUpdate({
                sessionId: 'session-1',
                update: {
                    sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentThoughtChunk,
                    content: { type: 'text', text: 'compact-only thought' }
                }
            });
            backendInternal.handleSessionUpdate({
                sessionId: 'session-1',
                update: {
                    sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
                    content: { type: 'text', text: 'compact-only summary' }
                }
            });
        });

        const nextTurn: AgentMessage[] = [];
        await backend.prompt('session-1', [{ type: 'text', text: 'after compact' }], (message) => nextTurn.push(message));

        expect(previousTurn).toEqual([
            { type: 'turn_complete', stopReason: 'end_turn' }
        ]);
        expect(nextTurn).toEqual([
            { type: 'reasoning', text: 'new prompt thought' },
            { type: 'text', text: 'new prompt answer' },
            { type: 'turn_complete', stopReason: 'end_turn' }
        ]);
    });

    it('notifies agent-activity listener for sustained running + idle, not content/usage noise (#1470/#1502)', () => {
        vi.useFakeTimers();
        const backend = new AcpSdkBackend({ command: 'agent' });
        const activity: boolean[] = [];
        backend.setAgentActivityListener((thinking) => {
            activity.push(thinking);
        });

        const backendInternal = backend as unknown as {
            handleSessionUpdate: (params: unknown) => void;
        };

        backendInternal.handleSessionUpdate({
            sessionId: 'session-1',
            update: {
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
                content: { type: 'text', text: 'resumed' }
            }
        });
        backendInternal.handleSessionUpdate({
            sessionId: 'session-1',
            update: {
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCallUpdate,
                toolCallId: 'tc-bg',
                status: 'in_progress'
            }
        });
        backendInternal.handleSessionUpdate({
            sessionId: 'session-1',
            update: { sessionUpdate: 'usage_update', used: 1_000, size: 200_000 }
        });
        backendInternal.handleSessionUpdate({
            sessionId: 'session-1',
            update: {
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.sessionInfoUpdate,
                title: 'noise'
            }
        });
        // Chatter: running then idle before debounce → no true bump (idle may clear)
        backendInternal.handleSessionUpdate({
            sessionId: 'session-1',
            update: { sessionUpdate: 'state_update', state: 'running' }
        });
        vi.advanceTimersByTime(200);
        backendInternal.handleSessionUpdate({
            sessionId: 'session-1',
            update: { sessionUpdate: 'state_update', state: 'idle' }
        });
        expect(activity.filter((v) => v === true)).toEqual([]);

        // Sustained running commits after debounce
        backendInternal.handleSessionUpdate({
            sessionId: 'session-1',
            update: { sessionUpdate: 'state_update', state: 'running' }
        });
        vi.advanceTimersByTime(750);
        expect(activity.filter((v) => v === true)).toEqual([true]);
        backendInternal.handleSessionUpdate({
            sessionId: 'session-1',
            update: { sessionUpdate: 'state_update', state: 'idle' }
        });
        expect(activity.at(-1)).toBe(false);
        vi.useRealTimers();
    });

    it('ignores idle clears while a HAPI prompt turn is still draining', () => {
        const backend = new AcpSdkBackend({ command: 'agent' });
        const activity: boolean[] = [];
        backend.setAgentActivityListener((thinking) => {
            activity.push(thinking);
        });
        const backendInternal = backend as unknown as {
            handleSessionUpdate: (params: unknown) => void;
            isProcessingMessage: boolean;
        };
        backendInternal.isProcessingMessage = true;
        backendInternal.handleSessionUpdate({
            sessionId: 'session-1',
            update: { sessionUpdate: 'state_update', state: 'idle' }
        });
        expect(activity).toEqual([]);
        backendInternal.isProcessingMessage = false;
        backendInternal.handleSessionUpdate({
            sessionId: 'session-1',
            update: { sessionUpdate: 'state_update', state: 'idle' }
        });
        expect(activity).toEqual([false]);
    });

    it('notifies agent-activity listener when a permission request arrives (#1470)', async () => {
        const backend = new AcpSdkBackend({ command: 'agent' });
        const activity: boolean[] = [];
        backend.setAgentActivityListener((thinking) => {
            activity.push(thinking);
        });
        let request: PermissionRequest | null = null;
        backend.onPermissionRequest((received) => {
            // leave pending; we only care that activity fired first
            request = received;
        });

        const backendInternal = backend as unknown as {
            handlePermissionRequest: (params: unknown, requestId: string) => Promise<unknown>;
        };

        const pending = backendInternal.handlePermissionRequest({
            sessionId: 'session-1',
            toolCall: {
                toolCallId: 'tc-1',
                title: 'Shell',
                kind: 'execute',
                status: 'pending'
            },
            options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
        }, 'req-1');

        expect(activity).toEqual([true]);
        // Cancel so the promise does not hang the suite.
        expect(request).not.toBeNull();
        await backend.respondToPermission('session-1', request!, { outcome: 'cancelled' });
        await pending;
    });
});

describe('AcpSdkBackend abortSoftSteers', () => {
    it('drains buffered foreground output before suppressing late updates', async () => {
        const backend = new AcpSdkBackend({ command: 'agent' });
        const updates: AgentMessage[] = [];
        const handler = new AcpMessageHandler((message) => updates.push(message));
        const backendInternal = backend as unknown as {
            messageHandler: AcpMessageHandler | null;
        };

        await handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
            content: { type: 'text', text: 'partial answer' }
        });
        await handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentThoughtChunk,
            content: { type: 'text', text: 'partial thought' }
        });
        backendInternal.messageHandler = handler;

        backend.abortSoftSteers();

        expect(updates).toEqual([
            { type: 'reasoning', text: 'partial thought' },
            { type: 'text', text: 'partial answer' }
        ]);
    });

    it('releases processingMessage without waiting for the concurrent prompt', () => {
        const backend = new AcpSdkBackend({ command: 'agent' });
        const backendInternal = backend as unknown as {
            isProcessingMessage: boolean;
            activePromptRequests: number;
        };
        backendInternal.isProcessingMessage = true;
        backendInternal.activePromptRequests = 2;

        backend.abortSoftSteers();

        expect(backend.processingMessage).toBe(false);
        expect(backendInternal.activePromptRequests).toBe(0);
    });

    it('is a no-op when nothing is in flight', () => {
        const backend = new AcpSdkBackend({ command: 'agent' });
        const backendInternal = backend as unknown as {
            activePromptRequests: number;
        };
        backendInternal.activePromptRequests = 0;

        expect(() => backend.abortSoftSteers()).not.toThrow();
        expect(backend.processingMessage).toBe(false);
    });
});

describe('AcpSdkBackend acpModelSwitchViaConfigOption', () => {
    async function makeBackendWithModelOption(flag: boolean, opts?: { configOptionError?: string }) {
        const backend = new AcpSdkBackend({
            command: 'opencode',
            acpModelSwitchViaConfigOption: flag
        });
        const calls: Array<{ method: string; params: unknown }> = [];
        const backendInternal = backend as unknown as {
            transport: { sendRequest: (method: string, params: unknown) => Promise<unknown>; close: () => Promise<void> } | null;
            sessionConfigOptions: Map<string, Array<{ id: string; category?: string; options: Array<{ value: string }> }>>;
        };
        backendInternal.transport = {
            sendRequest: async (method, params) => {
                calls.push({ method, params });
                if (method === 'session/new') {
                    return {
                        sessionId: 's1',
                        configOptions: [{
                            id: 'model',
                            category: 'model',
                            currentValue: 'ollama/a',
                            options: [{ value: 'ollama/a', name: 'a' }, { value: 'ollama/b', name: 'b' }]
                        }]
                    };
                }
                if (method === 'session/set_config_option') {
                    if (opts?.configOptionError) {
                        throw new Error(opts.configOptionError);
                    }
                    return {
                        configOptions: [{
                            id: 'model',
                            category: 'model',
                            currentValue: 'ollama/b',
                            options: [{ value: 'ollama/a', name: 'a' }, { value: 'ollama/b', name: 'b' }]
                        }]
                    };
                }
                return null;
            },
            close: async () => {}
        };
        await backend.newSession({ cwd: '/tmp/x', mcpServers: [] });
        calls.length = 0;
        return { backend, calls, backendInternal };
    }

    it('uses session/set_config_option with the model option id when the flag is on', async () => {
        const { backend, calls } = await makeBackendWithModelOption(true);
        await backend.setModel('s1', 'ollama/b', { flavor: 'opencode' });
        expect(calls).toEqual([
            { method: 'session/set_config_option', params: { sessionId: 's1', configId: 'model', value: 'ollama/b' } }
        ]);
        expect(backend.getSessionModelsMetadata('s1')?.currentModelId).toBe('ollama/b');
    });

    it('falls back to the legacy set_model path when no model option exists (flag on)', async () => {
        const { backend, calls, backendInternal } = await makeBackendWithModelOption(true, { configOptionError: 'Method not found' });
        backendInternal.sessionConfigOptions.set('s1', [
            { id: 'effort', category: 'thought_level', options: [{ value: 'high' }] }
        ]);
        await backend.setModel('s1', 'ollama/b', { flavor: 'opencode' });
        expect(calls).toEqual([
            { method: 'session/set_config_option', params: { sessionId: 's1', configId: 'model', value: 'ollama/b' } },
            { method: 'session/set_model', params: { sessionId: 's1', modelId: 'ollama/b' } }
        ]);
    });

    it('flag off with a non-opencode flavor sends only session/set_model (shared-backend guarantee)', async () => {
        const backend = new AcpSdkBackend({
            command: 'opencode',
            acpModelSwitchViaConfigOption: false
        });
        const calls: Array<{ method: string; params: unknown }> = [];
        const backendInternal = backend as unknown as {
            transport: { sendRequest: (method: string, params: unknown) => Promise<unknown>; close: () => Promise<void> } | null;
        };
        backendInternal.transport = {
            sendRequest: async (method, params) => {
                calls.push({ method, params });
                if (method === 'session/new') {
                    return { sessionId: 's1', configOptions: [{ id: 'model', category: 'model', currentValue: 'ollama/a', options: [] }] };
                }
                return null;
            },
            close: async () => {}
        };
        await backend.newSession({ cwd: '/tmp/x', mcpServers: [] });
        calls.length = 0;
        // No flavor: neither the v2 shortcut nor the opencode legacy
        // config-option attempt may run.
        await backend.setModel('s1', 'ollama/b');
        expect(calls).toEqual([
            { method: 'session/set_model', params: { sessionId: 's1', modelId: 'ollama/b' } }
        ]);
    });

    it('flag off (opencode flavor) keeps the legacy opencode path, which itself tries set_config_option before set_model', async () => {
        // The pre-existing opencode legacy path already attempts
        // session/set_config_option first and falls back to set_model on
        // "method not found" — identical traffic to the flag-on shortcut.
        // The flag only changes the guard: with it OFF, v2 sessions without
        // a model option go straight to legacy instead of being refused.
        // Shared-backend guarantee (no flavor → set_model only) is pinned by
        // the dedicated test above.
        const { backend, calls } = await makeBackendWithModelOption(false);
        await backend.setModel('s1', 'ollama/b', { flavor: 'opencode' });
        expect(calls).toEqual([
            { method: 'session/set_config_option', params: { sessionId: 's1', configId: 'model', value: 'ollama/b' } }
        ]);
    });
});

describe('AcpSdkBackend OpenCode child session updates', () => {
    type ChildBackendInternal = {
        transport: {
            sendRequest: (...args: unknown[]) => Promise<unknown>;
            /** Real transport returns true when the process tree exited. */
            close: () => Promise<boolean | void>;
        } | null;
        handleNotification: (method: string, params: unknown) => void;
        sessionUpdateQueue: Promise<void>;
    };

    function useFastDrains(): void {
        backendStatics.UPDATE_QUIET_PERIOD_MS = 5;
        backendStatics.UPDATE_DRAIN_TIMEOUT_MS = 50;
        backendStatics.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS = 1;
        backendStatics.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS = 50;
        backendStatics.LATE_FLUSH_INTERVAL_MS = 5;
        backendStatics.LATE_FLUSH_QUIET_PERIOD_MS = 10;
        backendStatics.LATE_FLUSH_WINDOW_MS = 50;
    }

    function childText(childSessionId: string, text: string): { method: string; params: unknown } {
        return {
            method: 'opencode/session/child_update',
            params: {
                rootSessionId: 'session-1',
                childSessionId,
                parentSessionId: 'session-1',
                depth: 1,
                type: 'update',
                update: {
                    sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
                    content: { type: 'text', text },
                    _meta: { 'opencode/child-session': { id: childSessionId, parentID: 'session-1', depth: 1 } }
                }
            }
        };
    }

    function childStatus(childSessionId: string, status: string): { method: string; params: unknown } {
        return {
            method: 'opencode/session/child_update',
            params: {
                rootSessionId: 'session-1',
                childSessionId,
                parentSessionId: 'session-1',
                depth: 1,
                type: 'status',
                status
            }
        };
    }

    function parentText(text: string): { method: string; params: unknown } {
        return {
            method: 'session/update',
            params: {
                sessionId: 'session-1',
                update: {
                    sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
                    content: { type: 'text', text }
                }
            }
        };
    }

    function texts(messages: AgentMessage[]): string[] {
        return messages.flatMap((m) => (m.type === 'text' ? [m.text] : []));
    }

    function makeBackend(childSessionUpdates = true): {
        backend: AcpSdkBackend;
        internal: ChildBackendInternal;
    } {
        const backend = new AcpSdkBackend({ command: 'opencode', childSessionUpdates });
        const internal = backend as unknown as ChildBackendInternal;
        internal.transport = {
            sendRequest: async () => ({ stopReason: 'end_turn' }),
            close: async () => {}
        };
        return { backend, internal };
    }

    function notify(internal: ChildBackendInternal, notification: { method: string; params: unknown }): void {
        internal.handleNotification(notification.method, notification.params);
    }

    it('keeps parent text and child text in separate messages when interleaved (a)', async () => {
        useFastDrains();
        const { backend, internal } = makeBackend();
        internal.transport = {
            sendRequest: async () => {
                notify(internal, parentText('parent part1 '));
                notify(internal, childText('ses_child', 'child says hi'));
                notify(internal, parentText('parent part2'));
                return { stopReason: 'end_turn' };
            },
            close: async () => {}
        };

        const messages: AgentMessage[] = [];
        await backend.prompt('session-1', [{ type: 'text', text: 'hi' }], (m) => messages.push(m));
        await sleep(60);

        const emitted = texts(messages);
        expect(emitted).toContain('parent part1 parent part2');
        expect(emitted).toContain('child says hi');
        expect(emitted.length).toBe(2);
    });

    it('keeps two children interleaved in separate messages (b)', async () => {
        useFastDrains();
        const { backend, internal } = makeBackend();
        internal.transport = {
            sendRequest: async () => {
                notify(internal, childText('ses_child_a', 'child-a part1 '));
                notify(internal, childText('ses_child_b', 'child-b part1 '));
                notify(internal, childText('ses_child_a', 'child-a part2'));
                return { stopReason: 'end_turn' };
            },
            close: async () => {}
        };

        const messages: AgentMessage[] = [];
        await backend.prompt('session-1', [{ type: 'text', text: 'hi' }], (m) => messages.push(m));
        await sleep(60);

        const emitted = texts(messages);
        expect(emitted).toContain('child-a part1 child-a part2');
        expect(emitted).toContain('child-b part1 ');
        expect(emitted.length).toBe(2);
    });

    it('emits a child answer during the compact suppression window (c)', async () => {
        useFastDrains();
        const { backend, internal } = makeBackend();

        const messages: AgentMessage[] = [];
        await backend.prompt('session-1', [{ type: 'text', text: 'start a background task' }], (m) => messages.push(m));

        await backend.suppressUpdatesDuring(async () => {
            notify(internal, childText('ses_child', 'child says hi during compact'));
        });
        await sleep(60);

        expect(texts(messages)).toEqual(['child says hi during compact']);
    });

    it('flushes pending child text on terminal status and starts a fresh buffer after (d)', async () => {
        useFastDrains();
        const { backend, internal } = makeBackend();

        const messages: AgentMessage[] = [];
        await backend.prompt('session-1', [{ type: 'text', text: 'hi' }], (m) => messages.push(m));

        backendStatics.LATE_FLUSH_QUIET_PERIOD_MS = 500;
        notify(internal, childText('ses_child', 'child says hi'));
        notify(internal, childStatus('ses_child', 'completed'));
        await sleep(30);
        expect(texts(messages)).toEqual(['child says hi']);

        notify(internal, childText('ses_child', 'a fresh answer'));
        await sleep(700);
        expect(texts(messages)).toEqual(['child says hi', 'a fresh answer']);
    });

    it('emits a background child answer that arrives after the parent turn ended (e)', async () => {
        useFastDrains();
        const { backend, internal } = makeBackend();

        const messages: AgentMessage[] = [];
        await backend.prompt('session-1', [{ type: 'text', text: 'start a background task' }], (m) => messages.push(m));
        expect(messages.some((m) => m.type === 'turn_complete')).toBe(true);

        notify(internal, childText('ses_child', 'RESULT=391'));
        await sleep(60);

        expect(texts(messages)).toEqual(['RESULT=391']);
        const answerIdx = messages.findIndex((m) => m.type === 'text' && m.text === 'RESULT=391');
        const turnCompleteIdx = messages.findIndex((m) => m.type === 'turn_complete');
        expect(answerIdx).toBeGreaterThan(turnCompleteIdx);
    });

    it('keeps the existing child output handler through a compact prompt', async () => {
        useFastDrains();
        const { backend, internal } = makeBackend();
        const messages: AgentMessage[] = [];
        await backend.prompt('session-1', [{ type: 'text', text: 'start a background task' }], (message) => messages.push(message));
        await backend.prompt('session-1', [{ type: 'text', text: '/compact' }], () => {}, { preserveChildUpdates: true });
        notify(internal, childText('ses_child', 'background result'));
        notify(internal, childStatus('ses_child', 'completed'));
        await vi.waitFor(() => expect(texts(messages)).toEqual(['background result']));
    });

    it('flushes pending child text on disconnect (f)', async () => {
        useFastDrains();
        const { backend, internal } = makeBackend();

        const messages: AgentMessage[] = [];
        await backend.prompt('session-1', [{ type: 'text', text: 'hi' }], (m) => messages.push(m));

        notify(internal, childText('ses_child', 'pending bye'));
        await backend.disconnect();

        expect(texts(messages)).toEqual(['pending bye']);
    });

    it('interrupts children first reported during verified close (#2021)', async () => {
        useFastDrains();
        const { backend, internal } = makeBackend();
        internal.transport = {
            sendRequest: async () => ({ stopReason: 'end_turn' }),
            close: async () => {
                // Buffered stdout can report a child while awaiting process-tree exit.
                notify(internal, childStatus('ses_late', 'running'));
                return true;
            },
        };

        const messages: AgentMessage[] = [];
        await backend.prompt('session-1', [{ type: 'text', text: 'hi' }], (m) => messages.push(m));
        await backend.disconnect();

        expect(messages).toContainEqual(expect.objectContaining({
            type: 'turn_complete',
            childSessionId: 'ses_late',
            childStatus: 'interrupted',
            stopReason: 'cancelled',
        }));
    });

    it('drains a queued child running status across close before interrupt (#2021)', async () => {
        useFastDrains();
        const { backend, internal } = makeBackend();
        let releaseQueue!: () => void;
        const hold = new Promise<void>((resolve) => { releaseQueue = resolve; });
        internal.transport = {
            sendRequest: async () => ({ stopReason: 'end_turn' }),
            close: async () => {
                // Async work already on the queue (e.g. image registration);
                // a close-time running status chains behind it. Interrupt must
                // await that drain so running cannot land after interrupted.
                internal.sessionUpdateQueue = internal.sessionUpdateQueue.then(() => hold);
                notify(internal, childStatus('ses_queued', 'running'));
                return true;
            },
        };

        const messages: AgentMessage[] = [];
        await backend.prompt('session-1', [{ type: 'text', text: 'hi' }], (m) => messages.push(m));
        const disconnected = backend.disconnect();
        await sleep(20);
        releaseQueue();
        await disconnected;

        const childStatuses = messages.filter(
            (m) => m.type === 'turn_complete' && m.childSessionId === 'ses_queued'
        );
        expect(childStatuses.at(-1)).toMatchObject({
            type: 'turn_complete',
            childSessionId: 'ses_queued',
            childStatus: 'interrupted',
            stopReason: 'cancelled',
        });
    });

    it('interrupts children that only sent tool updates before verified close (#2021)', async () => {
        useFastDrains();
        const { backend, internal } = makeBackend();
        internal.transport = {
            sendRequest: async () => ({ stopReason: 'end_turn' }),
            close: async () => true,
        };

        const messages: AgentMessage[] = [];
        await backend.prompt('session-1', [{ type: 'text', text: 'hi' }], (m) => messages.push(m));
        // Tool update without a preceding created/running status — still live work.
        notify(internal, {
            method: 'opencode/session/child_update',
            params: {
                rootSessionId: 'session-1',
                childSessionId: 'ses_tool_only',
                parentSessionId: 'session-1',
                depth: 1,
                type: 'update',
                update: {
                    sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
                    toolCallId: 'ses_tool_only:shell:0',
                    title: 'shell',
                    kind: 'execute',
                    status: 'in_progress',
                    rawInput: { command: 'sleep 5' },
                },
            },
        });
        await sleep(20);
        await backend.disconnect();

        expect(messages).toContainEqual(expect.objectContaining({
            type: 'turn_complete',
            childSessionId: 'ses_tool_only',
            childStatus: 'interrupted',
            stopReason: 'cancelled',
        }));
    });

    it('ignores child updates when the capability is not enabled (g)', async () => {
        useFastDrains();
        const { backend, internal } = makeBackend(false);

        const messages: AgentMessage[] = [];
        await backend.prompt('session-1', [{ type: 'text', text: 'hi' }], (m) => messages.push(m));
        notify(internal, childText('ses_child', 'child says hi'));
        await sleep(60);

        expect(texts(messages)).toEqual([]);
    });

    it('does not delay the parent prompt completion while child updates keep arriving (h)', async () => {
        useFastDrains();
        const { backend, internal } = makeBackend();
        internal.transport = {
            sendRequest: async () => {
                void (async () => {
                    for (let i = 0; i < 20; i++) {
                        await sleep(3);
                        notify(internal, childText('ses_child', `tick ${i} `));
                    }
                })();
                return { stopReason: 'end_turn' };
            },
            close: async () => {}
        };

        const messages: AgentMessage[] = [];
        const start = Date.now();
        await backend.prompt('session-1', [{ type: 'text', text: 'hi' }], (m) => messages.push(m));
        const elapsed = Date.now() - start;

        expect(elapsed).toBeLessThan(40);
        expect(messages.some((m) => m.type === 'turn_complete')).toBe(true);
    });

    it('ignores child status created/running events', async () => {
        useFastDrains();
        const { backend, internal } = makeBackend();

        const messages: AgentMessage[] = [];
        await backend.prompt('session-1', [{ type: 'text', text: 'hi' }], (m) => messages.push(m));

        notify(internal, childStatus('ses_child', 'created'));
        notify(internal, childStatus('ses_child', 'running'));
        await sleep(60);

        expect(messages.filter((m) => m.type !== 'turn_complete')).toEqual([]);
    });

    it('ignores child updates for a foreign root session', async () => {
        useFastDrains();
        const { backend, internal } = makeBackend();

        const messages: AgentMessage[] = [];
        await backend.prompt('session-1', [{ type: 'text', text: 'hi' }], (m) => messages.push(m));

        notify(internal, {
            method: 'opencode/session/child_update',
            params: {
                ...(childText('ses_child', 'foreign') as { params: Record<string, unknown> }).params,
                rootSessionId: 'other-session'
            }
        });
        await sleep(60);

        expect(texts(messages)).toEqual([]);
    });
});

describe('AcpSdkBackend config_option_update', () => {
    it('refreshes cached thought_level only when the flavor opts in', () => {
        const update = {
            sessionId: 's1',
            update: {
                sessionUpdate: 'config_option_update',
                configOptions: [{ id: 'effort', category: 'thought_level', currentValue: 'low', options: [{ value: 'low', name: 'low' }] }]
            }
        };
        for (const configOptionUpdates of [true, false]) {
            const backend = new AcpSdkBackend({ command: 'acp-agent', configOptionUpdates });
            (backend as unknown as { handleNotification: (m: string, p: unknown) => void }).handleNotification('session/update', update);
            expect(backend.getThoughtLevelConfigOption('s1')?.currentValue).toBe(configOptionUpdates ? 'low' : undefined);
        }
    });
});

describe('AcpSdkBackend num_turns extraction (google-antigravity/antigravity-cli#1045)', () => {
    const backend = new AcpSdkBackend({ command: 'agy', args: ['acp'] });

    it('prefers usage.num_turns over the response top level and _meta', () => {
        expect(backend.extractNumTurns({ stopReason: 'end_turn', usage: { num_turns: 7 } })).toBe(7);
        expect(backend.extractNumTurns({ stopReason: 'end_turn', usage: { numTurns: 3 }, _meta: { num_turns: 9 } })).toBe(3);
        expect(backend.extractNumTurns({ stopReason: 'end_turn', num_turns: 4 })).toBe(4);
        expect(backend.extractNumTurns({ stopReason: 'end_turn', _meta: { numTurns: 5 } })).toBe(5);
    });

    it('ignores non-positive, garbage, and missing values', () => {
        expect(backend.extractNumTurns({ stopReason: 'end_turn', usage: {} })).toBeUndefined();
        expect(backend.extractNumTurns({ stopReason: 'end_turn', usage: { num_turns: 0 } })).toBeUndefined();
        expect(backend.extractNumTurns({ stopReason: 'end_turn', usage: { num_turns: 'many' } })).toBeUndefined();
        expect(backend.extractNumTurns({})).toBeUndefined();
        expect(backend.extractNumTurns(null)).toBeUndefined();
    });

    it('rounds fractional numbers instead of dropping them', () => {
        expect(backend.extractNumTurns({ usage: { num_turns: 2.9 } })).toBe(3);
    });
});

describe('AcpSdkBackend agentInfo.version and flushPendingMessageBuffers', () => {
    it('captures agentInfo.version from initialize and flushes pending message buffers on demand', async () => {
        const backend = new AcpSdkBackend({
            command: 'agy',
            args: ['acp'],
            flavor: 'agy',
            textChunkMode: 'delta',
            toolCallLifetimeStore: null
        });
        let deliver: (method: string, params: unknown) => void = () => {};
        const ctor = AcpSdkBackend as unknown as Record<string, number>;
        const savedTimings = {
            UPDATE_QUIET_PERIOD_MS: ctor.UPDATE_QUIET_PERIOD_MS,
            UPDATE_DRAIN_TIMEOUT_MS: ctor.UPDATE_DRAIN_TIMEOUT_MS,
            PRE_PROMPT_UPDATE_QUIET_PERIOD_MS: ctor.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS,
            PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS: ctor.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS,
            LATE_FLUSH_INTERVAL_MS: ctor.LATE_FLUSH_INTERVAL_MS,
            LATE_FLUSH_QUIET_PERIOD_MS: ctor.LATE_FLUSH_QUIET_PERIOD_MS,
            LATE_FLUSH_WINDOW_MS: ctor.LATE_FLUSH_WINDOW_MS
        };
        ctor.UPDATE_QUIET_PERIOD_MS = 10;
        ctor.UPDATE_DRAIN_TIMEOUT_MS = 40;
        ctor.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS = 10;
        ctor.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS = 40;
        ctor.LATE_FLUSH_INTERVAL_MS = 10;
        ctor.LATE_FLUSH_QUIET_PERIOD_MS = 20;
        ctor.LATE_FLUSH_WINDOW_MS = 60;

        const createSpy = vi.spyOn(AcpStdioTransport, 'create').mockImplementation(async () => ({
            sendRequest: vi.fn(async (method: string) => {
                if (method === 'initialize') {
                    return {
                        protocolVersion: 1,
                        agentInfo: { name: 'Antigravity ACP Server', version: '1.5.13' },
                        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } }
                    };
                }
                if (method === 'session/prompt') {
                    deliver('session/update', {
                        sessionId: 's1',
                        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'STARTED' } }
                    });
                    return { stopReason: 'end_turn' };
                }
                return {};
            }),
            sendNotification: vi.fn(),
            onNotification: (cb: (method: string, params: unknown) => void) => {
                deliver = cb;
            },
            onStderrError: () => {},
            registerRequestHandler: () => {},
            isAlive: () => true,
            getProcessPid: () => 1234,
            close: async () => true
        } as unknown as AcpStdioTransport));

        try {
            await backend.initialize();
            expect(backend.getAgentVersion()).toBe('1.5.13');
            expect(backend.hasMessageHandler()).toBe(false);

            const turn1Updates: AgentMessage[] = [];
            await backend.prompt('s1', [{ type: 'text', text: 'start' }], (msg) => turn1Updates.push(msg));
            expect(backend.hasMessageHandler()).toBe(true);
            expect(turn1Updates.filter((m) => m.type === 'text')).toEqual([{ type: 'text', text: 'STARTED' }]);

            // Stream idle wakeup chunks without waiting for the 1000ms idle timer, then flush on demand.
            deliver('session/update', {
                sessionId: 's1',
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'FINISHED:' } }
            });
            deliver('session/update', {
                sessionId: 's1',
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'DONE_BG' } }
            });
            await backend.flushPendingMessageBuffers();

            const finalized = turn1Updates.filter((m): m is Extract<AgentMessage, { type: 'text' }> => m.type === 'text' && !m.live);
            expect(finalized.map((m) => m.text)).toEqual(['STARTED', 'FINISHED:DONE_BG']);

            // Turn 2's pre-swap drain has nothing left to leak.
            const countBeforeTurn2 = turn1Updates.length;
            const turn2Updates: AgentMessage[] = [];
            await backend.prompt('s1', [{ type: 'text', text: 'next' }], (msg) => turn2Updates.push(msg));
            expect(turn1Updates).toHaveLength(countBeforeTurn2);
        } finally {
            createSpy.mockRestore();
            Object.assign(ctor, savedTimings);
        }
    });

    describe('prompt beforeHandlerSwap', () => {
        async function setup() {
            const backend = new AcpSdkBackend({ command: 'agy', args: ['acp'], flavor: 'agy', textChunkMode: 'delta', toolCallLifetimeStore: null });
            let deliver: (method: string, params: unknown) => void = () => {};
            const chunk = (text: string) => deliver('session/update', {
                sessionId: 's1',
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
            });
            const prompts: string[] = [];
            const ctor = AcpSdkBackend as unknown as Record<string, number>;
            const saved = { ...ctor };
            Object.assign(ctor, {
                UPDATE_QUIET_PERIOD_MS: 10, UPDATE_DRAIN_TIMEOUT_MS: 40,
                PRE_PROMPT_UPDATE_QUIET_PERIOD_MS: 10, PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS: 40,
                LATE_FLUSH_INTERVAL_MS: 10, LATE_FLUSH_QUIET_PERIOD_MS: 20, LATE_FLUSH_WINDOW_MS: 60
            });
            const createSpy = vi.spyOn(AcpStdioTransport, 'create').mockImplementation(async () => ({
                sendRequest: vi.fn(async (method: string) => {
                    if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
                    if (method === 'session/prompt') {
                        prompts.push('prompt');
                        chunk(`reply-${prompts.length}`);
                        return { stopReason: 'end_turn' };
                    }
                    return {};
                }),
                sendNotification: vi.fn(),
                onNotification: (cb: (method: string, params: unknown) => void) => { deliver = cb; },
                onStderrError: () => {}, registerRequestHandler: () => {},
                isAlive: () => true, getProcessPid: () => 1234, close: async () => true
            } as unknown as AcpStdioTransport));
            await backend.initialize();
            const turn1: AgentMessage[] = [];
            await backend.prompt('s1', [{ type: 'text', text: 'one' }], (m) => turn1.push(m));
            const texts = (updates: AgentMessage[]) => updates.filter((m) => m.type === 'text' && !m.live).map((m) => (m as { text: string }).text);
            return { backend, chunk, prompts, turn1, texts, restore: () => { createSpy.mockRestore(); Object.assign(ctor, saved); } };
        }

        it('runs after the pre-prompt drain and before the new handler and the prompt request', async () => {
            const t = await setup();
            try {
                t.chunk('late');
                const seen: { drained: string[]; prompts: number } = { drained: [], prompts: -1 };
                const turn2: AgentMessage[] = [];
                await t.backend.prompt('s1', [{ type: 'text', text: 'two' }], (m) => turn2.push(m), {
                    beforeHandlerSwap: async () => { seen.drained = t.texts(t.turn1); seen.prompts = t.prompts.length; }
                });
                expect(seen.drained).toEqual(['reply-1', 'late']);
                expect(seen.prompts).toBe(1);
                expect(t.texts(turn2)).toEqual(['reply-2']);
            } finally { t.restore(); }
        });

        it('leaves the old handler and prompt bookkeeping intact when the hook throws', async () => {
            const t = await setup();
            try {
                await expect(t.backend.prompt('s1', [{ type: 'text', text: 'two' }], () => {}, {
                    beforeHandlerSwap: async () => { throw new Error('hook failed'); }
                })).rejects.toThrow('hook failed');
                expect(t.prompts).toHaveLength(1);
                t.chunk('still old');
                await t.backend.flushPendingMessageBuffers();
                expect(t.texts(t.turn1)).toEqual(['reply-1', 'still old']);
                const turn3: AgentMessage[] = [];
                await t.backend.prompt('s1', [{ type: 'text', text: 'three' }], (m) => turn3.push(m));
                expect(t.texts(turn3)).toEqual(['reply-2']);
            } finally { t.restore(); }
        });

        it('behaves as before when the hook is omitted', async () => {
            const t = await setup();
            try {
                const turn2: AgentMessage[] = [];
                await t.backend.prompt('s1', [{ type: 'text', text: 'two' }], (m) => turn2.push(m));
                expect(t.texts(turn2)).toEqual(['reply-2']);
                expect(t.prompts).toHaveLength(2);
            } finally { t.restore(); }
        });
    });

    it('does not publish child interruption when a pre-close tree member survives close (#2021)', async () => {
        const processUtils = await import('@/utils/process');
        const snap = vi.spyOn(processUtils, 'snapshotProcessTreeIdentities').mockReturnValue([{
            pid: 4242,
            startMarker: 'gen-a',
            bootId: 'boot',
            tgid: 4242,
            pgid: 4242,
        }]);
        const alive = vi.spyOn(processUtils, 'retainedIdentityStillAlive').mockReturnValue(true);
        const verifyGroup = vi.spyOn(processUtils, 'verifyAgentOwnedProcessGroupExited').mockResolvedValue(true);

        const childEmits: AgentMessage[] = [];
        const backend = new AcpSdkBackend({
            command: 'opencode',
            args: ['acp'],
            flavor: 'opencode',
            textChunkMode: 'delta',
            toolCallLifetimeStore: null,
        });
        const createSpy = vi.spyOn(AcpStdioTransport, 'create').mockImplementation(async () => ({
            sendRequest: vi.fn(async (method: string) => {
                if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
                return {};
            }),
            sendNotification: vi.fn(),
            onNotification: vi.fn(),
            onStderrError: () => {},
            registerRequestHandler: () => {},
            isAlive: () => true,
            getProcessPid: () => 4242,
            close: async () => true,
        } as unknown as AcpStdioTransport));

        try {
            await backend.initialize();
            (backend as unknown as { childEmitSink: (msg: AgentMessage) => void }).childEmitSink = (msg) => {
                childEmits.push(msg);
            };
            (backend as unknown as { knownChildSessionIds: Set<string> }).knownChildSessionIds.add('child-1');
            (backend as unknown as { activeSessionId: string }).activeSessionId = 's1';

            await backend.disconnect();

            expect(snap).toHaveBeenCalledWith(4242);
            expect(alive).toHaveBeenCalled();
            expect(backend.wasAgentTreeEnded()).toBe(false);
            expect(childEmits.filter((m) => m.type === 'turn_complete')).toEqual([]);

            // Later verification publishes the deferred child interruption.
            alive.mockReturnValue(false);
            expect(await backend.verifyRetainedAgentExit(true)).toBe(true);
            expect(verifyGroup).toHaveBeenCalled();
            expect(backend.wasAgentTreeEnded()).toBe(true);
            expect(childEmits.some((m) =>
                m.type === 'turn_complete'
                && (m as { childSessionId?: string }).childSessionId === 'child-1'
                && (m as { childStatus?: string }).childStatus === 'interrupted'
            )).toBe(true);
        } finally {
            createSpy.mockRestore();
            snap.mockRestore();
            alive.mockRestore();
            verifyGroup.mockRestore();
        }
    });

    it('re-verifies Windows ACP trees instead of trusting PID absence alone (#2021)', async () => {
        const processUtils = await import('@/utils/process');
        const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
        const markerSpy = vi.spyOn(processUtils, 'getProcessStartMarker').mockReturnValue('gen-win');
        const tree = [{
            pid: 4242,
            startMarker: 'gen-win',
            bootId: null,
            tgid: null,
            pgid: null,
        }];
        const snap = vi.spyOn(processUtils, 'snapshotProcessTreeIdentities').mockReturnValue(tree);
        const alive = vi.spyOn(processUtils, 'retainedIdentityStillAlive').mockReturnValue(false);
        // Root still matches at pre-close so refresh can capture teardown coverage.
        const classify = vi.spyOn(processUtils, 'classifyRetainedIdentity').mockReturnValue('match');
        const expandKill = vi.spyOn(processUtils, 'killAndExpandWindowsRetainedTree').mockResolvedValue({
            verified: true,
            tree,
        });
        const verifyGroup = vi.spyOn(processUtils, 'verifyAgentOwnedProcessGroupExited');

        const backend = new AcpSdkBackend({
            command: 'opencode',
            args: ['acp'],
            flavor: 'opencode',
            textChunkMode: 'delta',
            toolCallLifetimeStore: null,
        });
        const createSpy = vi.spyOn(AcpStdioTransport, 'create').mockImplementation(async () => ({
            sendRequest: vi.fn(async (method: string) => {
                if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
                return {};
            }),
            sendNotification: vi.fn(),
            onNotification: vi.fn(),
            onStderrError: () => {},
            registerRequestHandler: () => {},
            isAlive: () => false,
            getProcessPid: () => 4242,
            close: async () => true,
        } as unknown as AcpStdioTransport));

        try {
            await backend.initialize();
            await backend.disconnect();
            expect(backend.wasAgentTreeEnded()).toBe(true);
            expect(expandKill).toHaveBeenCalled();
            expect(verifyGroup).not.toHaveBeenCalled();
        } finally {
            createSpy.mockRestore();
            snap.mockRestore();
            alive.mockRestore();
            classify.mockRestore();
            expandKill.mockRestore();
            verifyGroup.mockRestore();
            markerSpy.mockRestore();
            Object.defineProperty(process, 'platform', platform);
        }
    });

    it('refuses Windows ACP settlement when pre-close root already exited (#2021)', async () => {
        const processUtils = await import('@/utils/process');
        const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
        const markerSpy = vi.spyOn(processUtils, 'getProcessStartMarker').mockReturnValue('gen-win');
        const tree = [{
            pid: 4242,
            startMarker: 'gen-win',
            bootId: null,
            tgid: null,
            pgid: null,
        }];
        const snap = vi.spyOn(processUtils, 'snapshotProcessTreeIdentities').mockReturnValue(tree);
        // One retained member still looks alive so incomplete verify attempts cleanup.
        const alive = vi.spyOn(processUtils, 'retainedIdentityStillAlive').mockReturnValue(true);
        const classify = vi.spyOn(processUtils, 'classifyRetainedIdentity').mockReturnValue('gone');
        const expandKill = vi.spyOn(processUtils, 'killAndExpandWindowsRetainedTree').mockResolvedValue({
            verified: false,
            tree,
        });

        const backend = new AcpSdkBackend({
            command: 'opencode',
            args: ['acp'],
            flavor: 'opencode',
            textChunkMode: 'delta',
            toolCallLifetimeStore: null,
        });
        const createSpy = vi.spyOn(AcpStdioTransport, 'create').mockImplementation(async () => ({
            sendRequest: vi.fn(async (method: string) => {
                if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
                return {};
            }),
            sendNotification: vi.fn(),
            onNotification: vi.fn(),
            onStderrError: () => {},
            registerRequestHandler: () => {},
            isAlive: () => false,
            getProcessPid: () => 4242,
            close: async () => true,
        } as unknown as AcpStdioTransport));

        try {
            await backend.initialize();
            await backend.disconnect();
            // Spawn-only evidence after root exit is incomplete — do not settle.
            expect(backend.wasAgentTreeEnded()).toBe(false);
            expect(await backend.verifyRetainedAgentExit(true)).toBe(false);
            expect(expandKill).toHaveBeenCalled();
        } finally {
            createSpy.mockRestore();
            snap.mockRestore();
            alive.mockRestore();
            classify.mockRestore();
            expandKill.mockRestore();
            markerSpy.mockRestore();
            Object.defineProperty(process, 'platform', platform);
        }
    });

    it('keeps ACP exit unverified when a known-PID pre-close snapshot fails (#2021)', async () => {
        const processUtils = await import('@/utils/process');
        const snap = vi.spyOn(processUtils, 'snapshotProcessTreeIdentities').mockReturnValue(null);

        const backend = new AcpSdkBackend({
            command: 'opencode',
            args: ['acp'],
            flavor: 'opencode',
            textChunkMode: 'delta',
            toolCallLifetimeStore: null,
        });
        const createSpy = vi.spyOn(AcpStdioTransport, 'create').mockImplementation(async () => ({
            sendRequest: vi.fn(async (method: string) => {
                if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
                return {};
            }),
            sendNotification: vi.fn(),
            onNotification: vi.fn(),
            onStderrError: () => {},
            registerRequestHandler: () => {},
            isAlive: () => true,
            getProcessPid: () => 4242,
            close: async () => true,
        } as unknown as AcpStdioTransport));

        try {
            await backend.initialize();
            await backend.disconnect();
            expect(snap).toHaveBeenCalledWith(4242);
            expect(backend.wasAgentTreeEnded()).toBe(false);
            expect(await backend.verifyRetainedAgentExit(true)).toBe(false);
        } finally {
            createSpy.mockRestore();
            snap.mockRestore();
        }
    });

    it('merges previously retained ACP descendants omitted from a pre-close scan (#2021)', async () => {
        const processUtils = await import('@/utils/process');
        const spawnTree = [
            {
                pid: 9001,
                startMarker: 'gen-child',
                bootId: 'boot',
                tgid: 9001,
                pgid: 4242,
            },
            {
                pid: 4242,
                startMarker: 'gen-root',
                bootId: 'boot',
                tgid: 4242,
                pgid: 4242,
            },
        ];
        const refreshTree = [{
            pid: 4242,
            startMarker: 'gen-root',
            bootId: 'boot',
            tgid: 4242,
            pgid: 4242,
        }];
        const snap = vi.spyOn(processUtils, 'snapshotProcessTreeIdentities')
            .mockReturnValueOnce(spawnTree)
            .mockReturnValue(refreshTree);
        const alive = vi.spyOn(processUtils, 'retainedIdentityStillAlive')
            .mockImplementation((identity) => identity.pid === 9001);
        const classify = vi.spyOn(processUtils, 'classifyRetainedIdentity').mockReturnValue('match');
        const killRetained = vi.spyOn(processUtils, 'killRetainedProcessTree').mockResolvedValue(false);

        const backend = new AcpSdkBackend({
            command: 'opencode',
            args: ['acp'],
            flavor: 'opencode',
            textChunkMode: 'delta',
            toolCallLifetimeStore: null,
        });
        const createSpy = vi.spyOn(AcpStdioTransport, 'create').mockImplementation(async () => ({
            sendRequest: vi.fn(async (method: string) => {
                if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
                return {};
            }),
            sendNotification: vi.fn(),
            onNotification: vi.fn(),
            onStderrError: () => {},
            registerRequestHandler: () => {},
            isAlive: () => true,
            getProcessPid: () => 4242,
            close: async () => true,
        } as unknown as AcpStdioTransport));

        try {
            await backend.initialize();
            await backend.disconnect();
            expect(backend.wasAgentTreeEnded()).toBe(false);
            expect(killRetained).not.toHaveBeenCalled();
            // Surviving omitted descendant keeps exit unverified on retry.
            alive.mockReturnValue(true);
            expect(await backend.verifyRetainedAgentExit(true)).toBe(false);
            const retained = (backend as unknown as { retainedAgentTree: Array<{ pid: number }> }).retainedAgentTree;
            expect(retained?.some((identity) => identity.pid === 9001)).toBe(true);
            expect(retained?.[retained.length - 1]?.pid).toBe(4242);
        } finally {
            createSpy.mockRestore();
            snap.mockRestore();
            alive.mockRestore();
            classify.mockRestore();
            killRetained.mockRestore();
        }
    });

    it('keeps Windows incomplete ACP teardown pending after expand cleanup (#2021)', async () => {
        const processUtils = await import('@/utils/process');
        const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
        const spawnTree = [{
            pid: 4242,
            startMarker: 'gen-win',
            bootId: null,
            tgid: null,
            pgid: null,
        }];
        // Incomplete launch-only snapshot can miss later tool children — expand
        // may clean known seeds but must not authorize settlement (#2021 Major).
        const snap = vi.spyOn(processUtils, 'snapshotProcessTreeIdentities')
            .mockReturnValueOnce(spawnTree)
            .mockReturnValue(null);
        const alive = vi.spyOn(processUtils, 'retainedIdentityStillAlive').mockReturnValue(false);
        const classify = vi.spyOn(processUtils, 'classifyRetainedIdentity').mockReturnValue('match');
        const expandKill = vi.spyOn(processUtils, 'killAndExpandWindowsRetainedTree')
            .mockResolvedValue({ verified: false, tree: spawnTree });

        const backend = new AcpSdkBackend({
            command: 'opencode',
            args: ['acp'],
            flavor: 'opencode',
            textChunkMode: 'delta',
            toolCallLifetimeStore: null,
        });
        const createSpy = vi.spyOn(AcpStdioTransport, 'create').mockImplementation(async () => ({
            sendRequest: vi.fn(async (method: string) => {
                if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
                return {};
            }),
            sendNotification: vi.fn(),
            onNotification: vi.fn(),
            onStderrError: () => {},
            registerRequestHandler: () => {},
            isAlive: () => true,
            getProcessPid: () => 4242,
            close: async () => true,
        } as unknown as AcpStdioTransport));

        try {
            await backend.initialize();
            classify.mockReturnValue('match');
            await backend.disconnect();
            expect(backend.wasAgentTreeEnded()).toBe(false);
            expect(await backend.verifyRetainedAgentExit(true)).toBe(false);
            expect(expandKill).toHaveBeenCalledWith(
                expect.any(Array),
                true,
                expect.objectContaining({ incomplete: true }),
            );
        } finally {
            createSpy.mockRestore();
            snap.mockRestore();
            alive.mockRestore();
            classify.mockRestore();
            expandKill.mockRestore();
            Object.defineProperty(process, 'platform', platform);
        }
    });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@/agent/types';
import { AcpSdkBackend } from './AcpSdkBackend';
import { buildAcpStdioSpawnOptions } from './AcpStdioTransport';
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
    BETWEEN_TURN_DRAIN_DEBOUNCE_MS: number;
};

const backendStatics = AcpSdkBackend as unknown as BackendStatics;
const originalStatics = {
    updateQuietPeriodMs: backendStatics.UPDATE_QUIET_PERIOD_MS,
    updateDrainTimeoutMs: backendStatics.UPDATE_DRAIN_TIMEOUT_MS,
    prePromptUpdateQuietPeriodMs: backendStatics.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS,
    prePromptUpdateDrainTimeoutMs: backendStatics.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS,
    lateFlushIntervalMs: backendStatics.LATE_FLUSH_INTERVAL_MS,
    lateFlushQuietPeriodMs: backendStatics.LATE_FLUSH_QUIET_PERIOD_MS,
    lateFlushWindowMs: backendStatics.LATE_FLUSH_WINDOW_MS,
    betweenTurnDrainDebounceMs: backendStatics.BETWEEN_TURN_DRAIN_DEBOUNCE_MS
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
    backendStatics.BETWEEN_TURN_DRAIN_DEBOUNCE_MS = originalStatics.betweenTurnDrainDebounceMs;
    if (originalPlatformDescriptor) {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
});

describe('AcpSdkBackend', () => {
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

    it('hides the ACP stdio shell on Windows', () => {
        setPlatform('win32');

        expect(buildAcpStdioSpawnOptions({ TEST_ENV: '1' })).toMatchObject({
            env: { TEST_ENV: '1' },
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: true,
            windowsHide: true
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

        expect(capturedRequestId).toBe('tool-approve');
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

    it('uses session/set_model when flavor is opencode', async () => {
        const backend = new AcpSdkBackend({ command: 'opencode' });
        const calls: Array<{ method: string; params: unknown }> = [];
        const backendInternal = backend as unknown as {
            transport: { sendRequest: (method: string, params: unknown) => Promise<unknown>; close: () => Promise<void> } | null;
        };
        backendInternal.transport = {
            sendRequest: async (method, params) => {
                calls.push({ method, params });
                // OpenCode 1.14.30's set_model response: only an opaque _meta block.
                return {
                    _meta: { opencode: { modelId: 'ollama/exaone:4.5-33b-q8', variant: null, availableVariants: [] } }
                };
            },
            close: async () => {}
        };

        await backend.setModel('session-1', 'ollama/exaone:4.5-33b-q8', { flavor: 'opencode' });

        expect(calls).toEqual([
            {
                method: 'session/set_model',
                params: {
                    sessionId: 'session-1',
                    modelId: 'ollama/exaone:4.5-33b-q8'
                }
            }
        ]);
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
                            availableCommands: [{ name: 'auto' }],
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

    it('optimistically updates currentModelId after a successful opencode setModel call', async () => {
        const backend = new AcpSdkBackend({ command: 'opencode' });
        const backendInternal = backend as unknown as {
            transport: { sendRequest: (method: string, params: unknown) => Promise<unknown>; close: () => Promise<void> } | null;
        };
        const fixtureModels = [
            { modelId: 'ollama/a', name: 'a' },
            { modelId: 'ollama/b', name: 'b' }
        ];
        backendInternal.transport = {
            sendRequest: async (method) => {
                if (method === 'session/new') {
                    return {
                        sessionId: 's1',
                        models: { availableModels: fixtureModels, currentModelId: 'ollama/a' }
                    };
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
        await backend.setModel('s1', 'ollama/b', { flavor: 'opencode' });

        // availableModels list is preserved from session/new; currentModelId is
        // optimistically updated from the requested modelId.
        expect(backend.getSessionModelsMetadata('s1')).toEqual({
            availableModels: fixtureModels,
            currentModelId: 'ollama/b'
        });
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

    it('emits between-turn straggler chunks via the previous turn\'s onUpdate without waiting for the next prompt', async () => {
        // Regression for the "reply only appears after the next message" bug:
        // a slow-tailing model (DeepSeek V4 Flash) streams a long CoT then
        // pauses longer than LATE_FLUSH_QUIET_PERIOD_MS before the answer
        // text, so drainLateBuffers gives up while the final chunks are still
        // to come. They land in the previous turn's handler with no prompt
        // active — and previously sat there until the NEXT prompt()'s
        // pre-swap drain pushed them to the hub, so the web only showed the
        // reply after the user sent another message (positioned after it).
        // Between-turn stragglers must be flushed by the backend itself.
        backendStatics.UPDATE_QUIET_PERIOD_MS = 5;
        backendStatics.UPDATE_DRAIN_TIMEOUT_MS = 50;
        backendStatics.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS = 1;
        backendStatics.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS = 50;
        backendStatics.LATE_FLUSH_INTERVAL_MS = 5;
        backendStatics.LATE_FLUSH_QUIET_PERIOD_MS = 10;
        backendStatics.LATE_FLUSH_WINDOW_MS = 30;
        backendStatics.BETWEEN_TURN_DRAIN_DEBOUNCE_MS = 5;

        const backend = new AcpSdkBackend({ command: 'opencode' });
        const backendInternal = backend as unknown as {
            transport: {
                sendRequest: (...args: unknown[]) => Promise<unknown>;
                close: () => Promise<void>;
            } | null;
            handleSessionUpdate: (params: unknown) => void;
        };

        const turn1: AgentMessage[] = [];
        backendInternal.transport = {
            sendRequest: async () => ({ stopReason: 'end_turn' }),
            close: async () => {}
        };

        await backend.prompt('session-1', [{ type: 'text', text: 'hi' }], (m) => turn1.push(m));

        // Straggler arrives after turn 1 fully resolved. No turn 2 follows in
        // this test — only an between-turn flush can deliver it to turn 1.
        backendInternal.handleSessionUpdate({
            sessionId: 'session-1',
            update: {
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
                content: { type: 'text', text: 'straggler from turn 1' }
            }
        });

        await sleep(30);

        const turn1Text = turn1
            .filter((m): m is Extract<AgentMessage, { type: 'text' }> => m.type === 'text')
            .map((m) => m.text);
        expect(turn1Text).toContain('straggler from turn 1');
    });

    it('does not split a fragmented internal-event envelope across a between-turn drain', async () => {
        // Regression for the pr-review finding: the between-turn drain timer
        // was throttled (first update wins the deadline), so a usage_update
        // could start the 200ms deadline before a fragmented internal-event
        // envelope arrived. The first fragment was then drained alone, failed
        // the isInternalEventJson filter (it only matches reassembled JSON),
        // and leaked as visible session metadata. The timer must be debounced
        // (deadline reset per update) so the envelope is fully reassembled
        // before flushText re-checks it.
        backendStatics.UPDATE_QUIET_PERIOD_MS = 5;
        backendStatics.UPDATE_DRAIN_TIMEOUT_MS = 50;
        backendStatics.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS = 1;
        backendStatics.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS = 50;
        backendStatics.LATE_FLUSH_INTERVAL_MS = 5;
        backendStatics.LATE_FLUSH_QUIET_PERIOD_MS = 10;
        backendStatics.LATE_FLUSH_WINDOW_MS = 30;
        backendStatics.BETWEEN_TURN_DRAIN_DEBOUNCE_MS = 200;

        const backend = new AcpSdkBackend({ command: 'opencode' });
        const backendInternal = backend as unknown as {
            transport: {
                sendRequest: (...args: unknown[]) => Promise<unknown>;
                close: () => Promise<void>;
            } | null;
            handleSessionUpdate: (params: unknown) => void;
        };

        const turn1: AgentMessage[] = [];
        backendInternal.transport = {
            sendRequest: async () => ({ stopReason: 'end_turn' }),
            close: async () => {}
        };

        await backend.prompt('session-1', [{ type: 'text', text: 'hi' }], (m) => turn1.push(m));

        // A usage_update starts the between-turn drain deadline...
        backendInternal.handleSessionUpdate({
            sessionId: 'session-1',
            update: { sessionUpdate: 'usage_update', used: 1_000, size: 200_000 }
        });
        await sleep(80);
        // ...then the envelope's first fragment arrives, resetting a debounced
        // deadline but being ignored by a throttled one.
        backendInternal.handleSessionUpdate({
            sessionId: 'session-1',
            update: {
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
                content: { type: 'text', text: '{"type":"output","data":{"parentUuid":null,"se' }
            }
        });
        await sleep(160);
        // The second fragment lands after the throttled deadline (which would
        // have already flushed the first fragment alone) but before a
        // debounced deadline (which waits for this fragment before flushing).
        backendInternal.handleSessionUpdate({
            sessionId: 'session-1',
            update: {
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
                content: { type: 'text', text: 'ssionId":"s1","userType":"human"}}' }
            }
        });
        // Wait past the reset debounce deadline so the drain has actually run
        // before asserting — otherwise the test passes even if the timer never
        // fires or the reassembled envelope is emitted incorrectly.
        await sleep(backendStatics.BETWEEN_TURN_DRAIN_DEBOUNCE_MS + 50);

        // Reassembled, the envelope matches isInternalEventJson and must be
        // dropped — no fragment may leak as visible text.
        const turn1Text = turn1
            .filter((m): m is Extract<AgentMessage, { type: 'text' }> => m.type === 'text')
            .map((m) => m.text);
        expect(turn1Text).toEqual([]);
    });

    it('does not flush a stale queue snapshot when an update replaces the queue mid-drain', async () => {
        // Regression for the pr-review finding: runBetweenTurnDrain() awaits
        // the queue chain that exists when it reaches the await. A later
        // update can replace sessionUpdateQueue while that await is pending
        // (the update resets the timer but cannot cancel the already-running
        // drain). The old drain then resumes before the newer update's
        // handler runs and flushes a stale buffer snapshot, splitting a
        // fragmented delta-mode internal envelope — the first fragment leaks
        // as visible text. The drain must verify the queue it waited on is
        // still the current one and defer to the newer update's own drain.
        backendStatics.UPDATE_QUIET_PERIOD_MS = 5;
        backendStatics.UPDATE_DRAIN_TIMEOUT_MS = 50;
        backendStatics.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS = 1;
        backendStatics.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS = 50;
        backendStatics.LATE_FLUSH_INTERVAL_MS = 5;
        backendStatics.LATE_FLUSH_QUIET_PERIOD_MS = 10;
        backendStatics.LATE_FLUSH_WINDOW_MS = 30;
        backendStatics.BETWEEN_TURN_DRAIN_DEBOUNCE_MS = 30;

        const backend = new AcpSdkBackend({ command: 'opencode' });
        const backendInternal = backend as unknown as {
            transport: {
                sendRequest: (...args: unknown[]) => Promise<unknown>;
                close: () => Promise<void>;
            } | null;
            handleSessionUpdate: (params: unknown) => void;
            sessionUpdateQueue: Promise<void>;
        };

        const turn1: AgentMessage[] = [];
        backendInternal.transport = {
            sendRequest: async () => ({ stopReason: 'end_turn' }),
            close: async () => {}
        };

        await backend.prompt('session-1', [{ type: 'text', text: 'hi' }], (m) => turn1.push(m));

        // Block the queue so the first between-turn drain parks on its await
        // instead of completing.
        let releaseBlocker!: () => void;
        const blocker = new Promise<void>((resolve) => {
            releaseBlocker = resolve;
        });
        backendInternal.sessionUpdateQueue = backendInternal.sessionUpdateQueue.then(() => blocker);

        // Fragment 1 arrives; the debounce timer is armed but the drain cannot
        // finish because the queue is blocked.
        backendInternal.handleSessionUpdate({
            sessionId: 'session-1',
            update: {
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
                content: { type: 'text', text: '{"type":"output","data":{"parentUuid":null,"se' }
            }
        });
        // Let the debounce deadline elapse so drain #1 starts and parks on the
        // (now stale) queue chain.
        await sleep(backendStatics.BETWEEN_TURN_DRAIN_DEBOUNCE_MS + 10);

        // Fragment 2 replaces the queue while drain #1 is still awaiting the
        // old chain. This resets the debounce timer for a second drain.
        backendInternal.handleSessionUpdate({
            sessionId: 'session-1',
            update: {
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
                content: { type: 'text', text: 'ssionId":"s1","userType":"human"}}' }
            }
        });
        await sleep(10);

        // Release the block: drain #1 resumes before fragment 2's handler
        // runs. It must recognize the queue was replaced and defer, rather
        // than flushing fragment 1 alone.
        releaseBlocker();

        // Wait past the reset debounce deadline so the drain armed by
        // fragment 2 has actually run before asserting — otherwise the test
        // passes even if the drain never fires or the stale snapshot is
        // flushed incorrectly.
        await sleep(backendStatics.BETWEEN_TURN_DRAIN_DEBOUNCE_MS + 50);

        // Reassembled, the envelope matches isInternalEventJson and must be
        // dropped — no fragment may leak as visible text.
        const turn1Text = turn1
            .filter((m): m is Extract<AgentMessage, { type: 'text' }> => m.type === 'text')
            .map((m) => m.text);
        expect(turn1Text).toEqual([]);
    });

    it('emits a late text update before turn_complete when it replaces the final queue snapshot', async () => {
        // Regression for the pr-review finding: the final drain before
        // turn_complete awaited the queue chain that existed when it reached
        // the await. A late update arriving while that await was pending sees
        // isProcessingMessage === true, so scheduleBetweenTurnDrain() returns
        // without re-arming its timer — and the drain resumes on the stale
        // snapshot before the newer handler runs, stranding the late text
        // until the next prompt. The final drain must wait for the queue
        // reference to stop changing (waitForQueueSettled), not just settle
        // once.
        backendStatics.UPDATE_QUIET_PERIOD_MS = 5;
        backendStatics.UPDATE_DRAIN_TIMEOUT_MS = 50;
        backendStatics.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS = 1;
        backendStatics.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS = 50;
        backendStatics.LATE_FLUSH_INTERVAL_MS = 5;
        backendStatics.LATE_FLUSH_QUIET_PERIOD_MS = 50;
        backendStatics.LATE_FLUSH_WINDOW_MS = 500;
        backendStatics.BETWEEN_TURN_DRAIN_DEBOUNCE_MS = 30;

        const backend = new AcpSdkBackend({ command: 'opencode' });
        const backendInternal = backend as unknown as {
            transport: {
                sendRequest: (...args: unknown[]) => Promise<unknown>;
                close: () => Promise<void>;
            } | null;
            handleSessionUpdate: (params: unknown) => void;
            sessionUpdateQueue: Promise<void>;
        };

        let releaseRequest!: () => void;
        const requestGate = new Promise<void>((resolve) => {
            releaseRequest = resolve;
        });

        const turn1: AgentMessage[] = [];
        backendInternal.transport = {
            sendRequest: async () => {
                await requestGate;
                return { stopReason: 'end_turn' };
            },
            close: async () => {}
        };

        const promptPromise = backend.prompt('session-1', [{ type: 'text', text: 'hi' }], (m) => turn1.push(m));
        // Let prompt() reach the sendRequest gate (isProcessingMessage=true).
        await sleep(15);
        releaseRequest();

        // Let prompt() pass the first (settled) queue await and enter
        // drainLateBuffers, then block the queue so the *final* drain parks on
        // it instead of completing.
        await sleep(15);
        let releaseBlocker!: () => void;
        const blocker = new Promise<void>((resolve) => {
            releaseBlocker = resolve;
        });
        backendInternal.sessionUpdateQueue = backendInternal.sessionUpdateQueue.then(() => blocker);

        // Wait out drainLateBuffers' quiet period so the final drain captures
        // the blocked chain and parks on it.
        await sleep(60);

        // Late text arrives while the final drain is awaiting the stale chain.
        // isProcessingMessage is still true, so no between-turn timer is
        // re-armed — this is what makes the stale drain unrecoverable without
        // waiting for the queue reference to stabilize.
        backendInternal.handleSessionUpdate({
            sessionId: 'session-1',
            update: {
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
                content: { type: 'text', text: 'late reply' }
            }
        });
        await sleep(5);

        releaseBlocker();
        await promptPromise;

        // The late text must have been emitted before turn_complete and
        // before prompt() resolved — not stranded until the next prompt.
        const lateTextIndex = turn1.findIndex((m) => m.type === 'text' && m.text === 'late reply');
        const turnCompleteIndex = turn1.findIndex((m) => m.type === 'turn_complete');
        expect(lateTextIndex).toBeGreaterThan(-1);
        expect(turnCompleteIndex).toBeGreaterThan(-1);
        expect(lateTextIndex).toBeLessThan(turnCompleteIndex);
    });

    it('bounds waitForQueueSettled so a continuously replaced queue cannot wedge prompt()', async () => {
        // Regression for the pr-review finding: waitForQueueSettled() looped
        // until the queue reference stopped changing, with no deadline. Every
        // handleSessionUpdate replaces sessionUpdateQueue, so a sustained
        // async update stream keeps the reference changing forever after both
        // the pre-prompt timeout and the late-flush window have expired —
        // prompt() never reaches turn_complete. The loop must be bounded by
        // the drain timeout.
        const backend = new AcpSdkBackend({ command: 'opencode' });
        const backendInternal = backend as unknown as {
            sessionUpdateQueue: Promise<void>;
            waitForQueueSettled: (timeoutMs: number) => Promise<boolean>;
        };

        // Continuously replaced queue: each settle is followed by a new
        // pending promise, so the reference never stabilizes.
        let releaseQueue: () => void;
        const armQueue = () => {
            backendInternal.sessionUpdateQueue = new Promise<void>((resolve) => {
                releaseQueue = resolve;
            });
        };
        armQueue();

        const started = Date.now();
        const waitPromise = backendInternal.waitForQueueSettled(50);
        // Every tick: swap in a fresh pending chain first, then release the
        // previous chain the wait is parked on — the reference keeps changing
        // while the loop keeps advancing.
        const interval = setInterval(() => {
            const prevRelease = releaseQueue;
            armQueue();
            prevRelease();
        }, 5);
        try {
            const result = await Promise.race([
                waitPromise.then(() => 'settled'),
                new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 2000))
            ]);
            // Without the deadline the loop never exits and this races to
            // 'timed-out'; with it, the wait returns once 50ms elapses.
            expect(result).toBe('settled');
            const elapsed = Date.now() - started;
            expect(elapsed).toBeGreaterThanOrEqual(45);
            expect(elapsed).toBeLessThan(5000);
        } finally {
            clearInterval(interval);
        }
    });

    it('flushes the queue tail abandoned at the settle deadline via the between-turn drain', async () => {
        // Regression for the pr-review finding: waitForQueueSettled() returns
        // at its deadline even when the queue reference is still changing. The
        // final drain then emits turn_complete as if the queue were stable, but
        // updates enqueued while the prompt was active already skipped
        // scheduleBetweenTurnDrain() (isProcessingMessage was true) — when the
        // abandoned tail later writes into the handler, no timer flushes it and
        // the reply strands until the next prompt. The deadline path must
        // re-arm the between-turn drain instead of draining as if stable.
        backendStatics.UPDATE_QUIET_PERIOD_MS = 5;
        backendStatics.UPDATE_DRAIN_TIMEOUT_MS = 50;
        backendStatics.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS = 1;
        backendStatics.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS = 50;
        backendStatics.LATE_FLUSH_INTERVAL_MS = 5;
        backendStatics.LATE_FLUSH_QUIET_PERIOD_MS = 5;
        backendStatics.LATE_FLUSH_WINDOW_MS = 500;
        backendStatics.BETWEEN_TURN_DRAIN_DEBOUNCE_MS = 30;

        const backend = new AcpSdkBackend({ command: 'opencode' });
        const backendInternal = backend as unknown as {
            transport: {
                sendRequest: (...args: unknown[]) => Promise<unknown>;
                close: () => Promise<void>;
            } | null;
            handleSessionUpdate: (params: unknown) => void;
            sessionUpdateQueue: Promise<void>;
        };

        let releaseRequest!: () => void;
        const requestGate = new Promise<void>((resolve) => {
            releaseRequest = resolve;
        });

        const turn1: AgentMessage[] = [];
        backendInternal.transport = {
            sendRequest: async () => {
                await requestGate;
                return { stopReason: 'end_turn' };
            },
            close: async () => {}
        };

        const promptPromise = backend.prompt('session-1', [{ type: 'text', text: 'hi' }], (m) => turn1.push(m));

        // Continuously replaced queue: arm immediately (before the prompt's
        // pre-swap and final settle waits run) and keep replacing the
        // reference every 5ms for the whole prompt, so waitForQueueSettled
        // never sees a stable reference and must hit its deadline.
        let releaseQueue!: () => void;
        const armQueue = () => {
            backendInternal.sessionUpdateQueue = new Promise<void>((resolve) => {
                releaseQueue = resolve;
            });
        };
        armQueue();
        const intervalStart = Date.now();
        let tailEnqueued = false;
        let releaseTail!: () => void;
        const tailGate = new Promise<void>((resolve) => {
            releaseTail = resolve;
        });
        const interval = setInterval(() => {
            const prevRelease = releaseQueue;
            if (!tailEnqueued && Date.now() - intervalStart >= 70) {
                // Past the pre-swap settle (isProcessingMessage is true by
                // now): park a real text update on the current chain, gated
                // on tailGate so its content lands in the handler only after
                // the turn resolved — exactly the abandoned-tail scenario.
                // Its own scheduleBetweenTurnDrain() is skipped because the
                // prompt is still processing. Re-arm a fresh queue right
                // after so waitForQueueSettled never captures (and blocks
                // on) the gated chain; prevRelease() below then resolves
                // the tail's base, advancing it to the tailGate.
                tailEnqueued = true;
                backendInternal.sessionUpdateQueue = backendInternal.sessionUpdateQueue.then(() => tailGate);
                backendInternal.handleSessionUpdate({
                    sessionId: 'session-1',
                    update: {
                        sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
                        content: { type: 'text', text: 'tail reply' }
                    }
                });
                armQueue();
            } else {
                armQueue();
            }
            prevRelease();
        }, 5);
        try {
            // Let the pre-swap settle churn to its deadline (~50ms) and
            // reach sendRequest, then release it so the final settle wait
            // runs against the still-churning queue.
            await sleep(60);
            releaseRequest();
            await promptPromise;
        } finally {
            clearInterval(interval);
        }
        // The settle deadline abandoned the tail: its text was not in the
        // handler when the final drain ran, so only the re-armed between-turn
        // drain can flush it to this turn's onUpdate.
        releaseQueue();
        releaseTail();
        // Wait out the between-turn drain debounce plus the drain itself.
        await sleep(80);

        expect(turn1.some((m) => m.type === 'text' && m.text === 'tail reply')).toBe(true);
    });

    it('re-arms the between-turn drain after suppressUpdatesDuring consumed the pending timer', async () => {
        // Regression for the pr-review finding: a straggler that armed the
        // debounced between-turn drain right before suppressUpdatesDuring()
        // nulls messageHandler loses its flush. runBetweenTurnDrain() passes
        // both guards while suppressed (isProcessingMessage and
        // promptRequestInFlight are both false), awaits the queue, verifies
        // its identity — then `this.messageHandler?.drainBuffers()` silently
        // no-ops on the null handler and the timer is consumed. Restoring the
        // handler must re-arm the drain, or the straggler strands in the
        // buffer until the next prompt.
        backendStatics.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS = 5;
        backendStatics.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS = 50;
        backendStatics.BETWEEN_TURN_DRAIN_DEBOUNCE_MS = 30;

        const backend = new AcpSdkBackend({ command: 'opencode' });
        const backendInternal = backend as unknown as {
            transport: {
                sendRequest: (...args: unknown[]) => Promise<unknown>;
                close: () => Promise<void>;
            } | null;
            handleSessionUpdate: (params: unknown) => void;
            sessionUpdateQueue: Promise<void>;
        };
        backendInternal.transport = {
            sendRequest: async () => ({ stopReason: 'end_turn' }),
            close: async () => {}
        };

        const turn1: AgentMessage[] = [];
        await backend.prompt('session-1', [{ type: 'text', text: 'hi' }], (m) => turn1.push(m));

        // Straggler arrives and arms the between-turn drain (debounce 30ms).
        backendInternal.handleSessionUpdate({
            sessionId: 'session-1',
            update: {
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
                content: { type: 'text', text: 'straggler survived suppression' }
            }
        });

        // Suppression starts in the same tick; messageHandler is nulled
        // before the straggler's queued microtask flushes into the previous
        // handler (the enqueue-time capture keeps that buffering working),
        // and stays null while fn sleeps past the 30ms debounce deadline so
        // the drain fires — and no-ops — during suppression.
        await backend.suppressUpdatesDuring(async () => {
            await sleep(50);
            return 'compact result';
        });

        // With the fix the restore re-arms the drain; give it a debounce plus
        // margin. Without it the straggler stays in the buffer forever.
        await sleep(backendStatics.BETWEEN_TURN_DRAIN_DEBOUNCE_MS + 50);

        const turn1Text = turn1
            .filter((m): m is Extract<AgentMessage, { type: 'text' }> => m.type === 'text')
            .map((m) => m.text);
        expect(turn1Text).toContain('straggler survived suppression');
    });

    it('does not duplicate cumulative dedupe text across between-turn drains', async () => {
        // Regression for the pr-review finding: appendTextChunk in dedupe mode
        // (the default for every non-opencode backend) keeps the *cumulative
        // snapshot* in bufferedText ("Hello" grows to the fuller "Hello world"
        // via startsWith). drainBuffers() clearing that buffer meant a
        // between-turn drain emitted "Hello", then the later cumulative "Hello
        // world" snapshot had no baseline to dedupe against and was emitted as
        // a second full message — the web rendered "HelloHello world".
        // Artificial drains must retain the cumulative snapshot and emit only
        // the suffix not emitted by an earlier artificial drain.
        backendStatics.UPDATE_QUIET_PERIOD_MS = 5;
        backendStatics.UPDATE_DRAIN_TIMEOUT_MS = 50;
        backendStatics.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS = 1;
        backendStatics.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS = 50;
        backendStatics.LATE_FLUSH_INTERVAL_MS = 5;
        backendStatics.LATE_FLUSH_QUIET_PERIOD_MS = 10;
        backendStatics.LATE_FLUSH_WINDOW_MS = 30;
        backendStatics.BETWEEN_TURN_DRAIN_DEBOUNCE_MS = 5;

        const backend = new AcpSdkBackend({ command: 'opencode' });
        const backendInternal = backend as unknown as {
            transport: {
                sendRequest: (...args: unknown[]) => Promise<unknown>;
                close: () => Promise<void>;
            } | null;
            handleSessionUpdate: (params: unknown) => void;
            sessionUpdateQueue: Promise<void>;
        };
        backendInternal.transport = {
            sendRequest: async () => ({ stopReason: 'end_turn' }),
            close: async () => {}
        };

        const turn1: AgentMessage[] = [];
        await backend.prompt('session-1', [{ type: 'text', text: 'hi' }], (m) => turn1.push(m));

        // First cumulative snapshot fragment: "Hello". The between-turn drain
        // flushes it as "Hello" but must keep it as the dedupe baseline.
        backendInternal.handleSessionUpdate({
            sessionId: 'session-1',
            update: {
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
                content: { type: 'text', text: 'Hello' }
            }
        });
        await sleep(20);

        // Later the fuller cumulative snapshot arrives: "Hello world". The
        // startsWith dedupe grows the buffer; the next drain must emit only
        // the " world" suffix, not the whole snapshot again.
        backendInternal.handleSessionUpdate({
            sessionId: 'session-1',
            update: {
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
                content: { type: 'text', text: 'Hello world' }
            }
        });
        await sleep(20);

        const turn1Text = turn1
            .filter((m): m is Extract<AgentMessage, { type: 'text' }> => m.type === 'text')
            .map((m) => m.text);
        expect(turn1Text.join('')).toBe('Hello world');
    });

    it('does not leak a fragmented internal envelope when delta text was already drained', async () => {
        // Regression for the pr-review finding: preserveTextBaseline must only
        // apply to dedupe streams. OpenCode streams incremental chunks
        // (textChunkMode: 'delta'); retaining bufferedText there meant a later
        // fragmented internal-event envelope was appended to the retained
        // visible prefix, so the reassembled string was "Hello{...envelope}",
        // no longer matching isInternalEventJson — and the envelope suffix
        // leaked as visible text. Delta streams clear per drain so a fresh
        // envelope reassembles standalone.
        backendStatics.UPDATE_QUIET_PERIOD_MS = 5;
        backendStatics.UPDATE_DRAIN_TIMEOUT_MS = 50;
        backendStatics.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS = 1;
        backendStatics.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS = 50;
        backendStatics.LATE_FLUSH_INTERVAL_MS = 5;
        backendStatics.LATE_FLUSH_QUIET_PERIOD_MS = 10;
        backendStatics.LATE_FLUSH_WINDOW_MS = 30;
        backendStatics.BETWEEN_TURN_DRAIN_DEBOUNCE_MS = 30;

        const backend = new AcpSdkBackend({ command: 'opencode', textChunkMode: 'delta' });
        const backendInternal = backend as unknown as {
            transport: {
                sendRequest: (...args: unknown[]) => Promise<unknown>;
                close: () => Promise<void>;
            } | null;
            handleSessionUpdate: (params: unknown) => void;
            sessionUpdateQueue: Promise<void>;
        };
        backendInternal.transport = {
            sendRequest: async () => ({ stopReason: 'end_turn' }),
            close: async () => {}
        };

        const turn1: AgentMessage[] = [];
        await backend.prompt('session-1', [{ type: 'text', text: 'hi' }], (m) => turn1.push(m));

        // Visible delta text arrives first; the between-turn drain emits it.
        backendInternal.handleSessionUpdate({
            sessionId: 'session-1',
            update: {
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
                content: { type: 'text', text: 'Hello' }
            }
        });
        await sleep(backendStatics.BETWEEN_TURN_DRAIN_DEBOUNCE_MS + 20);

        // The fragmented internal envelope arrives (both fragments inside one
        // debounce window). With the bug the retained "Hello" prefix makes the
        // reassembled string fail isInternalEventJson and the envelope leaks.
        backendInternal.handleSessionUpdate({
            sessionId: 'session-1',
            update: {
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
                content: { type: 'text', text: '{"type":"output","data":{"parentUuid":null,"se' }
            }
        });
        backendInternal.handleSessionUpdate({
            sessionId: 'session-1',
            update: {
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
                content: { type: 'text', text: 'ssionId":"s1","userType":"human"}}' }
            }
        });
        await sleep(backendStatics.BETWEEN_TURN_DRAIN_DEBOUNCE_MS + 50);

        // Only the visible text may be emitted; the reassembled envelope must
        // be dropped.
        const turn1Text = turn1
            .filter((m): m is Extract<AgentMessage, { type: 'text' }> => m.type === 'text')
            .map((m) => m.text);
        expect(turn1Text.join('')).toBe('Hello');
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
});

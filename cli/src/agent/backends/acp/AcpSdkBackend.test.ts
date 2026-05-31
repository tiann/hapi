import { afterEach, describe, expect, it } from 'vitest';
import type { AgentMessage } from '@/agent/types';
import { AcpSdkBackend } from './AcpSdkBackend';
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

afterEach(() => {
    backendStatics.UPDATE_QUIET_PERIOD_MS = originalStatics.updateQuietPeriodMs;
    backendStatics.UPDATE_DRAIN_TIMEOUT_MS = originalStatics.updateDrainTimeoutMs;
    backendStatics.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS = originalStatics.prePromptUpdateQuietPeriodMs;
    backendStatics.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS = originalStatics.prePromptUpdateDrainTimeoutMs;
    backendStatics.LATE_FLUSH_INTERVAL_MS = originalStatics.lateFlushIntervalMs;
    backendStatics.LATE_FLUSH_QUIET_PERIOD_MS = originalStatics.lateFlushQuietPeriodMs;
    backendStatics.LATE_FLUSH_WINDOW_MS = originalStatics.lateFlushWindowMs;
});

describe('AcpSdkBackend', () => {
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
                        totalTokens: 13_892,
                        inputTokens: 8_119,
                        outputTokens: 2,
                        thoughtTokens: 11,
                        cachedReadTokens: 5_760
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
            thoughtTokens: 11,
            totalTokens: 13_892,
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

    it('emits a context-only usage mid-turn so the status bar updates live', async () => {
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
                    update: { sessionUpdate: 'usage_update', used: 1_000, size: 200_000 }
                });
                backendInternal.handleSessionUpdate({
                    sessionId: 'session-1',
                    update: { sessionUpdate: 'usage_update', used: 1_000, size: 200_000 }
                });
                backendInternal.handleSessionUpdate({
                    sessionId: 'session-1',
                    update: { sessionUpdate: 'usage_update', used: 2_500, size: 200_000 }
                });
                await sleep(5);
                return {
                    stopReason: 'end_turn',
                    usage: { inputTokens: 100, outputTokens: 50 }
                };
            },
            close: async () => {}
        };

        await backend.prompt('session-1', [{ type: 'text', text: 'hello' }], (m) => messages.push(m));

        const usageMessages = messages.filter((m): m is Extract<AgentMessage, { type: 'usage' }> => m.type === 'usage');
        // Two mid-turn ticks (deduped second 1_000) + one final emit with the
        // prompt-level input/output totals.
        expect(usageMessages.length).toBe(3);
        expect(usageMessages[0]).toMatchObject({ inputTokens: 0, outputTokens: 0, contextTokens: 1_000, contextWindow: 200_000 });
        expect(usageMessages[1]).toMatchObject({ inputTokens: 0, outputTokens: 0, contextTokens: 2_500, contextWindow: 200_000 });
        expect(usageMessages[2]).toMatchObject({ inputTokens: 100, outputTokens: 50, contextTokens: 2_500, contextWindow: 200_000 });
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
        // One mid-turn emit and one finalize fallback — both context-only.
        expect(usageMessages.length).toBe(2);
        for (const usage of usageMessages) {
            expect(usage).toMatchObject({
                inputTokens: 0,
                outputTokens: 0,
                contextTokens: 4_200,
                contextWindow: 200_000
            });
        }
    });
});

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
};

const backendStatics = AcpSdkBackend as unknown as BackendStatics;
const originalStatics = {
    updateQuietPeriodMs: backendStatics.UPDATE_QUIET_PERIOD_MS,
    updateDrainTimeoutMs: backendStatics.UPDATE_DRAIN_TIMEOUT_MS,
    prePromptUpdateQuietPeriodMs: backendStatics.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS,
    prePromptUpdateDrainTimeoutMs: backendStatics.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS
};

afterEach(() => {
    backendStatics.UPDATE_QUIET_PERIOD_MS = originalStatics.updateQuietPeriodMs;
    backendStatics.UPDATE_DRAIN_TIMEOUT_MS = originalStatics.updateDrainTimeoutMs;
    backendStatics.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS = originalStatics.prePromptUpdateQuietPeriodMs;
    backendStatics.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS = originalStatics.prePromptUpdateDrainTimeoutMs;
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

    it('emits turn_complete after trailing tool updates from the same turn', async () => {
        backendStatics.UPDATE_QUIET_PERIOD_MS = 25;
        backendStatics.UPDATE_DRAIN_TIMEOUT_MS = 200;
        backendStatics.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS = 1;
        backendStatics.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS = 50;

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
});

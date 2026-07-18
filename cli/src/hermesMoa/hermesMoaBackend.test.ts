import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import {
    buildHermesServeSpawnOptions,
    convertHermesGatewayEventToAgentMessage,
    deriveHermesMoaFallbackTitle,
    mapPermissionResponseToHermesChoice,
    parseHermesServeReadyPort,
    summarizeHermesServeStderr,
    terminateHermesChild
} from './hermesMoaBackend';
import type { PermissionRequest } from '@/agent/types';

describe('parseHermesServeReadyPort', () => {
    it('extracts the auto-assigned port from hermes serve stdout', () => {
        expect(parseHermesServeReadyPort('HERMES_BACKEND_READY port=63131\n')).toBe(63131);
    });

    it('ignores unrelated output until the ready line appears', () => {
        expect(parseHermesServeReadyPort('loading...\nHERMES_BACKEND_READY port=49152\n')).toBe(49152);
    });
});

describe('summarizeHermesServeStderr', () => {
    it('retains only byte counts and never returns prompt, tool, or file content', () => {
        const secret = 'user prompt secret /Users/example/private.txt tool output';
        const summary = summarizeHermesServeStderr(secret);

        expect(summary).toBe(`stderr captured (${Buffer.byteLength(secret)} bytes)`);
        expect(summary).not.toContain('secret');
        expect(summary).not.toContain('/Users/example');
        expect(summary).not.toContain('tool output');
    });
});

describe('buildHermesServeSpawnOptions', () => {
    it('pins Hermes serve to the selected HAPI workspace and enables workspace-only isolation', () => {
        const options = buildHermesServeSpawnOptions('/tmp/hapi-selected-workspace', 'token-123', {
            PATH: '/bin',
            HERMES_WORKSPACE_ONLY: '0',
            TERMINAL_CWD: '/wrong',
            HAPI_INVOKED_CWD: '/wrong',
        });

        expect(options.cwd).toBe('/tmp/hapi-selected-workspace');
        expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
        expect(options.env).toMatchObject({
            PATH: '/bin',
            HERMES_DASHBOARD_SESSION_TOKEN: 'token-123',
            HERMES_WORKSPACE_ONLY: '1',
            TERMINAL_CWD: '/tmp/hapi-selected-workspace',
            HAPI_INVOKED_CWD: '/tmp/hapi-selected-workspace',
        });
    });

    it('does not pass runner-managed ownership metadata to the Hermes child', () => {
        const options = buildHermesServeSpawnOptions('/tmp/workspace', 'token-123', {
            PATH: '/bin', HAPI_LAUNCH_NONCE: 'launch-1', HAPI_RUNNER_INSTANCE_ID: 'runner-1',
            HAPI_RESUME_PROFILE_FINGERPRINT: 'profile-1', HAPI_EXPECTED_NATIVE_RESUME_ID: 'native-1',
            HAPI_MANAGED_OUTCOME_FD: '3'
        });

        expect(options.env).not.toHaveProperty('HAPI_LAUNCH_NONCE');
        expect(options.env).not.toHaveProperty('HAPI_RUNNER_INSTANCE_ID');
        expect(options.env).not.toHaveProperty('HAPI_RESUME_PROFILE_FINGERPRINT');
        expect(options.env).not.toHaveProperty('HAPI_EXPECTED_NATIVE_RESUME_ID');
        expect(options.env).not.toHaveProperty('HAPI_MANAGED_OUTCOME_FD');
    });
});

describe('terminateHermesChild', () => {
    it('waits for exit and escalates to SIGKILL when SIGTERM does not settle the child', async () => {
        const emitter = new EventEmitter();
        const signals: string[] = [];
        const child = Object.assign(emitter, {
            exitCode: null as number | null,
            signalCode: null as NodeJS.Signals | null,
            kill(signal: NodeJS.Signals) {
                signals.push(signal);
                if (signal === 'SIGKILL') {
                    this.signalCode = signal;
                    queueMicrotask(() => emitter.emit('exit', null, signal));
                }
                return true;
            }
        });

        await terminateHermesChild(child as any, 1);
        expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    });
});

describe('mapPermissionResponseToHermesChoice', () => {
    const request: PermissionRequest = {
        id: 'approval-1',
        sessionId: 'sid-1',
        toolCallId: 'approval-1',
        title: 'Run command',
        options: [
            { optionId: 'allow-once', name: 'Run once', kind: 'allow_once' },
            { optionId: 'allow-session', name: 'Allow for session', kind: 'allow_always' },
            { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
        ]
    };

    it('maps generic HAPI permission outcomes to Hermes approval choices', () => {
        expect(mapPermissionResponseToHermesChoice(request, {
            outcome: 'selected',
            optionId: 'allow-once'
        })).toBe('once');
        expect(mapPermissionResponseToHermesChoice(request, {
            outcome: 'selected',
            optionId: 'allow-session'
        })).toBe('session');
        expect(mapPermissionResponseToHermesChoice(request, {
            outcome: 'selected',
            optionId: 'reject'
        })).toBe('deny');
        expect(mapPermissionResponseToHermesChoice(request, { outcome: 'cancelled' })).toBe('deny');
    });

    it('passes native Hermes choice option ids through directly', () => {
        expect(mapPermissionResponseToHermesChoice(request, {
            outcome: 'selected',
            optionId: 'once'
        })).toBe('once');
        expect(mapPermissionResponseToHermesChoice(request, {
            outcome: 'selected',
            optionId: 'session'
        })).toBe('session');
    });
});

describe('convertHermesGatewayEventToAgentMessage', () => {
    it('maps MoA reference events to labelled agent messages', () => {
        expect(convertHermesGatewayEventToAgentMessage({
            type: 'moa.reference',
            session_id: 'sid-1',
            payload: {
                label: 'ref-model-a',
                text: 'reference output',
                index: 2,
                count: 3
            }
        }, 'sid-1')).toEqual({
            type: 'moa_reference',
            label: 'ref-model-a',
            text: 'reference output',
            index: 2,
            count: 3
        });
    });

    it('maps MoA aggregating events to status agent messages', () => {
        expect(convertHermesGatewayEventToAgentMessage({
            type: 'moa.aggregating',
            session_id: 'sid-1',
            payload: { aggregator: 'agg-model' }
        }, 'sid-1')).toEqual({
            type: 'moa_aggregating',
            aggregator: 'agg-model'
        });
    });

    it('maps streamed deltas and complete events to text messages', () => {
        expect(convertHermesGatewayEventToAgentMessage({
            type: 'message.delta',
            payload: { text: 'hel' }
        }, 'sid-1')).toEqual({ type: 'text', text: 'hel' });

        expect(convertHermesGatewayEventToAgentMessage({
            type: 'message.complete',
            session_id: 'sid-1',
            payload: { text: 'hello' }
        }, 'sid-1')).toEqual({ type: 'turn_complete', stopReason: 'complete' });
    });

    it('maps Hermes tool start events to HAPI tool calls', () => {
        expect(convertHermesGatewayEventToAgentMessage({
            type: 'tool.start',
            session_id: 'sid-1',
            payload: {
                tool_id: 'tool-1',
                name: 'read_file',
                context: 'README.md',
                args_text: '{"path":"README.md"}'
            }
        }, 'sid-1')).toEqual({
            type: 'tool_call',
            id: 'tool-1',
            name: 'read_file',
            input: {
                context: 'README.md',
                args_text: '{"path":"README.md"}'
            },
            status: 'in_progress'
        });
    });

    it('maps Hermes tool complete events to HAPI tool results', () => {
        expect(convertHermesGatewayEventToAgentMessage({
            type: 'tool.complete',
            session_id: 'sid-1',
            payload: {
                tool_id: 'tool-1',
                name: 'read_file',
                result: 'file contents',
                summary: 'read README.md'
            }
        }, 'sid-1')).toEqual({
            type: 'tool_result',
            id: 'tool-1',
            output: 'file contents',
            status: 'completed'
        });

        expect(convertHermesGatewayEventToAgentMessage({
            type: 'tool.complete',
            session_id: 'sid-1',
            payload: {
                tool_id: 'tool-2',
                name: 'shell',
                error: 'denied'
            }
        }, 'sid-1')).toEqual({
            type: 'tool_result',
            id: 'tool-2',
            output: 'denied',
            status: 'failed'
        });
    });

    it('drops events for another Hermes runtime session', () => {
        expect(convertHermesGatewayEventToAgentMessage({
            type: 'moa.reference',
            session_id: 'other',
            payload: { label: 'x', text: 'y' }
        }, 'sid-1')).toBeNull();
    });
});

describe('deriveHermesMoaFallbackTitle', () => {
    it('derives a concise Chinese title from the first assistant heading', () => {
        expect(deriveHermesMoaFallbackTitle(
            '总结这个库的世界观和剧情结构',
            [
                '材料读完了，下面是这个库的世界观和剧情结构。',
                '',
                '# 《凡圣西游路》——取经后两百年的西游',
                '',
                '正文'
            ].join('\n')
        )).toBe('凡圣西游路世界观总结');
    });

    it('falls back to a cleaned assistant line when there is no heading', () => {
        expect(deriveHermesMoaFallbackTitle(
            '帮我整理方案',
            '**Hermes MoA 主模型切换方案**\n\n正文'
        )).toBe('Hermes MoA 主模型切换方案');
    });
});

describe('HermesMoaBackend title sync', () => {
    it('emits a HAPI title update after Hermes completes and exposes a session title', async () => {
        const { HermesMoaBackend } = await import('./hermesMoaBackend');
        const backend = new HermesMoaBackend();
        const messages: unknown[] = [];

        (backend as any).request = async (method: string) => {
            if (method === 'prompt.submit') {
                queueMicrotask(() => {
                    (backend as any).eventHandler?.({
                        type: 'message.complete',
                        session_id: 'sid-1',
                        payload: { status: 'complete', text: 'answer' }
                    });
                });
                return {};
            }
            if (method === 'session.title') {
                return { title: 'Hermes MoA 接入' };
            }
            return {};
        };

        await backend.prompt('sid-1', [{ type: 'text', text: '帮我接入 Hermes MoA' }], (message) => {
            messages.push(message);
        });

        expect(messages).toContainEqual({ type: 'title', title: 'Hermes MoA 接入' });
    });

    it('keeps listening for the delayed Hermes session.title event after message.complete', async () => {
        const { HermesMoaBackend } = await import('./hermesMoaBackend');
        const backend = new HermesMoaBackend();
        const messages: unknown[] = [];

        (backend as any).request = async (method: string) => {
            if (method === 'prompt.submit') {
                queueMicrotask(() => {
                    (backend as any).eventHandler?.({
                        type: 'message.complete',
                        session_id: 'sid-1',
                        payload: { status: 'complete', text: 'answer' }
                    });
                    queueMicrotask(() => {
                        (backend as any).eventHandler?.({
                            type: 'session.title',
                            session_id: 'sid-1',
                            payload: { session_id: '20260707_191746_9739b1', title: '游戏开场第一章剧情规划待确认' }
                        });
                    });
                });
                return {};
            }
            if (method === 'session.title') {
                return { title: '' };
            }
            return {};
        };

        await backend.prompt('sid-1', [{ type: 'text', text: '写游戏开场第一章剧情规划' }], (message) => {
            messages.push(message);
        });

        expect(messages).toContainEqual({ type: 'title', title: '游戏开场第一章剧情规划待确认' });
    });

    it('emits a fallback title on the first turn when Hermes does not produce one', async () => {
        const { HermesMoaBackend } = await import('./hermesMoaBackend');
        const backend = new HermesMoaBackend();
        const messages: unknown[] = [];
        const titleWrites: unknown[] = [];

        (backend as any).waitForTitleIfAvailable = async () => false;
        (backend as any).request = async (method: string, params: Record<string, unknown>) => {
            if (method === 'prompt.submit') {
                queueMicrotask(() => {
                    (backend as any).eventHandler?.({
                        type: 'message.complete',
                        session_id: 'sid-1',
                        payload: {
                            status: 'complete',
                            text: [
                                '材料读完了，下面是这个库的世界观和剧情结构。',
                                '',
                                '# 《凡圣西游路》——取经后两百年的西游',
                                '',
                                '正文'
                            ].join('\n')
                        }
                    });
                });
                return {};
            }
            if (method === 'session.title') {
                titleWrites.push(params);
                return { title: params.title };
            }
            return {};
        };

        await backend.prompt('sid-1', [{ type: 'text', text: '总结这个库的世界观和剧情结构' }], (message) => {
            messages.push(message);
        });

        expect(messages).toContainEqual({ type: 'title', title: '凡圣西游路世界观总结' });
        expect(titleWrites).toContainEqual({
            session_id: 'sid-1',
            title: '凡圣西游路世界观总结'
        });
    });
});

describe('HermesMoaBackend model presets', () => {
    it('creates Hermes sessions with the selected GPT-5.6 Sol MoA preset', async () => {
        const { HermesMoaBackend } = await import('./hermesMoaBackend');
        const backend = new HermesMoaBackend({ model: 'gpt-5.6-sol-max', permissionMode: 'yolo' });
        const calls: Array<{ method: string; params: Record<string, unknown> }> = [];

        (backend as any).ensureInitialized = async () => {};
        (backend as any).request = async (method: string, params: Record<string, unknown>) => {
            calls.push({ method, params });
            if (method === 'session.create') {
                return { session_id: 'sid-gpt', stored_session_id: 'stored-gpt' };
            }
            return {};
        };

        const handle = await backend.newSession({ cwd: '/tmp/gpt-moa' } as any);

        expect(handle).toEqual({ sessionId: 'sid-gpt', resumeSessionId: 'stored-gpt' });
        expect(calls).toContainEqual({
            method: 'session.create',
            params: expect.objectContaining({
                cwd: '/tmp/gpt-moa',
                provider: 'moa',
                model: 'gpt-5.6-sol-max',
                workspace_only: true,
            })
        });
        expect(calls).toContainEqual({
            method: 'config.set',
            params: expect.objectContaining({
                session_id: 'sid-gpt',
                key: 'yolo',
                value: '1',
                scope: 'session',
            })
        });
    });

    it('switches an existing Hermes MoA session to the selected GPT-5.6 Sol preset', async () => {
        const { HermesMoaBackend } = await import('./hermesMoaBackend');
        const backend = new HermesMoaBackend();
        const calls: Array<{ method: string; params: Record<string, unknown> }> = [];

        (backend as any).request = async (method: string, params: Record<string, unknown>) => {
            calls.push({ method, params });
            return {};
        };

        await expect(backend.setSessionConfig('sid-gpt', {
            model: ' gpt-5.6-sol-max '
        })).resolves.toEqual({ model: 'gpt-5.6-sol-max' });

        expect(calls).toEqual([
            {
                method: 'config.set',
                params: {
                    session_id: 'sid-gpt',
                    key: 'model',
                    value: 'gpt-5.6-sol-max --provider moa',
                    confirm_expensive_model: false,
                }
            }
        ]);
    });

    it('rejects clearing an existing Hermes MoA session model', async () => {
        const { HermesMoaBackend } = await import('./hermesMoaBackend');
        const backend = new HermesMoaBackend();
        const calls: Array<{ method: string; params: Record<string, unknown> }> = [];

        (backend as any).request = async (method: string, params: Record<string, unknown>) => {
            calls.push({ method, params });
            return {};
        };

        await expect(backend.setSessionConfig('sid-fable', {
            model: null
        })).rejects.toThrow('Hermes MoA preset is required');

        expect(calls).toEqual([]);
    });
});

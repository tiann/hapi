import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parsePiModels, parsePiCommands, parsePiContextUsage, sendPiRpcAndWait, wireTransportEvents } from './loop';
import type { PiResponseEvent } from './types';
import { PiSession } from './session';
import { PiTransport } from './piTransport';
import type { PiThinkingLevel } from './types';

// Mock logger
vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
    },
}));

// Mock message converter chain
vi.mock('@/agent/messageConverter', () => ({
    convertAgentMessage: vi.fn((msg) => msg),
}));

vi.mock('./piEventConverter', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./piEventConverter')>();
    return {
        ...actual,
        convertPiEvent: vi.fn(() => []),
    };
});

vi.mock('./piMessageAccumulator', () => {
    return {
        PiMessageAccumulator: class {
            handleEvent = vi.fn(() => []);
        },
    };
});

function createMockSession(): PiSession {
    return new PiSession({
        api: {} as any,
        client: {
            keepAlive: vi.fn(),
            updateMetadata: vi.fn(),
            sendAgentMessage: vi.fn(),
            emitMessagesConsumed: vi.fn(),
            sendSessionEvent: vi.fn(),
        } as any,
        path: '/tmp/test',
        logPath: '/tmp/test.log',
        startedBy: 'terminal',
        startingMode: 'local',
    });
}

// --- parsePiModels ---

describe('parsePiModels', () => {
    it('returns empty for non-array input', () => {
        expect(parsePiModels(null)).toEqual([]);
        expect(parsePiModels({})).toEqual([]);
        expect(parsePiModels('not array')).toEqual([]);
    });

    it('parses valid model list', () => {
        const data = {
            models: [
                { id: 'gpt-4o', provider: 'openai', name: 'GPT-4o', contextWindow: 128000 },
                { id: 'claude-3', provider: 'anthropic' },
            ],
        };
        const result = parsePiModels(data);
        expect(result).toEqual([
            { provider: 'openai', modelId: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000 },
            { provider: 'anthropic', modelId: 'claude-3' },
        ]);
    });

    it('parses reasoning and thinkingLevelMap', () => {
        const data = {
            models: [
                {
                    id: 'claude-sonnet-4',
                    provider: 'anthropic',
                    name: 'Claude Sonnet 4',
                    reasoning: true,
                    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high' },
                },
                { id: 'gpt-4o', provider: 'openai', reasoning: false },
                { id: 'deepseek-r1', provider: 'deepseek', thinkingLevelMap: {} },
            ],
        };
        const result = parsePiModels(data);
        expect(result).toEqual([
            {
                provider: 'anthropic',
                modelId: 'claude-sonnet-4',
                name: 'Claude Sonnet 4',
                reasoning: true,
                thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high' },
            },
            { provider: 'openai', modelId: 'gpt-4o', reasoning: false },
            { provider: 'deepseek', modelId: 'deepseek-r1' },
        ]);
    });

    it('ignores non-boolean reasoning and invalid thinkingLevelMap', () => {
        const data = {
            models: [
                { id: 'm1', reasoning: 'yes', thinkingLevelMap: 'not-an-object' },
            ],
        };
        expect(parsePiModels(data)).toEqual([
            { provider: 'unknown', modelId: 'm1' },
        ]);
    });

    it('filters out models with empty id', () => {
        const data = {
            models: [
                { id: '', provider: 'openai' },
                { id: 'gpt-4o', provider: 'openai' },
            ],
        };
        expect(parsePiModels(data)).toEqual([
            { provider: 'openai', modelId: 'gpt-4o' },
        ]);
    });

    it('defaults unknown provider', () => {
        const data = { models: [{ id: 'model-1' }] };
        expect(parsePiModels(data)).toEqual([
            { provider: 'unknown', modelId: 'model-1' },
        ]);
    });

    it('skips non-object entries', () => {
        const data = { models: [null, 'string', 42, { id: 'valid' }] };
        expect(parsePiModels(data)).toEqual([
            { provider: 'unknown', modelId: 'valid' },
        ]);
    });

    it('ignores non-string name and non-number contextWindow', () => {
        const data = {
            models: [
                { id: 'm1', name: 123, contextWindow: 'big' },
            ],
        };
        expect(parsePiModels(data)).toEqual([
            { provider: 'unknown', modelId: 'm1' },
        ]);
    });
});

// --- parsePiCommands ---

describe('parsePiCommands', () => {
    it('returns empty for non-array input', () => {
        expect(parsePiCommands(null)).toEqual([]);
        expect(parsePiCommands({})).toEqual([]);
    });

    it('parses valid command list', () => {
        const data = {
            commands: [
                { name: 'analyze', description: 'Analyze code', source: 'skill' },
                { name: 'review', description: 'Review code', source: 'extension' },
                { name: 'custom', description: 'Custom prompt', source: 'prompt' },
            ],
        };
        const result = parsePiCommands(data);
        expect(result).toEqual([
            { name: 'analyze', description: 'Analyze code', source: 'skill' },
            { name: 'review', description: 'Review code', source: 'extension' },
            { name: 'custom', description: 'Custom prompt', source: 'prompt' },
        ]);
    });

    it('defaults unknown source to skill', () => {
        const data = { commands: [{ name: 'cmd', source: 'unknown_source' }] };
        expect(parsePiCommands(data)).toEqual([
            { name: 'cmd', source: 'skill' },
        ]);
    });

    it('filters out commands with empty name', () => {
        const data = { commands: [{ name: '', source: 'skill' }, { name: 'valid', source: 'skill' }] };
        expect(parsePiCommands(data)).toEqual([
            { name: 'valid', source: 'skill' },
        ]);
    });

    it('omits non-string description', () => {
        const data = { commands: [{ name: 'cmd', description: 123 }] };
        expect(parsePiCommands(data)).toEqual([{ name: 'cmd', source: 'skill' }]);
    });
});
// --- parsePiContextUsage ---

describe('parsePiContextUsage', () => {
    it('parses Pi authoritative context usage', () => {
        expect(parsePiContextUsage({
            contextUsage: { tokens: 101_035, contextWindow: 200_000, percent: 50.5 },
        })).toEqual({ tokens: 101_035, contextWindow: 200_000 });
    });

    it('preserves Pi explicit unknown context after compaction', () => {
        expect(parsePiContextUsage({
            contextUsage: { tokens: null, contextWindow: 200_000 },
        })).toBeNull();
    });

    it('returns unavailable for missing or malformed tokens', () => {
        expect(parsePiContextUsage({})).toBeUndefined();
        expect(parsePiContextUsage({ contextUsage: { tokens: '101035' } })).toBeUndefined();
    });
});

// --- wireTransportEvents (integration) ---

describe('wireTransportEvents', () => {
    let session: PiSession;
    let eventHandlers: Map<string, (...args: unknown[]) => void>;

    function createMockTransport(): PiTransport {
        eventHandlers = new Map();
        return {
            onEvent: vi.fn((handler) => { eventHandlers.set('event', handler); }),
            send: vi.fn(),
        } as unknown as PiTransport;
    }

    beforeEach(() => {
        vi.clearAllMocks();
        session = createMockSession();
    });

    function emitEvent(event: Record<string, unknown>): void {
        const handler = eventHandlers.get('event');
        expect(handler).toBeDefined();
        handler!(event);
    }

    function getSentCommand(transport: PiTransport, index = 0): Record<string, unknown> {
        return (transport.send as ReturnType<typeof vi.fn>).mock.calls[index][0] as Record<string, unknown>;
    }

    it('handles get_state response — updates model, provider, thinkingLevel', () => {
        const transport = createMockTransport();
        const pendingLocalIds: string[] = [];
        wireTransportEvents(transport, session, pendingLocalIds);

        emitEvent({
            type: 'response',
            command: 'get_state',
            success: true,
            data: {
                model: { modelId: 'gpt-4o', provider: 'openai' },
                sessionId: 'pi-session-1',
                thinkingLevel: 'high',
                steeringMode: 'one-at-a-time',
            },
        });

        expect(session.currentModel).toBe('gpt-4o');
        expect(session.currentProvider).toBe('openai');
        expect(session.currentThinkingLevel).toBe('high');
        expect(session.currentSteeringMode).toBe('one-at-a-time');
        expect(session.client.updateMetadata).toHaveBeenCalledWith(expect.any(Function));
    });

    it('handles error response — sends session event', () => {
        const transport = createMockTransport();
        wireTransportEvents(transport, session, []);

        emitEvent({
            type: 'response',
            command: 'prompt',
            success: false,
            error: 'Pi crashed',
        });

        expect(session.client.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Pi crashed',
        });
    });

    it('handles agent_start — sets thinking state, does NOT drain pending localId', () => {
        const transport = createMockTransport();
        const pendingLocalIds = ['id-1', 'id-2'];
        wireTransportEvents(transport, session, pendingLocalIds);

        emitEvent({ type: 'agent_start' });

        // agent_start precedes turn_start in a real Pi turn; draining here
        // would double-pop the FIFO (see regression test below).
        expect(pendingLocalIds).toEqual(['id-1', 'id-2']);
        expect(session.client.emitMessagesConsumed).not.toHaveBeenCalled();
    });

    it('handles turn_start — pops pending localId', () => {
        const transport = createMockTransport();
        const pendingLocalIds = ['id-turn-1'];
        wireTransportEvents(transport, session, pendingLocalIds);

        emitEvent({ type: 'turn_start' });

        expect(pendingLocalIds).toEqual([]);
        expect(session.client.emitMessagesConsumed).toHaveBeenCalledWith(['id-turn-1'], undefined);
    });

    it('regression: agent_start + turn_start in one turn drains exactly one localId', () => {
        // Pi emits agent_start then turn_start back-to-back per prompt.
        // Only turn_start should drain — agent_start must not.
        const transport = createMockTransport();
        const pendingLocalIds = ['prompt-1'];
        wireTransportEvents(transport, session, pendingLocalIds);

        emitEvent({ type: 'agent_start' });
        emitEvent({ type: 'turn_start' });

        expect(pendingLocalIds).toEqual([]);
        // Exactly one drain call with a real id — never an undefined.
        expect(session.client.emitMessagesConsumed).toHaveBeenCalledTimes(1);
        expect(session.client.emitMessagesConsumed).toHaveBeenCalledWith(['prompt-1'], undefined);
    });

    it('publishes authoritative context usage after turn_end stats resolve', async () => {
        const transport = createMockTransport();
        wireTransportEvents(transport, session, []);

        session.piIsStreaming = true;
        emitEvent({
            type: 'turn_end',
            message: {
                usage: { input: 100, output: 200, cacheRead: 10, cacheWrite: 5, totalTokens: 315 },
                stopReason: 'stop',
            },
        });

        expect(session.piIsStreaming).toBe(false);
        expect(session.client.sendAgentMessage).not.toHaveBeenCalled();
        const command = getSentCommand(transport);
        expect(command).toMatchObject({ type: 'get_session_stats' });

        emitEvent({
            type: 'response',
            id: command.id,
            command: 'get_session_stats',
            success: true,
            data: { contextUsage: { tokens: 342, contextWindow: 200_000 } },
        });

        await vi.waitFor(() => {
            expect(session.client.sendAgentMessage).toHaveBeenCalledWith({
                type: 'usage',
                inputTokens: 100,
                outputTokens: 200,
                totalTokens: 315,
                cacheReadTokens: 10,
                contextTokens: 342,
                contextWindow: 200_000,
            });
        });
    });

    it('silently falls back to turn totalTokens when stats are unsupported', async () => {
        const transport = createMockTransport();
        wireTransportEvents(transport, session, []);

        emitEvent({
            type: 'turn_end',
            message: {
                usage: { input: 100, output: 200, cacheRead: 10, cacheWrite: 5, totalTokens: 315 },
            },
        });
        const command = getSentCommand(transport);

        emitEvent({
            type: 'response',
            id: command.id,
            command: 'get_session_stats',
            success: false,
            error: 'Unknown command',
        });

        await vi.waitFor(() => {
            expect(session.client.sendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({
                type: 'usage',
                contextTokens: 315,
            }));
        });
        expect(session.client.sendSessionEvent).not.toHaveBeenCalled();
    });

    it('falls back to turn totalTokens when stats time out', async () => {
        vi.useFakeTimers();
        try {
            const transport = createMockTransport();
            wireTransportEvents(transport, session, []);

            emitEvent({
                type: 'turn_end',
                message: {
                    usage: { input: 100, output: 200, cacheRead: 10, cacheWrite: 5, totalTokens: 315 },
                },
            });

            expect(session.client.sendAgentMessage).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1_000);

            expect(session.client.sendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({
                type: 'usage',
                contextTokens: 315,
            }));
        } finally {
            vi.useRealTimers();
        }
    });

    it('discards a stats response from an older completed turn', async () => {
        const transport = createMockTransport();
        wireTransportEvents(transport, session, []);

        emitEvent({
            type: 'turn_end',
            message: {
                usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30 },
            },
        });
        emitEvent({
            type: 'turn_end',
            message: {
                usage: { input: 40, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 90 },
            },
        });

        const olderCommand = getSentCommand(transport, 0);
        const latestCommand = getSentCommand(transport, 1);
        emitEvent({
            type: 'response',
            id: latestCommand.id,
            command: 'get_session_stats',
            success: true,
            data: { contextUsage: { tokens: 120, contextWindow: 200_000 } },
        });

        await vi.waitFor(() => {
            expect(session.client.sendAgentMessage).toHaveBeenCalledTimes(1);
        });
        expect(session.client.sendAgentMessage).toHaveBeenLastCalledWith(expect.objectContaining({
            contextTokens: 120,
        }));

        emitEvent({
            type: 'response',
            id: olderCommand.id,
            command: 'get_session_stats',
            success: true,
            data: { contextUsage: { tokens: 45, contextWindow: 200_000 } },
        });
        await Promise.resolve();

        expect(session.client.sendAgentMessage).toHaveBeenCalledTimes(1);
    });

    it('handles agent_end — stops streaming', () => {
        const transport = createMockTransport();
        wireTransportEvents(transport, session, []);

        session.piIsStreaming = true;
        emitEvent({ type: 'agent_end' });

        expect(session.piIsStreaming).toBe(false);
    });

    it('handles get_available_models response — caches models', () => {
        const transport = createMockTransport();
        wireTransportEvents(transport, session, []);

        emitEvent({
            type: 'response',
            command: 'get_available_models',
            success: true,
            data: {
                models: [
                    { id: 'gpt-4o', provider: 'openai' },
                    { id: 'claude-3', provider: 'anthropic' },
                ],
            },
        });

        expect(session.cachedPiModels).toEqual([
            { provider: 'openai', modelId: 'gpt-4o' },
            { provider: 'anthropic', modelId: 'claude-3' },
        ]);
    });

    it('handles get_commands response — caches commands', () => {
        const transport = createMockTransport();
        wireTransportEvents(transport, session, []);

        emitEvent({
            type: 'response',
            command: 'get_commands',
            success: true,
            data: {
                commands: [
                    { name: 'analyze', source: 'skill' },
                ],
            },
        });

        expect(session.cachedPiCommands).toEqual([
            { name: 'analyze', source: 'skill' },
        ]);
    });

    it('handles keep_alive — no side effects', () => {
        const transport = createMockTransport();
        wireTransportEvents(transport, session, []);

        session.piIsStreaming = false;
        emitEvent({ type: 'keep_alive' });

        // keep_alive should not trigger any session mutations
        expect(session.client.sendAgentMessage).not.toHaveBeenCalled();
        expect(session.piIsStreaming).toBe(false);
    });

    it('handles set_model response — updates model and provider', () => {
        const transport = createMockTransport();
        wireTransportEvents(transport, session, []);

        emitEvent({
            type: 'response',
            command: 'set_model',
            success: true,
            data: { modelId: 'new-model', provider: 'new-provider' },
        });

        expect(session.currentModel).toBe('new-model');
        expect(session.currentProvider).toBe('new-provider');
    });
});

// --- sendPiRpcAndWait (contract: await <-> resolve symmetry) ---
//
// SetSessionConfig awaits set_model and set_thinking_level. Fix #9 was caused
// by a switch branch that updated state but never resolved the pending RPC -
// the promise hit the 10s timeout and /sessions/:id/model returned 409 even
// though Pi accepted the change. These tests pin the contract: every awaited
// command must resolve before the timeout when Pi emits a success response.

describe('sendPiRpcAndWait', () => {
    it('throws synchronously when resolver not initialized', () => {
        // sendPiRpcAndWait is a sync wrapper (not async), so the guard at
        // loop.ts throws before a promise is created — assert with toThrow,
        // not rejects.
        const mockTransport = { send: vi.fn(), onEvent: vi.fn() } as unknown as PiTransport;
        const session = createMockSession();
        // No wireTransportEvents -> resolver is null
        expect(() => sendPiRpcAndWait(session, mockTransport, { type: 'test' }, 100))
            .toThrow('Pi RPC resolver not initialized');
    });

    // Helper: a transport whose send() captures the outgoing id so the test can
    // emit the matching response, simulating Pi's reply.
    function recordingTransport(onEventHandlers: Map<string, (...args: unknown[]) => void>) {
        const sent: Array<Record<string, unknown>> = [];
        return {
            transport: {
                onEvent: vi.fn((handler) => { onEventHandlers.set('event', handler); }),
                send: vi.fn((msg: Record<string, unknown>) => { sent.push(msg); }),
            } as unknown as PiTransport,
            sent,
            // Emit the Pi response for the last sent command, echoing its id.
            reply(response: { command: string; success: boolean; data?: unknown; error?: string }) {
                const last = sent[sent.length - 1];
                const handler = onEventHandlers.get('event');
                expect(handler).toBeDefined();
                handler!({ type: 'response', id: last.id, ...response });
            },
        };
    }

    it('set_model response resolves the awaited promise before timeout', async () => {
        const handlers = new Map<string, (...args: unknown[]) => void>();
        const { transport, reply } = recordingTransport(handlers);
        const session = createMockSession();
        wireTransportEvents(transport, session, []);

        const promise = sendPiRpcAndWait(session, transport, {
            type: 'set_model', provider: 'openai', modelId: 'gpt-4o',
        }, 10_000);

        // Simulate Pi confirming the model change.
        reply({ command: 'set_model', success: true, data: { modelId: 'gpt-4o', provider: 'openai' } });

        // Must resolve (not reject with 'timed out') - the contract Fix #9 restored.
        await expect(promise).resolves.toEqual({ modelId: 'gpt-4o', provider: 'openai' });
        expect(session.currentModel).toBe('gpt-4o');
        expect(session.currentProvider).toBe('openai');
    });

    it('set_thinking_level response resolves the awaited promise before timeout', async () => {
        // Fix #9 symmetry: set_thinking_level is awaited by SetSessionConfig.
        // Without an explicit resolve it fell to the `default` branch; if anyone
        // later adds business logic to a new case without resolving first, the
        // effort switch would time out and /sessions/:id/effort would 409.
        const handlers = new Map<string, (...args: unknown[]) => void>();
        const { transport, reply } = recordingTransport(handlers);
        const session = createMockSession();
        wireTransportEvents(transport, session, []);

        const promise = sendPiRpcAndWait(session, transport, {
            type: 'set_thinking_level', level: 'high',
        }, 10_000);

        reply({ command: 'set_thinking_level', success: true });

        await expect(promise).resolves.toBeUndefined();
    });

    it('get_available_models response resolves the awaited promise before timeout', async () => {
        const handlers = new Map<string, (...args: unknown[]) => void>();
        const { transport, reply } = recordingTransport(handlers);
        const session = createMockSession();
        wireTransportEvents(transport, session, []);

        const promise = sendPiRpcAndWait(session, transport, { type: 'get_available_models' }, 10_000);

        reply({ command: 'get_available_models', success: true, data: { models: [{ id: 'gpt-4o', provider: 'openai' }] } });

        await expect(promise).resolves.toEqual({ models: [{ id: 'gpt-4o', provider: 'openai' }] });
    });

    it('Pi error response rejects the awaited promise', async () => {
        // SetSessionConfig awaits so a rejected set_model bubbles up to the web
        // request (409) instead of reporting success while Pi kept old state.
        const handlers = new Map<string, (...args: unknown[]) => void>();
        const { transport, reply } = recordingTransport(handlers);
        const session = createMockSession();
        wireTransportEvents(transport, session, []);

        const promise = sendPiRpcAndWait(session, transport, {
            type: 'set_model', provider: 'bad', modelId: 'nope',
        }, 10_000);

        reply({ command: 'set_model', success: false, error: 'Unknown provider: bad' });

        await expect(promise).rejects.toThrow('Unknown provider: bad');
    });

    it('rejects with timeout when Pi never responds', async () => {
        const handlers = new Map<string, (...args: unknown[]) => void>();
        const { transport } = recordingTransport(handlers);
        const session = createMockSession();
        wireTransportEvents(transport, session, []);

        // No reply emitted -> must time out (guards against hangs).
        await expect(sendPiRpcAndWait(session, transport, { type: 'test' }, 100))
            .rejects.toThrow('timed out');
    });
});

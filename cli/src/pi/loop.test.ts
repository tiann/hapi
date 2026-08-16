import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parsePiModels, parsePiCommands, parsePiContextUsage, PiRpcTimeoutError, sendPiRpcAndWait, wireTransportEvents } from './loop';
import type { PiResponseEvent } from './types';
import { PiSession } from './session';
import { PiTransport } from './piTransport';
import { PiConversationHistory } from './conversationHistory';
import type { PiThinkingLevel } from './types';
import { PiAgentEventSchema } from './schemas';

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
            flush = vi.fn(() => []);
        },
    };
});

function createMockSession(model?: string): PiSession {
    return new PiSession({
        api: {} as any,
        client: {
            keepAlive: vi.fn(),
            updateMetadata: vi.fn(),
            sendAgentMessage: vi.fn(),
            emitMessagesConsumed: vi.fn(),
            sendSessionEvent: vi.fn(),
            updateAgentState: vi.fn(),
            emitSessionReady: vi.fn(),
            getMetadata: vi.fn(() => null),
            rpcHandlerManager: { registerHandler: vi.fn() },
        } as any,
        path: '/tmp/test',
        logPath: '/tmp/test.log',
        startedBy: 'terminal',
        startingMode: 'local',
        model,
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

describe('Pi lifecycle event normalization', () => {
    it('normalizes legacy auto_compaction aliases with lifecycle defaults at the transport boundary', () => {
        expect(PiAgentEventSchema.parse({ type: 'auto_compaction_start' })).toMatchObject({
            type: 'compaction_start',
            reason: 'threshold',
        });
        expect(PiAgentEventSchema.parse({ type: 'auto_compaction_end' })).toMatchObject({
            type: 'compaction_end',
            reason: 'threshold',
            aborted: false,
            willRetry: false,
        });
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
        expect(session.client.emitSessionReady).toHaveBeenCalledTimes(1);
    });

    it('syncs a native sessionName from get_state as the HAPI title', () => {
        const transport = createMockTransport();
        wireTransportEvents(transport, session, []);

        emitEvent({
            type: 'response',
            command: 'get_state',
            success: true,
            data: { sessionName: '  Native Pi Title  ' },
        });

        expect(session.client.updateMetadata).toHaveBeenCalledTimes(1);
        const updateMetadata = session.client.updateMetadata as ReturnType<typeof vi.fn>;
        expect(updateMetadata.mock.calls[0]![0]({ path: '/tmp/test', host: 'localhost' })).toMatchObject({
            summary: { text: 'Native Pi Title' },
        });
    });

    it('syncs a live native rename from session_info_changed as the HAPI title', () => {
        const transport = createMockTransport();
        wireTransportEvents(transport, session, []);

        emitEvent({ type: 'session_info_changed', name: 'Renamed Pi Session' });

        expect(session.client.updateMetadata).toHaveBeenCalledTimes(1);
        const updateMetadata = session.client.updateMetadata as ReturnType<typeof vi.fn>;
        expect(updateMetadata.mock.calls[0]![0]({ path: '/tmp/test', host: 'localhost' })).toMatchObject({
            summary: { text: 'Renamed Pi Session' },
        });
    });

    it('dedupes identical native titles across get_state and session_info_changed', () => {
        const transport = createMockTransport();
        wireTransportEvents(transport, session, []);

        emitEvent({
            type: 'response',
            command: 'get_state',
            success: true,
            data: { sessionName: 'Same Title' },
        });
        emitEvent({ type: 'session_info_changed', name: 'Same Title' });

        expect(session.client.updateMetadata).toHaveBeenCalledTimes(1);
    });

    it('ignores malformed or empty session_info_changed events', () => {
        const transport = createMockTransport();
        wireTransportEvents(transport, session, []);

        emitEvent({ type: 'session_info_changed' });
        emitEvent({ type: 'session_info_changed', name: '   ' });

        expect(session.client.updateMetadata).not.toHaveBeenCalled();
    });

    it('marks session ready on get_state response (drains buffered sends) — issue #1143', () => {
        const transport = createMockTransport();
        wireTransportEvents(transport, session, []);

        // A prompt buffered before Pi finished startup must not run yet.
        const buffered = vi.fn();
        session.runWhenReady(buffered);
        expect(buffered).not.toHaveBeenCalled();
        expect(session.isReady).toBe(false);

        emitEvent({
            type: 'response',
            command: 'get_state',
            success: true,
            data: { sessionId: 'pi-session-ready' },
        });

        // get_state landing is the ready signal — buffered work drains.
        expect(session.isReady).toBe(true);
        expect(buffered).toHaveBeenCalledTimes(1);
        expect(session.client.emitSessionReady).toHaveBeenCalledTimes(1);
    });

    it('marks session ready on get_state even when sessionId is absent', () => {
        // Robustness: readiness must not hinge on Pi always echoing sessionId,
        // otherwise a missing field would buffer prompts forever.
        const transport = createMockTransport();
        wireTransportEvents(transport, session, []);

        emitEvent({ type: 'response', command: 'get_state', success: true, data: {} });

        expect(session.isReady).toBe(true);
        expect(session.client.emitSessionReady).toHaveBeenCalledTimes(1);
    });

    it('keeps a fresh Pi get_state failure non-fatal for startup fallback compatibility', () => {
        const transport = createMockTransport();
        const onStartupFailure = vi.fn();
        wireTransportEvents(transport, session, [], { onStartupFailure });

        emitEvent({
            type: 'response',
            command: 'get_state',
            success: false,
            error: 'No session found matching pi-session-404',
        });

        expect(onStartupFailure).not.toHaveBeenCalled();
        expect(session.client.emitSessionReady).not.toHaveBeenCalled();
    });

    it('keeps malformed get_state data non-fatal for a fresh Pi session', () => {
        const transport = createMockTransport();
        const onStartupFailure = vi.fn();
        wireTransportEvents(transport, session, [], { onStartupFailure });

        emitEvent({
            type: 'response',
            command: 'get_state',
            success: true,
            data: { model: 'not-a-model-object' },
        });

        expect(onStartupFailure).not.toHaveBeenCalled();
        expect(session.isReady).toBe(false);
        expect(session.client.emitSessionReady).not.toHaveBeenCalled();
    });

    it('fails a native resume when get_state returns malformed data', () => {
        const expectedSession = new PiSession({
            api: {} as any,
            client: {
                keepAlive: vi.fn(),
                updateMetadata: vi.fn(),
                sendAgentMessage: vi.fn(),
                emitMessagesConsumed: vi.fn(),
                sendSessionEvent: vi.fn(),
                emitSessionReady: vi.fn(),
                getMetadata: vi.fn(() => null),
                rpcHandlerManager: { registerHandler: vi.fn() },
            } as any,
            path: '/tmp/test',
            logPath: '/tmp/test.log',
            startedBy: 'terminal',
            startingMode: 'local',
            expectedNativeSessionId: 'pi-session-requested',
        });
        const transport = createMockTransport();
        const onStartupFailure = vi.fn();
        wireTransportEvents(transport, expectedSession, [], { onStartupFailure });

        emitEvent({
            type: 'response',
            command: 'get_state',
            success: true,
            data: { model: 'not-a-model-object' },
        });

        expect(onStartupFailure).toHaveBeenCalledTimes(1);
        expect((onStartupFailure.mock.calls[0][0] as Error).message).toContain('malformed state data');
        expect(expectedSession.isReady).toBe(false);
        expect(expectedSession.client.emitSessionReady).not.toHaveBeenCalled();
        expect(expectedSession.client.updateMetadata).not.toHaveBeenCalled();
    });

    it('rejects a resume get_state response with a missing session ID before mutating state', () => {
        const expectedSession = new PiSession({
            api: {} as any,
            client: {
                keepAlive: vi.fn(),
                updateMetadata: vi.fn(),
                sendAgentMessage: vi.fn(),
                emitMessagesConsumed: vi.fn(),
                sendSessionEvent: vi.fn(),
                emitSessionReady: vi.fn(),
                getMetadata: vi.fn(() => null),
                rpcHandlerManager: { registerHandler: vi.fn() },
            } as any,
            path: '/tmp/test',
            logPath: '/tmp/test.log',
            startedBy: 'terminal',
            startingMode: 'local',
            expectedNativeSessionId: 'pi-session-requested',
        });
        const transport = createMockTransport();
        const onStartupFailure = vi.fn();
        wireTransportEvents(transport, expectedSession, [], { onStartupFailure });

        emitEvent({
            type: 'response',
            command: 'get_state',
            success: true,
            data: {
                model: { modelId: 'wrong-model', provider: 'wrong-provider' },
                thinkingLevel: 'high',
            },
        });

        expect(onStartupFailure).toHaveBeenCalledTimes(1);
        expect((onStartupFailure.mock.calls[0][0] as Error).message)
            .toContain('unexpected native session (missing)');
        expect(expectedSession.client.emitSessionReady).not.toHaveBeenCalled();
        expect(expectedSession.client.updateMetadata).not.toHaveBeenCalled();
        expect(expectedSession.currentModel).toBeUndefined();
        expect(expectedSession.currentThinkingLevel).toBeUndefined();
    });

    it('rejects a resume get_state response for a different session before metadata is published', () => {
        const expectedSession = new PiSession({
            api: {} as any,
            client: {
                keepAlive: vi.fn(),
                updateMetadata: vi.fn(),
                sendAgentMessage: vi.fn(),
                emitMessagesConsumed: vi.fn(),
                sendSessionEvent: vi.fn(),
                emitSessionReady: vi.fn(),
                getMetadata: vi.fn(() => null),
                rpcHandlerManager: { registerHandler: vi.fn() },
            } as any,
            path: '/tmp/test',
            logPath: '/tmp/test.log',
            startedBy: 'terminal',
            startingMode: 'local',
            expectedNativeSessionId: 'pi-session-requested',
        });
        const transport = createMockTransport();
        const onStartupFailure = vi.fn();
        wireTransportEvents(transport, expectedSession, [], { onStartupFailure });

        emitEvent({
            type: 'response',
            command: 'get_state',
            success: true,
            data: {
                sessionId: 'pi-session-other',
                model: { modelId: 'wrong-model', provider: 'wrong-provider' },
            },
        });

        expect(onStartupFailure).toHaveBeenCalledTimes(1);
        expect((onStartupFailure.mock.calls[0][0] as Error).message)
            .toContain('unexpected native session pi-session-other');
        expect(expectedSession.client.emitSessionReady).not.toHaveBeenCalled();
        expect(expectedSession.client.updateMetadata).not.toHaveBeenCalled();
        expect(expectedSession.currentModel).toBeUndefined();
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

    it('observes each agent lifecycle start without settling the prompt', () => {
        const transport = createMockTransport();
        const onAgentLifecycleStarted = vi.fn();
        const onAgentSettled = vi.fn();
        wireTransportEvents(transport, session, [], { onAgentLifecycleStarted, onAgentSettled });

        emitEvent({ type: 'agent_start' });
        emitEvent({ type: 'turn_start' });

        expect(onAgentLifecycleStarted).toHaveBeenCalledTimes(2);
        expect(onAgentSettled).not.toHaveBeenCalled();
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

        expect(session.piIsStreaming).toBe(true);
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
                cacheCreationTokens: 5,
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

    it('handles agent_settled — stops streaming after an agent_end grace window', () => {
        const transport = createMockTransport();
        wireTransportEvents(transport, session, []);

        session.piIsStreaming = true;
        emitEvent({ type: 'agent_start' });
        emitEvent({ type: 'agent_end' });
        expect(session.piIsStreaming).toBe(true);
        emitEvent({ type: 'agent_settled' });
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

    it('settles the startup-model gate when discovery returns no models', async () => {
        session = createMockSession('startup-model');
        const transport = createMockTransport();
        wireTransportEvents(transport, session, []);

        emitEvent({
            type: 'response',
            command: 'get_available_models',
            success: true,
            data: { models: [] },
        });

        await expect(session.startupModelSettled).resolves.toBeUndefined()
        expect(transport.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'set_model' }))
    })

    it('settles the startup-model gate when model discovery fails', async () => {
        session = createMockSession('startup-model');
        const transport = createMockTransport();
        wireTransportEvents(transport, session, []);

        emitEvent({
            type: 'response',
            command: 'get_available_models',
            success: false,
            error: 'models unavailable',
        });

        await expect(session.startupModelSettled).resolves.toBeUndefined()
    })

    it('fails closed and poisons the mutation lease when the detached startup model times out', async () => {
        vi.useFakeTimers();
        try {
            session = createMockSession('startup-model');
            const transport = createMockTransport();
            const onStartupFailure = vi.fn();
            wireTransportEvents(transport, session, [], { onStartupFailure });

            emitEvent({
                type: 'response',
                command: 'get_available_models',
                success: true,
                data: { models: [{ id: 'startup-model', provider: 'provider' }] },
            });
            await vi.advanceTimersByTimeAsync(0);
            expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({
                type: 'set_model', provider: 'provider', modelId: 'startup-model',
            }));

            await vi.advanceTimersByTimeAsync(10_000);
            await vi.waitFor(() => expect(onStartupFailure).toHaveBeenCalledWith(expect.objectContaining({
                message: expect.stringContaining('startup model outcome is indeterminate'),
            })));
            let secondMutationStarted = false;
            void session.runRuntimeMutation(async () => { secondMutationStarted = true; });
            await vi.advanceTimersByTimeAsync(0);
            expect(secondMutationStarted).toBe(false);
        } finally {
            vi.useRealTimers();
        }
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

    it('steer response resolves its matching RPC without changing the main thinking state', async () => {
        const handlers = new Map<string, (...args: unknown[]) => void>();
        const { transport, reply } = recordingTransport(handlers);
        const session = createMockSession();
        session.updateThinkingState(true);
        wireTransportEvents(transport, session, []);

        const promise = sendPiRpcAndWait(session, transport, {
            type: 'steer', message: 'redirect current work', images: [],
        }, 10_000);
        reply({ command: 'steer', success: true });

        await expect(promise).resolves.toBeUndefined();
        expect(session.piIsStreaming).toBe(true);
    });

    it('does not double-report a matching steer failure outside its dispatcher', async () => {
        const handlers = new Map<string, (...args: unknown[]) => void>();
        const { transport, reply } = recordingTransport(handlers);
        const session = createMockSession();
        wireTransportEvents(transport, session, []);

        const promise = sendPiRpcAndWait(session, transport, { type: 'steer', message: 'reject me' }, 10_000);
        reply({ command: 'steer', success: false, error: 'native steer rejected' });

        await expect(promise).rejects.toThrow('native steer rejected');
        expect(session.client.sendSessionEvent).not.toHaveBeenCalled();
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

    it('rejects with a typed timeout when Pi never responds', async () => {
        const handlers = new Map<string, (...args: unknown[]) => void>();
        const { transport } = recordingTransport(handlers);
        const session = createMockSession();
        wireTransportEvents(transport, session, []);

        // No reply emitted -> must time out (guards against hangs).
        const pending = sendPiRpcAndWait(session, transport, { type: 'test' }, 100);
        await expect(pending).rejects.toBeInstanceOf(PiRpcTimeoutError);
        await expect(pending)
            .rejects.toMatchObject({
                name: 'PiRpcTimeoutError',
                command: 'test',
                requestId: 1,
                timeoutMs: 100,
                message: 'Pi RPC test (id=1) timed out after 100ms',
            });
    });
});

describe('Pi lifecycle timeline', () => {
    it('synchronizes authoritative get_state streaming and deduplicates compaction/retry timeline events', () => {
        let listener: ((event: Record<string, unknown>) => void) | null = null;
        const transport = {
            onEvent: vi.fn((handler: (event: Record<string, unknown>) => void) => { listener = handler; }),
            send: vi.fn(),
        } as unknown as PiTransport;
        const stateSession = createMockSession();
        wireTransportEvents(transport, stateSession, []);
        const emit = (event: Record<string, unknown>) => listener?.(event);

        emit({ type: 'response', command: 'get_state', success: true, data: { isStreaming: true } });
        expect(stateSession.piIsStreaming).toBe(true);

        emit({ type: 'compaction_start', reason: 'threshold' });
        emit({ type: 'compaction_start', reason: 'threshold' });
        emit({ type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: false });
        emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: '429' });
        emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: '429' });
        emit({ type: 'auto_retry_end', attempt: 1, success: true });
        // A later compaction/retry episode with the same reason and attempt must
        // remain visible; dedupe applies only while its current episode is open.
        emit({ type: 'compaction_start', reason: 'threshold' });
        emit({ type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: false });
        emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: '429' });
        emit({ type: 'auto_retry_end', attempt: 1, success: true });
        expect(stateSession.client.sendSessionEvent).toHaveBeenCalledWith({ type: 'message', message: '📦 Compaction started' });
        expect(stateSession.client.sendSessionEvent).toHaveBeenCalledWith({ type: 'message', message: '📦 Compaction completed' });
        expect(stateSession.client.sendSessionEvent).toHaveBeenCalledTimes(8);

        // Nested maintenance remains active until each own terminal event.
        emit({ type: 'compaction_start', reason: 'manual' });
        emit({ type: 'summarization_retry_scheduled', attempt: 1, maxAttempts: 2, delayMs: 1, errorMessage: 'x' });
        emit({ type: 'summarization_retry_finished' });
        emit({ type: 'agent_end', willRetry: false });
        expect(stateSession.piIsStreaming).toBe(true);
        emit({ type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false });
    });

    it('does not let a delayed get_state false interrupt an active prompt lifecycle', () => {
        let listener: ((event: Record<string, unknown>) => void) | null = null;
        const transport = {
            onEvent: vi.fn((handler: (event: Record<string, unknown>) => void) => { listener = handler; }),
            send: vi.fn(),
        } as unknown as PiTransport;
        const stateSession = createMockSession();
        const controller = wireTransportEvents(transport, stateSession, []);
        const emit = (event: Record<string, unknown>) => listener?.(event);

        controller.beginPromptLifecycle('prompt-1');
        emit({ type: 'agent_start' });
        expect(stateSession.piIsStreaming).toBe(true);

        emit({ type: 'response', command: 'get_state', success: true, data: { isStreaming: false } });
        expect(stateSession.piIsStreaming).toBe(true);

        emit({ type: 'turn_start' });
        expect(stateSession.piIsStreaming).toBe(true);

        emit({ type: 'agent_end', willRetry: false });
        emit({ type: 'response', command: 'get_state', success: true, data: { isStreaming: false } });
        expect(stateSession.piIsStreaming).toBe(true);
    });

    it('still applies get_state false when no prompt lifecycle is active', () => {
        let listener: ((event: Record<string, unknown>) => void) | null = null;
        const transport = {
            onEvent: vi.fn((handler: (event: Record<string, unknown>) => void) => { listener = handler; }),
            send: vi.fn(),
        } as unknown as PiTransport;
        const stateSession = createMockSession();
        wireTransportEvents(transport, stateSession, []);
        const emit = (event: Record<string, unknown>) => listener?.(event);

        emit({ type: 'response', command: 'get_state', success: true, data: { isStreaming: true } });
        expect(stateSession.piIsStreaming).toBe(true);

        emit({ type: 'response', command: 'get_state', success: true, data: { isStreaming: false } });
        expect(stateSession.piIsStreaming).toBe(false);
    });
});

describe('Pi prompt-settlement boundaries', () => {
    it('does not release the local FIFO between tool-loop turns; only agent_end settles a prompt', () => {
        let listener: ((event: Record<string, unknown>) => void) | null = null;
        const transport = {
            onEvent: vi.fn((handler: (event: Record<string, unknown>) => void) => { listener = handler; }),
            send: vi.fn(),
        } as unknown as PiTransport;
        const onAgentSettled = vi.fn();
        const stateSession = createMockSession();
        wireTransportEvents(transport, stateSession, [], { onAgentSettled });

        listener!({ type: 'agent_start' });
        listener!({ type: 'turn_start' });
        listener!({ type: 'turn_end', message: {} });
        listener!({ type: 'turn_start' });
        listener!({ type: 'turn_end', message: {} });
        expect(stateSession.piIsStreaming).toBe(true);
        expect(onAgentSettled).not.toHaveBeenCalled();

        listener!({ type: 'agent_end', willRetry: true });
        expect(stateSession.piIsStreaming).toBe(true);
        expect(onAgentSettled).not.toHaveBeenCalled();

        listener!({ type: 'agent_end', willRetry: false });
        expect(stateSession.piIsStreaming).toBe(true);
        expect(onAgentSettled).not.toHaveBeenCalled();

        listener!({ type: 'compaction_start', reason: 'threshold' });
        listener!({ type: 'agent_settled' });
        expect(stateSession.piIsStreaming).toBe(false);
        expect(onAgentSettled).toHaveBeenCalledTimes(1);
    });
});


describe('Pi settlement compatibility fallbacks', () => {
    function setup() {
        let listener: ((event: Record<string, unknown>) => void) | null = null;
        const transport = {
            onEvent: vi.fn((handler: (event: Record<string, unknown>) => void) => { listener = handler; }),
            send: vi.fn(),
        } as unknown as PiTransport;
        const stateSession = createMockSession();
        const onAgentSettled = vi.fn();
        const onPromptLifecycleMissing = vi.fn();
        const onPromptRejected = vi.fn();
        const controller = wireTransportEvents(transport, stateSession, [], { onAgentSettled, onPromptLifecycleMissing, onPromptRejected });
        return { emit: (event: Record<string, unknown>) => listener?.(event), stateSession, onAgentSettled, onPromptLifecycleMissing, onPromptRejected, controller, transport };
    }

    it('waits for agent_settled through maintenance and uses grace only for legacy Pi', async () => {
        vi.useFakeTimers();
        const h = setup();
        h.stateSession.piIsStreaming = true;
        h.emit({ type: 'agent_start' });
        h.emit({ type: 'agent_end', willRetry: false });
        h.emit({ type: 'compaction_start', reason: 'threshold' });
        await vi.advanceTimersByTimeAsync(600);
        expect(h.onAgentSettled).not.toHaveBeenCalled();
        h.emit({ type: 'agent_settled' });
        expect(h.onAgentSettled).toHaveBeenCalledTimes(1);

        const legacy = setup();
        legacy.emit({ type: 'agent_end', willRetry: false });
        await vi.advanceTimersByTimeAsync(500);
        expect(legacy.onAgentSettled).toHaveBeenCalledTimes(1);
    });

    it('releases command-only prompts only after their lifecycle grace, while agent_start cancels it', async () => {
        vi.useFakeTimers();
        const h = setup();
        h.emit({ type: 'response', id: 'command-a', command: 'prompt', success: true });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(h.onPromptLifecycleMissing).toHaveBeenCalledTimes(1);

        const normal = setup();
        normal.emit({ type: 'response', command: 'prompt', success: true });
        normal.emit({ type: 'agent_start' });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(normal.onPromptLifecycleMissing).not.toHaveBeenCalled();
    });

    it('syncs conversation history before reporting a missing prompt lifecycle', async () => {
        vi.useFakeTimers();
        const order: string[] = [];
        let listener: ((event: Record<string, unknown>) => void) | null = null;
        const transport = {
            onEvent: vi.fn((handler: (event: Record<string, unknown>) => void) => { listener = handler; }),
            send: vi.fn(),
        } as unknown as PiTransport;
        const stateSession = createMockSession();
        const conversationHistory = {
            syncEntries: vi.fn(async () => { order.push('sync'); }),
        } as unknown as PiConversationHistory;
        const onPromptLifecycleMissing = vi.fn(() => { order.push('missing'); });
        const controller = wireTransportEvents(transport, stateSession, ['command-local'], {
            conversationHistory,
            onPromptLifecycleMissing,
        });

        controller.beginPromptLifecycle('command-a');
        listener!({ type: 'response', id: 'command-a', command: 'prompt', success: true });
        await vi.advanceTimersByTimeAsync(1_000);

        expect(conversationHistory.syncEntries).toHaveBeenCalledTimes(1);
        expect(onPromptLifecycleMissing).toHaveBeenCalledWith('command-local');
        expect(order).toEqual(['sync', 'missing']);
    });

    it('fails closed without retiring the prompt when command-only history sync fails', async () => {
        vi.useFakeTimers();
        const pendingLocalIds = ['command-local'];
        let listener: ((event: Record<string, unknown>) => void) | null = null;
        const transport = {
            onEvent: vi.fn((handler: (event: Record<string, unknown>) => void) => { listener = handler; }),
            send: vi.fn(),
        } as unknown as PiTransport;
        const stateSession = createMockSession();
        const conversationHistory = {
            syncEntries: vi.fn(async () => { throw new Error('temporary get_entries failure'); }),
        } as unknown as PiConversationHistory;
        const onPromptLifecycleMissing = vi.fn();
        const onStartupFailure = vi.fn();
        const controller = wireTransportEvents(transport, stateSession, pendingLocalIds, {
            conversationHistory,
            onPromptLifecycleMissing,
            onStartupFailure,
        });

        controller.beginPromptLifecycle('command-a');
        listener!({ type: 'response', id: 'command-a', command: 'prompt', success: true });
        await vi.advanceTimersByTimeAsync(1_000);

        expect(onStartupFailure).toHaveBeenCalledWith(expect.objectContaining({
            message: 'Pi command-only history sync failed: temporary get_entries failure',
        }));
        expect(onPromptLifecycleMissing).not.toHaveBeenCalled();
        expect(pendingLocalIds).toEqual(['command-local']);
    });

    it('uses a fresh generation for consecutive command-only prompts', async () => {
        vi.useFakeTimers();
        const h = setup();
        h.controller.beginPromptLifecycle('command-a');
        h.emit({ type: 'response', id: 'command-a', command: 'prompt', success: true });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(h.onPromptLifecycleMissing).toHaveBeenCalledTimes(1);

        h.controller.beginPromptLifecycle('command-b');
        h.emit({ type: 'response', id: 'command-b', command: 'prompt', success: true });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(h.onPromptLifecycleMissing).toHaveBeenCalledTimes(2);

        // A late settled event belongs to no current agent lifecycle and cannot
        // cause a third settlement for the command-only generation.
        h.emit({ type: 'agent_settled' });
        expect(h.onAgentSettled).not.toHaveBeenCalled();
    });

    it('settles an autonomous agent lifecycle that starts after the previous prompt already settled', () => {
        const h = setup();

        // A normal prompt lifecycle runs to settlement.
        h.controller.beginPromptLifecycle('prompt-1');
        h.emit({ type: 'response', id: 'prompt-1', command: 'prompt', success: true });
        h.emit({ type: 'agent_start' });
        h.emit({ type: 'agent_end', willRetry: false });
        h.emit({ type: 'agent_settled' });
        expect(h.onAgentSettled).toHaveBeenCalledTimes(1);
        expect(h.stateSession.piIsStreaming).toBe(false);

        // Pi wakes up on its own (subagent completion, scheduled work) with no
        // HAPI prompt in flight. Its settlement must not be swallowed by the
        // already-delivered previous cycle, or thinking stays true forever.
        h.emit({ type: 'agent_start' });
        expect(h.stateSession.piIsStreaming).toBe(true);
        h.emit({ type: 'agent_end', willRetry: false });
        h.emit({ type: 'agent_settled' });
        expect(h.onAgentSettled).toHaveBeenCalledTimes(2);
        expect(h.stateSession.piIsStreaming).toBe(false);
    });

    it('settles an autonomous agent lifecycle through the legacy agent_end grace when agent_settled never arrives', async () => {
        vi.useFakeTimers();
        const h = setup();

        h.controller.beginPromptLifecycle('prompt-1');
        h.emit({ type: 'response', id: 'prompt-1', command: 'prompt', success: true });
        h.emit({ type: 'agent_start' });
        h.emit({ type: 'agent_end', willRetry: false });
        h.emit({ type: 'agent_settled' });
        expect(h.onAgentSettled).toHaveBeenCalledTimes(1);

        h.emit({ type: 'agent_start' });
        expect(h.stateSession.piIsStreaming).toBe(true);
        h.emit({ type: 'agent_end', willRetry: false });
        await vi.advanceTimersByTimeAsync(500);
        expect(h.onAgentSettled).toHaveBeenCalledTimes(2);
        expect(h.stateSession.piIsStreaming).toBe(false);
    });

    it('does not let a stale in-flight settlement callback settle a newly started autonomous lifecycle', async () => {
        let listener: ((event: Record<string, unknown>) => void) | null = null;
        const transport = {
            onEvent: vi.fn((handler: (event: Record<string, unknown>) => void) => { listener = handler; }),
            send: vi.fn(),
        } as unknown as PiTransport;
        const stateSession = createMockSession();
        const onAgentSettled = vi.fn();
        let releaseSync: (() => void) | null = null;
        const conversationHistory = {
            syncEntries: vi.fn(() => new Promise<void>((resolve) => { releaseSync = resolve; })),
            observeEntry: vi.fn(),
        } as unknown as PiConversationHistory;
        const controller = wireTransportEvents(transport, stateSession, [], { onAgentSettled, conversationHistory });
        const emit = (event: Record<string, unknown>) => listener?.(event);

        controller.beginPromptLifecycle('prompt-1');
        emit({ type: 'response', id: 'prompt-1', command: 'prompt', success: true });
        emit({ type: 'agent_start' });
        emit({ type: 'agent_end', willRetry: false });
        emit({ type: 'agent_settled' });
        // Settlement delivered, but its history sync (and therefore the
        // onAgentSettled notification) is still in flight.
        expect(onAgentSettled).not.toHaveBeenCalled();

        // Pi wakes up autonomously before the sync completes.
        emit({ type: 'agent_start' });
        expect(stateSession.piIsStreaming).toBe(true);

        // The stale callback resolves now — it must not settle the new
        // lifecycle's boundary.
        releaseSync!();
        await Promise.resolve();
        await Promise.resolve();
        expect(onAgentSettled).not.toHaveBeenCalled();

        // The autonomous lifecycle settles through its own events.
        emit({ type: 'agent_end', willRetry: false });
        emit({ type: 'agent_settled' });
        releaseSync!();
        await Promise.resolve();
        await Promise.resolve();
        expect(onAgentSettled).toHaveBeenCalledTimes(1);
        expect(stateSession.piIsStreaming).toBe(false);
    });

    it('rejects a matching prompt after turn_start already consumed its local ID', async () => {
        vi.useFakeTimers();
        const pendingLocalIds = ['local-a'];
        let listener: ((event: Record<string, unknown>) => void) | null = null;
        const transport = {
            onEvent: vi.fn((handler: (event: Record<string, unknown>) => void) => { listener = handler; }),
            send: vi.fn(),
        } as unknown as PiTransport;
        const stateSession = createMockSession();
        const onPromptRejected = vi.fn();
        const onPromptLifecycleMissing = vi.fn();
        const controller = wireTransportEvents(transport, stateSession, pendingLocalIds, {
            onPromptRejected,
            onPromptLifecycleMissing,
        });

        controller.beginPromptLifecycle('prompt-a');
        listener!({ type: 'agent_start' });
        listener!({ type: 'turn_start' });
        expect(pendingLocalIds).toEqual([]);

        listener!({ type: 'response', id: 'prompt-a', command: 'prompt', success: false, error: 'rejected' });
        expect(onPromptRejected).toHaveBeenCalledTimes(1);
        expect(onPromptRejected).toHaveBeenCalledWith('local-a');
        expect(stateSession.piIsStreaming).toBe(false);

        // The failed generation owns no delayed lifecycle work. It must not
        // later report lifecycle-missing or reject again.
        await vi.advanceTimersByTimeAsync(1_000);
        expect(onPromptLifecycleMissing).not.toHaveBeenCalled();
        listener!({ type: 'response', id: 'prompt-a', command: 'prompt', success: false, error: 'duplicate' });
        expect(onPromptRejected).toHaveBeenCalledTimes(1);

        controller.beginPromptLifecycle('prompt-b');
        stateSession.updateThinkingState(true);
        listener!({ type: 'response', id: 'prompt-a', command: 'prompt', success: false, error: 'stale' });
        expect(stateSession.piIsStreaming).toBe(true);
        expect(onPromptRejected).toHaveBeenCalledTimes(1);
    });

    it('blocks legacy auto compaction until it ends before using the legacy settlement grace', async () => {
        vi.useFakeTimers();
        const h = setup();
        h.stateSession.piIsStreaming = true;
        h.emit({ type: 'agent_start' });
        h.emit({ type: 'agent_end', willRetry: false });
        h.emit({ type: 'auto_compaction_start', reason: 'threshold' });

        await vi.advanceTimersByTimeAsync(600);
        expect(h.onAgentSettled).not.toHaveBeenCalled();
        expect(h.stateSession.client.sendSessionEvent).toHaveBeenCalledWith({ type: 'message', message: '📦 Compaction started' });

        h.emit({ type: 'auto_compaction_end', reason: 'threshold', aborted: false, willRetry: false });
        await vi.advanceTimersByTimeAsync(499);
        expect(h.onAgentSettled).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(h.onAgentSettled).toHaveBeenCalledTimes(1);
        expect(h.stateSession.client.sendSessionEvent).toHaveBeenCalledWith({ type: 'message', message: '📦 Compaction completed' });
    });

    it('keeps the settlement gate closed across a compaction retry', async () => {
        vi.useFakeTimers();
        const h = setup();
        h.stateSession.piIsStreaming = true;
        h.emit({ type: 'agent_start' });
        h.emit({ type: 'agent_end', willRetry: false });
        h.emit({ type: 'compaction_start', reason: 'threshold' });
        h.emit({ type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: true });

        await vi.advanceTimersByTimeAsync(600);
        expect(h.onAgentSettled).not.toHaveBeenCalled();

        h.emit({ type: 'agent_start' });
        h.emit({ type: 'agent_end', willRetry: false });
        await vi.advanceTimersByTimeAsync(499);
        expect(h.onAgentSettled).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(h.onAgentSettled).toHaveBeenCalledTimes(1);
    });

    it('uses a bounded fallback when a compaction retry never starts', async () => {
        vi.useFakeTimers();
        const h = setup();
        h.stateSession.piIsStreaming = true;
        h.emit({ type: 'agent_start' });
        h.emit({ type: 'agent_end', willRetry: false });
        h.emit({ type: 'compaction_start', reason: 'threshold' });
        h.emit({ type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: true });

        await vi.advanceTimersByTimeAsync(1_499);
        expect(h.onAgentSettled).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(h.onAgentSettled).toHaveBeenCalledTimes(1);
    });

    it('rejects all pending RPCs immediately during transport termination', async () => {
        const h = setup();
        const pending = sendPiRpcAndWait(h.stateSession, h.transport, { type: 'abort' }, 10_000);
        h.controller.terminatePendingRpc(new Error('transport closed'));
        h.controller.terminatePendingRpc(new Error('transport closed again'));
        await expect(pending).rejects.toThrow('transport closed');
        await expect(sendPiRpcAndWait(h.stateSession, h.transport, { type: 'abort' }, 10_000)).rejects.toThrow('transport closed');
        expect(h.transport.send).toHaveBeenCalledTimes(1);
    });
});

describe('Pi abort UI lifecycle', () => {
    it('cancels pending extension input and ignores late prompt lifecycle events after abort', async () => {
        let listener: ((event: Record<string, unknown>) => void) | null = null;
        const transport = {
            onEvent: vi.fn((handler: (event: Record<string, unknown>) => void) => { listener = handler; }),
            send: vi.fn(),
        } as unknown as PiTransport;
        const session = createMockSession();
        const onPromptLifecycleMissing = vi.fn();
        const controller = wireTransportEvents(transport, session, [], { onPromptLifecycleMissing });
        controller.beginPromptLifecycle('prompt-a');
        listener!({ type: 'extension_ui_request', id: 'ui-a', method: 'input', title: 'Need input' });
        controller.cancelPendingExtensionUi('Pi prompt aborted', { sendResponse: true });
        controller.abortPromptLifecycle();

        expect(transport.send).toHaveBeenCalledWith({ type: 'extension_ui_response', id: 'ui-a', cancelled: true });
        expect(session.client.updateAgentState).toHaveBeenCalled();
        listener!({ type: 'response', id: 'prompt-a', command: 'prompt', success: true });
        listener!({ type: 'agent_settled' });
        await Promise.resolve();
        expect(onPromptLifecycleMissing).not.toHaveBeenCalled();
    });
});

describe('Pi conversation-history transport integration', () => {
    function setup(expectedNativeSessionId?: string) {
        let listener: ((event: Record<string, unknown>) => void) | null = null;
        const transport = {
            onEvent: vi.fn((handler: (event: Record<string, unknown>) => void) => { listener = handler; }),
            send: vi.fn(),
        } as unknown as PiTransport;
        const session = new PiSession({
            api: {} as never,
            client: {
                keepAlive: vi.fn(),
                updateMetadata: vi.fn(),
                sendAgentMessage: vi.fn(),
                emitMessagesConsumed: vi.fn(),
                sendSessionEvent: vi.fn(),
                updateAgentState: vi.fn(),
                emitSessionReady: vi.fn(),
                rpcHandlerManager: { registerHandler: vi.fn() },
            } as never,
            path: '/tmp/test',
            logPath: '/tmp/test.log',
            startedBy: 'terminal',
            startingMode: 'remote',
            expectedNativeSessionId,
        });
        return {
            transport,
            session,
            emit: (event: Record<string, unknown>) => listener?.(event),
        };
    }

    it('resolves an awaited temporary get_state without publishing clone identity', async () => {
        const h = setup('source-id');
        wireTransportEvents(h.transport, h.session, []);
        const release = h.session.beginHistoryTransaction();
        const pending = sendPiRpcAndWait(h.session, h.transport, { type: 'get_state' });
        const command = (h.transport.send as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as { id: string };

        h.emit({
            type: 'response',
            id: command.id,
            command: 'get_state',
            success: true,
            data: { sessionId: 'clone-id', sessionFile: '/tmp/clone.jsonl' },
        });

        await expect(pending).resolves.toEqual({ sessionId: 'clone-id', sessionFile: '/tmp/clone.jsonl' });
        expect(h.session.client.updateMetadata).not.toHaveBeenCalled();
        expect(h.session.client.emitSessionReady).not.toHaveBeenCalled();
        release();
    });

    it('maps entry_appended events and completes the final sync before releasing the queue', async () => {
        const h = setup();
        const rpc = vi.fn(async () => ({ entries: [], leafId: null }));
        const history = new PiConversationHistory(h.session, rpc);
        history.registerUserEntry('local-1');
        const onAgentSettled = vi.fn();
        const controller = wireTransportEvents(h.transport, h.session, [], {
            conversationHistory: history,
            onAgentSettled,
        });

        h.emit({ type: 'entry_appended', entry: { id: 'entry-1', type: 'message', message: { role: 'user' } } });
        expect(history.getEntryIds()).toEqual({ 'local-1': 'entry-1' });

        controller.beginPromptLifecycle('prompt-1');
        h.emit({ type: 'response', id: 'prompt-1', command: 'prompt', success: true });
        h.emit({ type: 'agent_start' });
        h.emit({ type: 'agent_settled' });
        expect(onAgentSettled).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(onAgentSettled).toHaveBeenCalledTimes(1));
        expect(rpc).toHaveBeenCalledWith({ type: 'get_entries', since: 'entry-1' }, undefined);
    });
});

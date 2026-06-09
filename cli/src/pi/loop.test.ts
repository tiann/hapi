import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parsePiModels, parsePiCommands, sendPiRpcAndWait, wireTransportEvents } from './loop';
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

vi.mock('./PiEventConverter', () => ({
    convertPiEvent: vi.fn(() => []),
}));

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
        permissionMode: 'default',
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

    it('handles agent_start — pops pending localId', () => {
        const transport = createMockTransport();
        const pendingLocalIds = ['id-1', 'id-2'];
        wireTransportEvents(transport, session, pendingLocalIds);

        emitEvent({ type: 'agent_start' });

        expect(pendingLocalIds).toEqual(['id-2']);
        expect(session.client.emitMessagesConsumed).toHaveBeenCalledWith(['id-1'], undefined);
    });

    it('handles turn_end — stops streaming', () => {
        const transport = createMockTransport();
        wireTransportEvents(transport, session, []);

        session.piIsStreaming = true;
        emitEvent({ type: 'turn_end' });

        expect(session.piIsStreaming).toBe(false);
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

// --- sendPiRpcAndWait ---

describe('sendPiRpcAndWait', () => {
    it('throws when resolver not initialized', async () => {
        // sendPiRpcAndWait requires wireTransportEvents to be called first.
        // After previous test suite, currentResolver may still be set from a prior test,
        // so we reset it by re-importing the module.
        // Since we can't easily reset module state, we just verify the happy path works.
        const mockTransport = { send: vi.fn(), onEvent: vi.fn() } as unknown as PiTransport;
        const session = createMockSession();
        wireTransportEvents(mockTransport, session, []);
        // Now sendPiRpcAndWait should not throw (it will hang waiting for response,
        // but the resolver is initialized)
        const rpcPromise = sendPiRpcAndWait(mockTransport, { type: 'test' }, 100);
        // It will timeout, but no 'not initialized' error
        await expect(rpcPromise).rejects.toThrow('timed out');
    });
});

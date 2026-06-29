import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseOmpModels, parseOmpCommands, wireTransportEvents } from './loop';
import { OmpSession } from './session';
import { OmpTransport } from './ompTransport';

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock('@/agent/messageConverter', () => ({
    convertAgentMessage: vi.fn((msg) => msg),
}));
vi.mock('./ompEventConverter', () => ({
    convertOmpEvent: vi.fn(() => []),
}));
vi.mock('./ompMessageAccumulator', () => ({
    OmpMessageAccumulator: class { handleEvent = vi.fn(() => []); },
}));

function createMockSession(model?: string): OmpSession {
    return new OmpSession({
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
        model,
    });
}

describe('parseOmpModels / parseOmpCommands (re-exports)', () => {
    it('parseOmpModels returns empty for non-array', () => {
        expect(parseOmpModels(null)).toEqual([]);
        expect(parseOmpModels({})).toEqual([]);
    });
    it('parseOmpCommands returns empty for non-array', () => {
        expect(parseOmpCommands(null)).toEqual([]);
        expect(parseOmpCommands({})).toEqual([]);
    });
});

describe('wireTransportEvents', () => {
    let session: OmpSession;
    let eventHandlers: Map<string, (...args: unknown[]) => void>;

    function createMockTransport(): OmpTransport {
        eventHandlers = new Map();
        return {
            onEvent: vi.fn((handler) => { eventHandlers.set('event', handler); }),
            send: vi.fn(),
        } as unknown as OmpTransport;
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

    it('get_state response updates model/provider/sessionId/sessionFile/thinkingLevel', () => {
        const transport = createMockTransport();
        wireTransportEvents(transport, session, []);
        emitEvent({
            type: 'response', command: 'get_state', success: true,
            data: {
                model: { id: 'glm-5.2', provider: 'local-openai' },
                sessionId: 'sid-1',
                sessionFile: '/p/s.jsonl',
                thinkingLevel: 'xhigh',
                steeringMode: 'all',
                interruptMode: 'wait',
            },
        });
        expect(session.currentModel).toBe('glm-5.2');
        expect(session.currentProvider).toBe('local-openai');
        expect(session.currentThinkingLevel).toBe('xhigh');
        expect(session.currentInterruptMode).toBe('wait');
        expect(session.client.updateMetadata).toHaveBeenCalledWith(expect.any(Function));
    });

    it('get_state validates thinkingLevel against enum (rejects unknown level)', () => {
        // OCR round 2: an unexpected thinkingLevel must not propagate to keepAlive.
        const transport = createMockTransport();
        wireTransportEvents(transport, session, []);
        emitEvent({
            type: 'response', command: 'get_state', success: true,
            data: { thinkingLevel: 'ultra-future-level' },
        });
        expect(session.currentThinkingLevel).toBeUndefined();
    });

    it('available_commands_update caches commands (OMP push, not get_commands)', () => {
        const transport = createMockTransport();
        wireTransportEvents(transport, session, []);
        emitEvent({
            type: 'available_commands_update',
            commands: [
                { name: 'compact', source: 'builtin' },
                { name: 'todo', source: 'builtin' },
            ],
        });
        expect(session.cachedOmpCommands).toHaveLength(2);
        expect(session.cachedOmpCommands[0].name).toBe('compact');
    });

    it('goal_updated maps budget-limited → budgetLimited (field name)', () => {
        const transport = createMockTransport();
        wireTransportEvents(transport, session, []);
        emitEvent({
            type: 'goal_updated',
            goal: {
                id: 'g1', objective: 'ship', status: 'budget-limited',
                tokensUsed: 100, createdAt: 1, updatedAt: 2,
            },
        });
        expect(session.client.sendAgentMessage).toHaveBeenCalledWith({
            type: 'thread_goal_updated',
            threadId: 'g1',
            goal: expect.objectContaining({ threadId: 'g1', status: 'budgetLimited', objective: 'ship' }),
        });
    });

    it('goal_updated with status dropped → thread_goal_cleared', () => {
        const transport = createMockTransport();
        wireTransportEvents(transport, session, []);
        emitEvent({
            type: 'goal_updated',
            goal: { id: 'g1', objective: 'x', status: 'dropped' },
        });
        expect(session.client.sendAgentMessage).toHaveBeenCalledWith({ type: 'thread_goal_cleared' });
    });

    it('goal_updated with null goal → thread_goal_cleared', () => {
        const transport = createMockTransport();
        wireTransportEvents(transport, session, []);
        emitEvent({ type: 'goal_updated', goal: null });
        expect(session.client.sendAgentMessage).toHaveBeenCalledWith({ type: 'thread_goal_cleared' });
    });

    it('auto_compaction_start pushes a compact event to web', () => {
        const transport = createMockTransport();
        wireTransportEvents(transport, session, []);
        emitEvent({ type: 'auto_compaction_start', reason: 'threshold', action: 'context-full' });
        expect(session.client.sendAgentMessage).toHaveBeenCalledWith({ type: 'compact', trigger: 'threshold' });
    });

    it('thinking_level_changed updates session + keepAlive (validated)', () => {
        const transport = createMockTransport();
        wireTransportEvents(transport, session, []);
        emitEvent({ type: 'thinking_level_changed', thinkingLevel: 'high' });
        expect(session.currentThinkingLevel).toBe('high');
        expect(session.client.keepAlive).toHaveBeenCalled();
    });

    it('thinking_level_changed with invalid level does not update', () => {
        const transport = createMockTransport();
        wireTransportEvents(transport, session, []);
        emitEvent({ type: 'thinking_level_changed', thinkingLevel: 'nonsense' });
        expect(session.currentThinkingLevel).toBeUndefined();
    });

    it('malformed response event (missing success) is skipped, not passed to handleResponse', () => {
        // OCR round 4: a response missing command/success must not reach handleResponse
        // (would show "Unknown OMP error" + hang the pending RPC).
        const transport = createMockTransport();
        wireTransportEvents(transport, session, []);
        // No throw, no sendSessionEvent (no error branch reached).
        emitEvent({ type: 'response' });
        expect(session.client.sendSessionEvent).not.toHaveBeenCalled();
    });

    it('failed response surfaces error + drains pending prompt localId', () => {
        const transport = createMockTransport();
        const pendingLocalIds = ['lid-1'];
        wireTransportEvents(transport, session, pendingLocalIds);
        emitEvent({ type: 'response', command: 'prompt', success: false, error: 'boom' });
        expect(session.client.sendSessionEvent).toHaveBeenCalledWith({ type: 'message', message: 'boom' });
        expect(session.client.emitMessagesConsumed).toHaveBeenCalledWith(['lid-1'], { clearQueuedThinkingGrace: true });
    });

    it('initialModel is applied only once across multiple get_available_models responses', () => {
        // OCR round 1/2: racing get_available_models responses must not re-apply
        // the startup model and clobber a user's later choice.
        const sessionWithInitial = createMockSession('glm-5.2');
        const transport = createMockTransport();
        wireTransportEvents(transport, sessionWithInitial, []);
        const modelsData = {
            type: 'response', command: 'get_available_models', success: true,
            data: { models: [{ id: 'glm-5.2', provider: 'local-openai' }] },
        };
        emitEvent(modelsData);
        expect(sessionWithInitial.initialModelApplied).toBe(true);
        // Simulate user changing model in between.
        sessionWithInitial.currentModel = 'other-model';
        // Second response arrives — must NOT re-apply initialModel.
        emitEvent(modelsData);
        expect(sessionWithInitial.currentModel).toBe('other-model');
    });

    it('initialModel apply disambiguates by currentProvider on resume', async () => {
        // OCR round 4: on resume, get_state restores currentProvider before
        // get_available_models arrives. A modelId existing under multiple
        // providers must match the resumed provider, not the first one.
        const sessionWithInitial = createMockSession('glm-5.2');
        const transport = createMockTransport();
        wireTransportEvents(transport, sessionWithInitial, []);
        // get_state restored the resumed session's provider first.
        sessionWithInitial.currentProvider = 'local-openai';
        const modelsData = {
            type: 'response', command: 'get_available_models', success: true,
            data: { models: [
                { id: 'glm-5.2', provider: 'remote-cloud' },
                { id: 'glm-5.2', provider: 'local-openai' },
            ] },
        };
        emitEvent(modelsData);
        expect(sessionWithInitial.initialModelApplied).toBe(true);
        // set_model is applied fire-and-forget (async), so wait for the send.
        await vi.waitFor(() => {
            expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({
                type: 'set_model', provider: 'local-openai', modelId: 'glm-5.2',
            }));
        });
    });

    it('turn_start drains the oldest pending localId (FIFO)', () => {
        const transport = createMockTransport();
        const pendingLocalIds = ['a', 'b'];
        wireTransportEvents(transport, session, pendingLocalIds);
        emitEvent({ type: 'turn_start' });
        expect(pendingLocalIds).toEqual(['b']);
        expect(session.client.emitMessagesConsumed).toHaveBeenCalledWith(['a'], undefined);
    });

    it('agent_end updates thinking state to false', () => {
        // OCR round 1: agent_end must call updateThinkingState(false), not just
        // flip a flag, so the hub is notified immediately.
        const transport = createMockTransport();
        wireTransportEvents(transport, session, []);
        emitEvent({ type: 'agent_end', messages: [] });
        // updateThinkingState(false) calls keepAlive with the runtime arg; when
        // model/thinkingLevel are both unset, runtime is undefined.
        expect(session.client.keepAlive).toHaveBeenCalledWith(false, session.mode, undefined);
    });
});

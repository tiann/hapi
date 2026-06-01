import { describe, expect, it } from 'vitest';
import { CodexTranscriptEventConverter, convertCodexEvent } from './codexEventConverter';

describe('convertCodexEvent', () => {
    it('extracts session_meta id', () => {
        const result = convertCodexEvent({
            type: 'session_meta',
            payload: { id: 'session-123' }
        });

        expect(result).toEqual({ sessionId: 'session-123' });
    });

    it('converts agent_message events', () => {
        const result = convertCodexEvent({
            type: 'event_msg',
            payload: { type: 'agent_message', message: 'hello' }
        });

        expect(result?.message).toMatchObject({
            type: 'message',
            message: 'hello'
        });
    });

    it('converts user_message events', () => {
        const result = convertCodexEvent({
            type: 'event_msg',
            payload: { type: 'user_message', message: 'hello user' }
        });

        expect(result?.userMessage).toBe('hello user');
    });

    it('converts reasoning events', () => {
        const result = convertCodexEvent({
            type: 'event_msg',
            payload: { type: 'agent_reasoning', text: 'thinking' }
        });

        expect(result?.message).toMatchObject({
            type: 'reasoning',
            message: 'thinking'
        });
    });

    it('converts reasoning delta events', () => {
        const result = convertCodexEvent({
            type: 'event_msg',
            payload: { type: 'agent_reasoning_delta', delta: 'step' }
        });

        expect(result?.message).toEqual({
            type: 'reasoning-delta',
            delta: 'step'
        });
    });

    it('converts function_call items', () => {
        const result = convertCodexEvent({
            type: 'response_item',
            payload: {
                type: 'function_call',
                name: 'ToolName',
                call_id: 'call-1',
                arguments: '{"foo":"bar"}'
            }
        });

        expect(result?.message).toMatchObject({
            type: 'tool-call',
            name: 'ToolName',
            callId: 'call-1',
            input: { foo: 'bar' }
        });
    });

    it('converts function_call_output items', () => {
        const result = convertCodexEvent({
            type: 'response_item',
            payload: {
                type: 'function_call_output',
                call_id: 'call-2',
                output: { ok: true }
            }
        });

        expect(result?.message).toMatchObject({
            type: 'tool-call-result',
            callId: 'call-2',
            output: { ok: true }
        });
    });

    it('converts thread goal update events from local transcript sync', () => {
        const goal = {
            threadId: 'thread-1',
            objective: 'ship goal support',
            status: 'active',
            tokenBudget: null,
            tokensUsed: 42,
            timeUsedSeconds: 7,
            createdAt: 1,
            updatedAt: 2
        };

        const result = convertCodexEvent({
            type: 'event_msg',
            payload: {
                type: 'thread_goal_updated',
                thread_id: 'thread-1',
                turn_id: 'turn-1',
                goal
            }
        });

        expect(result?.message).toEqual({
            type: 'thread_goal_updated',
            thread_id: 'thread-1',
            turn_id: 'turn-1',
            goal
        });
    });

    it('converts thread goal clear events from local transcript sync', () => {
        const result = convertCodexEvent({
            type: 'event_msg',
            payload: {
                type: 'thread_goal_cleared',
                thread_id: 'thread-1'
            }
        });

        expect(result?.message).toEqual({
            type: 'thread_goal_cleared',
            thread_id: 'thread-1'
        });
    });
});

describe('CodexTranscriptEventConverter', () => {
    it('accumulates app-server agent message deltas from local transcript sync', () => {
        const converter = new CodexTranscriptEventConverter();

        expect(converter.convert({
            type: 'item/agentMessage/delta',
            payload: { itemId: 'msg-1', delta: 'Hello' }
        })).toEqual([]);
        expect(converter.convert({
            type: 'item/agentMessage/delta',
            payload: { itemId: 'msg-1', delta: ' world' }
        })).toEqual([]);

        expect(converter.convert({
            type: 'item/completed',
            payload: {
                item: { id: 'msg-1', type: 'agentMessage' }
            }
        })).toEqual([{
            message: {
                type: 'agent_message',
                message: 'Hello world'
            }
        }]);
    });

    it('converts app-server goal notifications from local transcript sync', () => {
        const converter = new CodexTranscriptEventConverter();
        const goal = {
            threadId: 'thread-1',
            objective: 'ship goal support',
            status: 'active'
        };

        expect(converter.convert({
            type: 'notification',
            payload: {
                method: 'thread/goal/updated',
                params: {
                    threadId: 'thread-1',
                    goal
                }
            }
        })).toEqual([{
            message: {
                type: 'thread_goal_updated',
                thread_id: 'thread-1',
                goal
            }
        }]);
    });

    it('converts wrapped codex event transcript entries', () => {
        const converter = new CodexTranscriptEventConverter();

        expect(converter.convert({
            type: 'codex/event/agent_message_delta',
            payload: {
                item_id: 'msg-1',
                delta: 'Hello'
            }
        })).toEqual([]);

        expect(converter.convert({
            type: 'codex/event/item_completed',
            payload: {
                item_id: 'msg-1',
                item: { id: 'msg-1', type: 'agentMessage' }
            }
        })).toEqual([{
            message: {
                type: 'agent_message',
                message: 'Hello'
            }
        }]);
    });
});

import { describe, expect, it } from 'vitest';
import { convertCodexEvent } from './codexEventConverter';

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

    it('converts completed plan items into proposed plan messages', () => {
        const result = convertCodexEvent({
            type: 'event_msg',
            payload: {
                type: 'item_completed',
                turn_id: 'turn-1',
                item: { type: 'Plan', id: 'plan-1', text: '## Plan\n\n1. Inspect\n2. Implement' }
            }
        });

        expect(result?.message).toMatchObject({
            type: 'proposed_plan',
            plan: '## Plan\n\n1. Inspect\n2. Implement',
            id: 'plan-1',
            turnId: 'turn-1'
        });
    });

    it('ignores empty completed plan items', () => {
        const result = convertCodexEvent({
            type: 'event_msg',
            payload: {
                type: 'item_completed',
                turn_id: 'turn-1',
                item: { type: 'Plan', id: 'plan-1', text: '   ' }
            }
        });

        expect(result).toBeNull();
    });

    it('ignores completed plan items without a turn id', () => {
        const result = convertCodexEvent({
            type: 'event_msg',
            payload: {
                type: 'item_completed',
                item: { type: 'Plan', id: 'plan-1', text: '## Plan' }
            }
        });

        expect(result).toBeNull();
    });

    it.each(['task_complete', 'turn_aborted', 'task_failed'])('converts %s into a turn boundary', (type) => {
        const result = convertCodexEvent({
            type: 'event_msg',
            payload: { type, turn_id: 'turn-1' }
        });

        expect(result).toEqual({ finishedTurnId: 'turn-1' });
    });

    it.each([
        ['user text', {
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'hello from response_item user' }]
            }
        }],
        ['user image', {
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_image', image_url: 'data:image/png;base64,abc' }]
            }
        }],
        ['assistant text', {
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'hello from response_item assistant' }]
            }
        }],
        ['injected user context', {
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: '# AGENTS.md\n<environment_context>hidden context</environment_context>' }]
            }
        }]
    ])('ignores %s response_item messages', (_name, event) => {
        expect(convertCodexEvent(event)).toBeNull();
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
});

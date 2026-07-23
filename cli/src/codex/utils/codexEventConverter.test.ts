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

        expect(result?.messages?.[0]).toMatchObject({
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

        expect(result?.messages?.[0]).toMatchObject({
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

        expect(result?.messages?.[0]).toMatchObject({
            type: 'reasoning',
            message: 'thinking'
        });
    });

    it('converts reasoning delta events', () => {
        const result = convertCodexEvent({
            type: 'event_msg',
            payload: { type: 'agent_reasoning_delta', delta: 'step' }
        });

        expect(result?.messages?.[0]).toEqual({
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

        expect(result?.messages?.[0]).toMatchObject({
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

        expect(result?.messages?.[0]).toMatchObject({
            type: 'tool-call-result',
            callId: 'call-2',
            output: { ok: true }
        });
    });

    it.each([
        ['exec', 'ls -la'],
        ['apply_patch', '*** Begin Patch\n*** End Patch']
    ])('converts %s custom_tool_call items', (name, input) => {
        const result = convertCodexEvent({
            type: 'response_item',
            payload: {
                type: 'custom_tool_call',
                name,
                call_id: `call-${name}`,
                input
            }
        });

        expect(result?.messages?.[0]).toMatchObject({
            type: 'tool-call',
            name,
            callId: `call-${name}`,
            input
        });
    });

    it.each([
        ['string', 'command output'],
        ['array', [{ type: 'input_text', text: 'patch applied' }]]
    ])('preserves %s custom_tool_call_output values', (_name, output) => {
        const result = convertCodexEvent({
            type: 'response_item',
            payload: {
                type: 'custom_tool_call_output',
                call_id: 'call-custom-output',
                output
            }
        });

        expect(result?.messages?.[0]).toMatchObject({
            type: 'tool-call-result',
            callId: 'call-custom-output',
            output
        });
    });

    it('converts tool_search_call items', () => {
        const result = convertCodexEvent({
            type: 'response_item',
            payload: {
                type: 'tool_search_call',
                call_id: 'call-tool-search',
                arguments: { query: 'hapi change title', limit: 5 }
            }
        });

        expect(result?.messages?.[0]).toMatchObject({
            type: 'tool-call',
            name: 'ToolSearch',
            callId: 'call-tool-search',
            input: { query: 'hapi change title', limit: 5 }
        });
    });

    it('converts tool_search_output items', () => {
        const tools = [{ name: 'mcp__hapi', description: 'Hapi tools' }];
        const result = convertCodexEvent({
            type: 'response_item',
            payload: {
                type: 'tool_search_output',
                call_id: 'call-tool-search',
                execution: 'client',
                status: 'completed',
                tools
            }
        });

        expect(result?.messages?.[0]).toMatchObject({
            type: 'tool-call-result',
            callId: 'call-tool-search',
            output: { execution: 'client', tools }
        });
    });

    it('converts a completed web_search_call into a paired call and result', () => {
        const action = {
            type: 'search',
            query: 'Codex transcript format',
            queries: ['Codex transcript format']
        };
        const result = convertCodexEvent({
            type: 'response_item',
            payload: {
                type: 'web_search_call',
                status: 'completed',
                action
            }
        });

        expect(result?.messages).toEqual([{
            type: 'tool-call',
            name: 'WebSearch',
            callId: expect.any(String),
            input: action,
            id: expect.any(String)
        }, {
            type: 'tool-call-result',
            callId: expect.any(String),
            output: null,
            id: expect.any(String)
        }]);
        expect(result?.messages?.[1]).toMatchObject({
            callId: result?.messages?.[0]?.type === 'tool-call'
                ? result.messages[0].callId
                : undefined
        });
    });

    it('uses an empty input for older web_search_call items without an action', () => {
        const result = convertCodexEvent({
            type: 'response_item',
            payload: {
                type: 'web_search_call',
                status: 'completed'
            }
        });

        expect(result?.messages?.[0]).toMatchObject({
            type: 'tool-call',
            name: 'WebSearch',
            input: {}
        });
    });

    it.each(['failed', 'error'])('marks a %s web_search_call result as an error', (status) => {
        const result = convertCodexEvent({
            type: 'response_item',
            payload: {
                type: 'web_search_call',
                status,
                action: { type: 'search', query: 'failing query' }
            }
        });

        expect(result?.messages?.[1]).toMatchObject({
            type: 'tool-call-result',
            output: null,
            is_error: true
        });
    });

    it.each([
        ['custom tool call without a name', {
            type: 'custom_tool_call',
            call_id: 'call-missing-name',
            input: 'pwd'
        }],
        ['custom tool call without a call id', {
            type: 'custom_tool_call',
            name: 'exec',
            input: 'pwd'
        }],
        ['custom tool output without a call id', {
            type: 'custom_tool_call_output',
            output: 'done'
        }],
        ['tool search call without a call id', {
            type: 'tool_search_call',
            arguments: { query: 'missing id' }
        }],
        ['tool search output without a call id', {
            type: 'tool_search_output',
            execution: 'client',
            tools: []
        }]
    ])('ignores %s', (_name, payload) => {
        expect(convertCodexEvent({
            type: 'response_item',
            payload
        })).toBeNull();
    });
});

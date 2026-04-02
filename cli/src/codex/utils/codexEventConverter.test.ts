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

    it.each([
        ['exec_command', 'CodexBash'],
        ['write_stdin', 'CodexWriteStdin'],
        ['spawn_agent', 'CodexSpawnAgent'],
        ['wait_agent', 'CodexWaitAgent'],
        ['send_input', 'CodexSendInput'],
        ['close_agent', 'CodexCloseAgent'],
        ['update_plan', 'update_plan'],
        ['mcp__hapi__change_title', 'mcp__hapi__change_title'],
        ['unknown_tool', 'unknown_tool']
    ])('normalizes function_call tool name %s -> %s', (inputName, expectedName) => {
        const result = convertCodexEvent({
            type: 'response_item',
            payload: {
                type: 'function_call',
                name: inputName,
                call_id: 'call-1',
                arguments: '{"foo":"bar"}'
            }
        });

        expect(result?.message).toMatchObject({
            type: 'tool-call',
            name: expectedName,
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

    it('preserves sidechain metadata on user and agent/tool messages', () => {
        const userResult = convertCodexEvent({
            type: 'event_msg',
            payload: {
                type: 'user_message',
                message: 'child prompt'
            },
            hapiSidechain: {
                parentToolCallId: 'spawn-call-1'
            }
        });

        expect(userResult).toEqual({
            userMessage: 'child prompt',
            userMessageMeta: {
                isSidechain: true,
                sidechainKey: 'spawn-call-1'
            }
        });

        const agentResult = convertCodexEvent({
            type: 'event_msg',
            payload: {
                type: 'agent_message',
                message: 'child answer'
            },
            hapiSidechain: {
                parentToolCallId: 'spawn-call-1'
            }
        });

        expect(agentResult?.message).toMatchObject({
            type: 'message',
            message: 'child answer',
            isSidechain: true,
            parentToolCallId: 'spawn-call-1'
        });

        const reasoningResult = convertCodexEvent({
            type: 'event_msg',
            payload: {
                type: 'agent_reasoning',
                text: 'thinking'
            },
            hapiSidechain: {
                parentToolCallId: 'spawn-call-1'
            }
        });

        expect(reasoningResult?.message).toMatchObject({
            type: 'reasoning',
            message: 'thinking',
            isSidechain: true,
            parentToolCallId: 'spawn-call-1'
        });

        const tokenCountResult = convertCodexEvent({
            type: 'event_msg',
            payload: {
                type: 'token_count',
                info: { input_tokens: 1 }
            },
            hapiSidechain: {
                parentToolCallId: 'spawn-call-1'
            }
        });

        expect(tokenCountResult?.message).toMatchObject({
            type: 'token_count',
            info: { input_tokens: 1 },
            isSidechain: true,
            parentToolCallId: 'spawn-call-1'
        });

        const toolResult = convertCodexEvent({
            type: 'response_item',
            payload: {
                type: 'function_call',
                name: 'spawn_agent',
                call_id: 'call-1',
                arguments: '{}'
            },
            hapiSidechain: {
                parentToolCallId: 'spawn-call-1'
            }
        });

        expect(toolResult?.message).toMatchObject({
            type: 'tool-call',
            name: 'CodexSpawnAgent',
            callId: 'call-1',
            isSidechain: true,
            parentToolCallId: 'spawn-call-1'
        });
    });
});

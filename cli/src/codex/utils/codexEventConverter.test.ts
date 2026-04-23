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
        ['close_agent', 'CodexCloseAgent']
    ])('normalizes Codex tool %s as %s', (rawName, expectedName) => {
        const result = convertCodexEvent({
            type: 'response_item',
            payload: {
                type: 'function_call',
                name: rawName,
                call_id: 'call-1',
                arguments: '{"message":"child prompt"}'
            }
        });

        expect(result?.message).toMatchObject({
            type: 'tool-call',
            name: expectedName,
            callId: 'call-1'
        });
    });

    it('adds normalized subagent metadata for Codex spawn_agent calls', () => {
        const result = convertCodexEvent({
            type: 'response_item',
            payload: {
                type: 'function_call',
                name: 'spawn_agent',
                call_id: 'spawn-1',
                arguments: '{"message":"Summarize this file"}'
            }
        });

        expect(result?.message).toMatchObject({
            type: 'tool-call',
            name: 'CodexSpawnAgent',
            callId: 'spawn-1',
            meta: {
                subagent: {
                    kind: 'spawn',
                    sidechainKey: 'spawn-1',
                    prompt: 'Summarize this file'
                }
            }
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

import { describe, it, expect } from 'vitest';
import { convertPiEvent } from './PiEventConverter';
import type { AgentMessage } from '@/agent/types';

describe('convertPiEvent', () => {
    it('should convert message_update with text_delta to text AgentMessage', () => {
        const result = convertPiEvent({
            type: 'message_update',
            assistantMessageEvent: { type: 'text_delta', delta: 'hello world' }
        });
        expect(result).toEqual([{ type: 'text', text: 'hello world' }]);
    });

    it('should convert message_update with thinking_delta to reasoning AgentMessage', () => {
        const result = convertPiEvent({
            type: 'message_update',
            assistantMessageEvent: { type: 'thinking_delta', delta: 'let me think...' }
        });
        expect(result).toEqual([{ type: 'reasoning', text: 'let me think...', live: true }]);
    });

    it('should return empty array for message_update with start sub-type', () => {
        const result = convertPiEvent({
            type: 'message_update',
            assistantMessageEvent: { type: 'start' }
        });
        expect(result).toEqual([]);
    });

    it('should return empty array for message_update with end sub-type', () => {
        const result = convertPiEvent({
            type: 'message_update',
            assistantMessageEvent: { type: 'done' }
        });
        expect(result).toEqual([]);
    });

    it('should convert tool_execution_start to tool_call AgentMessage', () => {
        const result = convertPiEvent({
            type: 'tool_execution_start',
            toolCallId: 'tc-1',
            toolName: 'read_file',
            args: { path: '/foo.ts' }
        });
        expect(result).toEqual([{
            type: 'tool_call',
            id: 'tc-1',
            name: 'read_file',
            input: { path: '/foo.ts' },
            status: 'in_progress'
        }]);
    });

    it('should convert tool_execution_end (success) to tool_result AgentMessage', () => {
        const result = convertPiEvent({
            type: 'tool_execution_end',
            toolCallId: 'tc-1',
            toolName: 'read_file',
            result: 'file content',
            isError: false
        });
        expect(result).toEqual([{
            type: 'tool_result',
            id: 'tc-1',
            output: 'file content',
            status: 'completed'
        }]);
    });

    it('should convert tool_execution_end (error) to failed tool_result AgentMessage', () => {
        const result = convertPiEvent({
            type: 'tool_execution_end',
            toolCallId: 'tc-1',
            toolName: 'read_file',
            result: 'file not found',
            isError: true
        });
        expect(result).toEqual([{
            type: 'tool_result',
            id: 'tc-1',
            output: 'file not found',
            status: 'failed'
        }]);
    });

    it('should convert turn_end to usage + turn_complete (2 messages)', () => {
        const result = convertPiEvent({
            type: 'turn_end',
            message: {
                role: 'assistant',
                usage: {
                    input: 100,
                    output: 200,
                    cacheRead: 10,
                    cacheWrite: 5,
                    totalTokens: 315
                },
                stopReason: 'stop'
            },
            toolResults: []
        });

        expect(result).toHaveLength(2);
        expect(result[0]).toEqual({
            type: 'usage',
            inputTokens: 100,
            outputTokens: 200,
            totalTokens: 315,
            cacheReadTokens: 10
        });
        expect(result[1]).toEqual({
            type: 'turn_complete',
            stopReason: 'stop'
        });
    });

    it('should convert turn_end with toolUse stopReason', () => {
        const result = convertPiEvent({
            type: 'turn_end',
            message: {
                role: 'assistant',
                usage: { input: 50, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 150 },
                stopReason: 'toolUse'
            },
            toolResults: []
        });

        expect(result).toHaveLength(2);
        expect(result[1]).toEqual({
            type: 'turn_complete',
            stopReason: 'toolUse'
        });
    });

    it('should return empty array for agent_start', () => {
        expect(convertPiEvent({ type: 'agent_start' })).toEqual([]);
    });

    it('should return empty array for agent_end', () => {
        expect(convertPiEvent({ type: 'agent_end', messages: [] })).toEqual([]);
    });

    it('should return empty array for response events', () => {
        expect(convertPiEvent({ type: 'response', command: 'prompt', success: true })).toEqual([]);
    });

    it('should return empty array for turn_start', () => {
        expect(convertPiEvent({ type: 'turn_start' })).toEqual([]);
    });

    it('should return empty array for unknown event types', () => {
        expect(convertPiEvent({ type: 'something_else' })).toEqual([]);
    });

    it('should convert message_update with text_delta with empty delta', () => {
        const result = convertPiEvent({
            type: 'message_update',
            assistantMessageEvent: { type: 'text_delta', delta: '' }
        });
        expect(result).toEqual([{ type: 'text', text: '' }]);
    });
});

import { describe, it, expect } from 'vitest';
import { convertOmpEvent } from './ompEventConverter';
import type { OmpAgentEvent } from './types';

describe('convertOmpEvent', () => {
    it('returns empty for message_update with text_delta (accumulated in loop)', () => {
        expect(convertOmpEvent({
            type: 'message_update',
            assistantMessageEvent: { type: 'text_delta', delta: 'hello' }
        })).toEqual([]);
    });

    it('returns empty for message_update without assistantMessageEvent', () => {
        expect(convertOmpEvent({ type: 'message_update' })).toEqual([]);
    });

    it('converts tool_execution_start to tool_call AgentMessage', () => {
        expect(convertOmpEvent({
            type: 'tool_execution_start',
            toolCallId: 'tc-1',
            toolName: 'read_file',
            args: { path: '/foo.ts' }
        })).toEqual([{
            type: 'tool_call',
            id: 'tc-1',
            name: 'read_file',
            input: { path: '/foo.ts' },
            status: 'in_progress'
        }]);
    });

    it('converts tool_execution_end (success) to tool_result AgentMessage', () => {
        expect(convertOmpEvent({
            type: 'tool_execution_end',
            toolCallId: 'tc-1',
            toolName: 'read_file',
            result: 'content',
            isError: false
        })).toEqual([{
            type: 'tool_result',
            id: 'tc-1',
            output: 'content',
            status: 'completed'
        }]);
    });

    it('converts tool_execution_end (error) to failed tool_result', () => {
        expect(convertOmpEvent({
            type: 'tool_execution_end',
            toolCallId: 'tc-1',
            toolName: 'read_file',
            result: 'not found',
            isError: true
        })).toEqual([{
            type: 'tool_result',
            id: 'tc-1',
            output: 'not found',
            status: 'failed'
        }]);
    });

    it('converts turn_end to usage + turn_complete (2 messages)', () => {
        const result = convertOmpEvent({
            type: 'turn_end',
            message: {
                usage: { input: 100, output: 200, cacheRead: 10, cacheWrite: 5, totalTokens: 315 },
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
        expect(result[1]).toEqual({ type: 'turn_complete', stopReason: 'stop' });
    });

    it('converts turn_end with toolUse stopReason', () => {
        const result = convertOmpEvent({
            type: 'turn_end',
            message: {
                usage: { input: 50, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 150 },
                stopReason: 'toolUse'
            },
            toolResults: []
        });
        expect(result[1]).toEqual({ type: 'turn_complete', stopReason: 'toolUse' });
    });

    it('converts turn_end without usage (defaults to stop)', () => {
        expect(convertOmpEvent({ type: 'turn_end' })).toEqual([
            { type: 'turn_complete', stopReason: 'stop' }
        ]);
    });

    it('returns empty for goal_updated (handled by loop, not converter)', () => {
        expect(convertOmpEvent({ type: 'goal_updated', goal: null } as unknown as OmpAgentEvent)).toEqual([]);
    });

    it('returns empty for auto_compaction_start/end (handled by loop)', () => {
        expect(convertOmpEvent({ type: 'auto_compaction_start', reason: 'threshold', action: 'context-full' } as unknown as OmpAgentEvent)).toEqual([]);
        expect(convertOmpEvent({ type: 'auto_compaction_end', action: 'context-full', aborted: false, willRetry: false } as unknown as OmpAgentEvent)).toEqual([]);
    });

    it('returns empty for available_commands_update (handled by loop)', () => {
        expect(convertOmpEvent({ type: 'available_commands_update', commands: [] } as unknown as OmpAgentEvent)).toEqual([]);
    });

    it('returns empty for ready (consumed by transport)', () => {
        expect(convertOmpEvent({ type: 'ready' } as unknown as OmpAgentEvent)).toEqual([]);
    });

    it('returns empty for response events', () => {
        expect(convertOmpEvent({ type: 'response', command: 'prompt', success: true } as unknown as OmpAgentEvent)).toEqual([]);
    });

    it('returns empty for unknown event types', () => {
        expect(convertOmpEvent({ type: 'something_else' })).toEqual([]);
    });

    it('does not crash on unexpected data structure', () => {
        const weird = Object.create(null);
        weird.type = 'message_update';
        weird.assistantMessageEvent = undefined;
        expect(() => convertOmpEvent(weird as unknown as OmpAgentEvent)).not.toThrow();
        expect(convertOmpEvent(weird as unknown as OmpAgentEvent)).toEqual([]);
    });
});

import { describe, it, expect } from 'vitest';
import { clearGeneratedImages, MAX_GENERATED_IMAGE_BASE64_CHARS } from '../modules/common/generatedImages';
import { convertPiCompactionUsage, convertPiEvent, convertPiTurnUsage, extractPiGeneratedImages } from './piEventConverter';
import type { PiAgentEvent } from './types';

describe('extractPiGeneratedImages', () => {
    const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

    function imageEndEvent(blocks: unknown[]): PiAgentEvent {
        return {
            type: 'tool_execution_end',
            toolCallId: 'tool-1',
            toolName: 'read',
            result: { content: blocks },
            isError: false,
        } as PiAgentEvent;
    }

    it('registers a valid PNG tool-result image', () => {
        clearGeneratedImages();
        const messages = extractPiGeneratedImages(imageEndEvent([
            { type: 'image', mimeType: 'image/png', data: PNG_HEADER.toString('base64') },
        ]), () => null);
        expect(messages).toHaveLength(1);
        expect(messages[0].type).toBe('generated_image');
        expect(messages[0]).toMatchObject({
            mimeType: 'image/png',
            source: { ingress: 'tool_result', flavor: 'pi', toolCallId: 'tool-1' },
        });
    });

    it('skips oversized base64 without decoding it', () => {
        clearGeneratedImages();
        const messages = extractPiGeneratedImages(imageEndEvent([
            { type: 'image', mimeType: 'image/png', data: 'A'.repeat(MAX_GENERATED_IMAGE_BASE64_CHARS + 8) },
        ]), () => null);
        expect(messages).toEqual([]);
    });

    it('skips bytes that do not sniff as a real image', () => {
        clearGeneratedImages();
        const messages = extractPiGeneratedImages(imageEndEvent([
            { type: 'image', mimeType: 'image/png', data: Buffer.from('definitely not an image').toString('base64') },
        ]), () => null);
        expect(messages).toEqual([]);
    });

    it('rejects declared-vs-sniffed MIME mismatches', () => {
        clearGeneratedImages();
        const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
        const messages = extractPiGeneratedImages(imageEndEvent([
            { type: 'image', mimeType: 'image/png', data: jpeg.toString('base64') },
        ]), () => null);
        expect(messages).toEqual([]);
    });

    it('rejects malformed tool_execution_end events missing required fields', () => {
        clearGeneratedImages();
        const event = {
            type: 'tool_execution_end',
            // toolCallId / toolName / isError 均缺失 —— 同类事件在 convertPiEvent
            // 的 schema 安检里也会被拒收，这里不能给孤儿图片开绿灯
            result: { content: [{ type: 'image', mimeType: 'image/png', data: PNG_HEADER.toString('base64') }] },
        } as PiAgentEvent;
        const messages = extractPiGeneratedImages(event, () => null);
        expect(messages).toEqual([]);
    });
});

describe('convertPiEvent', () => {
    it('should return empty for message_update with text_delta (accumulated in runPi)', () => {
        // The converter intentionally emits nothing for message_update
        // — runPi accumulates text/thinking deltas and flushes a single
        // snapshot on `message_end`. This avoids the web UI rendering
        // every delta as a separate block (character-by-character column)
        // and the reducer's per-content streamId dedup showing only the
        // last delta as the whole reasoning.
        const result = convertPiEvent({
            type: 'message_update',
            assistantMessageEvent: { type: 'text_delta', delta: 'hello world' }
        });
        expect(result).toEqual([]);
    });

    it('should return empty for message_update with thinking_delta (accumulated in runPi)', () => {
        const result = convertPiEvent({
            type: 'message_update',
            assistantMessageEvent: { type: 'thinking_delta', delta: 'let me think...' }
        });
        expect(result).toEqual([]);
    });

    it('should return empty for message_update with start sub-type', () => {
        // text_start/thinking_start carry the full partial state and
        // would cause the web UI to render the same text multiple
        // times. The accumulator only listens to deltas.
        const result = convertPiEvent({
            type: 'message_update',
            assistantMessageEvent: { type: 'start' }
        });
        expect(result).toEqual([]);
    });

    it('should return empty array for message_update with start sub-type', () => {
        const result = convertPiEvent({
            type: 'message_update',
            assistantMessageEvent: { type: 'start' }
        });
        expect(result).toEqual([]);
    });

    it('should return empty array for message_update with done sub-type', () => {
        const result = convertPiEvent({
            type: 'message_update',
            assistantMessageEvent: { type: 'done', reason: 'stop' }
        });
        expect(result).toEqual([]);
    });

    it('should return empty array for message_update without assistantMessageEvent', () => {
        const result = convertPiEvent({ type: 'message_update' });
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

    it('maps tool execution progress onto the running tool call id', () => {
        expect(convertPiEvent({
            type: 'tool_execution_update',
            toolCallId: 'tc-1',
            toolName: 'read_file',
            args: { path: '/foo.ts' },
            partialResult: { linesRead: 10 },
        })).toEqual([{
            type: 'tool_call', id: 'tc-1', name: 'read_file', input: { path: '/foo.ts' }, status: 'in_progress', progress: { linesRead: 10 },
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

    it('drops malformed tool completion events instead of emitting an uncorrelated result', () => {
        expect(convertPiEvent({
            type: 'tool_execution_end', toolCallId: 'tc-1', toolName: 'read_file', isError: false,
        } as never)).toEqual([]);
        expect(convertPiEvent({
            type: 'tool_execution_end', toolName: 'read_file', result: 'ok', isError: false,
        } as never)).toEqual([]);
    });

    it('should defer turn usage and convert only turn completion', () => {
        const result = convertPiEvent({
            type: 'turn_end',
            message: {
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

        expect(result).toEqual([{
            type: 'turn_complete',
            stopReason: 'stop'
        }]);
    });

    it('should build usage from Pi authoritative context stats', () => {
        const result = convertPiTurnUsage({
            type: 'turn_end',
            message: {
                usage: { input: 100, output: 200, cacheRead: 10, cacheWrite: 5, totalTokens: 315 }
            }
        }, { tokens: 342, contextWindow: 200_000 });

        expect(result).toEqual({
            type: 'usage',
            inputTokens: 100,
            outputTokens: 200,
            totalTokens: 315,
            cacheReadTokens: 10,
            cacheCreationTokens: 5,
            contextTokens: 342,
            contextWindow: 200_000
        });
    });

    it('should fall back to positive totalTokens when stats are unavailable', () => {
        const result = convertPiTurnUsage({
            type: 'turn_end',
            message: {
                usage: { input: 100, output: 200, cacheRead: 10, cacheWrite: 5, totalTokens: 315 }
            }
        }, undefined);

        expect(result).toMatchObject({
            type: 'usage',
            totalTokens: 315,
            contextTokens: 315
        });
    });

    it('should build context-only usage from a compaction estimate', () => {
        expect(convertPiCompactionUsage(120)).toEqual({
            type: 'usage',
            inputTokens: 0,
            outputTokens: 0,
            contextTokens: 120,
        });
        expect(convertPiCompactionUsage(undefined)).toBeNull();
    });

    it('should preserve prior usage when Pi explicitly reports unknown context', () => {
        const result = convertPiTurnUsage({
            type: 'turn_end',
            message: {
                usage: { input: 100, output: 200, cacheRead: 10, cacheWrite: 5, totalTokens: 315 }
            }
        }, null);

        expect(result).toBeNull();
    });

    it('should skip all-zero error or aborted usage', () => {
        const result = convertPiTurnUsage({
            type: 'turn_end',
            message: {
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }
            }
        }, { tokens: 342, contextWindow: 200_000 });

        expect(result).toBeNull();
    });

    it('should convert turn_end with toolUse stopReason', () => {
        const result = convertPiEvent({
            type: 'turn_end',
            message: {
                usage: { input: 50, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 150 },
                stopReason: 'toolUse'
            },
            toolResults: []
        });

        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({
            type: 'turn_complete',
            stopReason: 'toolUse'
        });
    });

    it('should convert turn_end without usage data', () => {
        const result = convertPiEvent({
            type: 'turn_end'
        });

        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({
            type: 'turn_complete',
            stopReason: 'stop'
        });
    });

    it('should return empty array for agent_start', () => {
        expect(convertPiEvent({ type: 'agent_start' })).toEqual([]);
    });

    it('should return empty array for agent_end', () => {
        expect(convertPiEvent({ type: 'agent_end', messages: [] })).toEqual([]);
    });

    it('should return empty array for response events', () => {
        // Response events use a different type, but we handle gracefully
        expect(convertPiEvent({ type: 'response', command: 'prompt', success: true } as unknown as PiAgentEvent)).toEqual([]);
    });

    it('should return empty array for turn_start', () => {
        expect(convertPiEvent({ type: 'turn_start' })).toEqual([]);
    });

    it('should return empty array for unknown event types', () => {
        expect(convertPiEvent({ type: 'something_else' })).toEqual([]);
    });

    it('should not crash on unexpected data structure (safety net)', () => {
        // Simulate a malformed event that somehow passes through
        const weird = Object.create(null);
        weird.type = 'message_update';
        weird.assistantMessageEvent = undefined;
        // Should not throw
        expect(() => convertPiEvent(weird as unknown as PiAgentEvent)).not.toThrow();
        expect(convertPiEvent(weird as unknown as PiAgentEvent)).toEqual([]);
    });
});

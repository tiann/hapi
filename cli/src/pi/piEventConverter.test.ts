import { describe, it, expect } from 'vitest';
import { convertPiCompactionUsage, convertPiEvent, convertPiTurnUsage } from './piEventConverter';
import type { PiAgentEvent } from './types';

// 1x1 red PNG.
const ONE_PX_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('convertPiEvent', () => {
    it('should return empty for message_update with text_delta (accumulated in runPi)', async () => {
        // The converter intentionally emits nothing for message_update
        // — runPi accumulates text/thinking deltas and flushes a single
        // snapshot on `message_end`. This avoids the web UI rendering
        // every delta as a separate block (character-by-character column)
        // and the reducer's per-content streamId dedup showing only the
        // last delta as the whole reasoning.
        const result = await convertPiEvent({
            type: 'message_update',
            assistantMessageEvent: { type: 'text_delta', delta: 'hello world' }
        });
        expect(result).toEqual([]);
    });

    it('should return empty for message_update with thinking_delta (accumulated in runPi)', async () => {
        const result = await convertPiEvent({
            type: 'message_update',
            assistantMessageEvent: { type: 'thinking_delta', delta: 'let me think...' }
        });
        expect(result).toEqual([]);
    });

    it('should return empty for message_update with start sub-type', async () => {
        // text_start/thinking_start carry the full partial state and
        // would cause the web UI to render the same text multiple
        // times. The accumulator only listens to deltas.
        const result = await convertPiEvent({
            type: 'message_update',
            assistantMessageEvent: { type: 'start' }
        });
        expect(result).toEqual([]);
    });

    it('should return empty array for message_update without assistantMessageEvent', async () => {
        const result = await convertPiEvent({ type: 'message_update' });
        expect(result).toEqual([]);
    });

    it('should convert tool_execution_start to tool_call AgentMessage', async () => {
        const result = await convertPiEvent({
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

    it('maps tool execution progress onto the running tool call id', async () => {
        expect(await convertPiEvent({
            type: 'tool_execution_update',
            toolCallId: 'tc-1',
            toolName: 'read_file',
            args: { path: '/foo.ts' },
            partialResult: { linesRead: 10 },
        })).toEqual([{
            type: 'tool_call', id: 'tc-1', name: 'read_file', input: { path: '/foo.ts' }, status: 'in_progress', progress: { linesRead: 10 },
        }]);
    });

    it('should convert tool_execution_end (success) to tool_result AgentMessage', async () => {
        const result = await convertPiEvent({
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

    it('should convert tool_execution_end (error) to failed tool_result AgentMessage', async () => {
        const result = await convertPiEvent({
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

    it('drops malformed tool completion events instead of emitting an uncorrelated result', async () => {
        expect(await convertPiEvent({
            type: 'tool_execution_end', toolCallId: 'tc-1', toolName: 'read_file', isError: false,
        } as never)).toEqual([]);
        expect(await convertPiEvent({
            type: 'tool_execution_end', toolName: 'read_file', result: 'ok', isError: false,
        } as never)).toEqual([]);
    });

    it('emits a generated-image message for an inline image block next to the text result', async () => {
        const result = await convertPiEvent({
            type: 'tool_execution_end',
            toolCallId: 'tc-1',
            toolName: 'hapi_display_image',
            result: {
                content: [
                    { type: 'text', text: 'Here is the screenshot.' },
                    { type: 'image', data: ONE_PX_PNG, mimeType: 'image/png' },
                ],
                details: {},
            },
            isError: false
        });

        expect(result).toHaveLength(2);
        expect(result[0]).toEqual({
            type: 'tool_result',
            id: 'tc-1',
            output: 'Here is the screenshot.',
            status: 'completed',
        });
        expect(result[1]).toMatchObject({
            type: 'generated_image',
            mimeType: 'image/png',
            source: { ingress: 'tool_result', toolName: 'hapi_display_image', toolCallId: 'tc-1' },
        });
        expect(result[1]).toHaveProperty('imageId');
        expect(result[1]).toHaveProperty('fileName');
        ;
    });

    it('joins multiple text blocks and skips a malformed image block', async () => {
        const result = await convertPiEvent({
            type: 'tool_execution_end',
            toolCallId: 'tc-2',
            toolName: 'hapi_display_image',
            result: {
                content: [
                    { type: 'text', text: 'a' },
                    { type: 'image', data: 'not-base64!', mimeType: 'image/png' },
                    { type: 'text', text: 'b' },
                ],
                details: {},
            },
            isError: false
        });

        // Invalid image payload is dropped; the text blocks remain the result.
        expect(result).toEqual([{
            type: 'tool_result',
            id: 'tc-2',
            output: 'a\nb',
            status: 'completed',
        }]);
    });

    it('keeps a structured result without images as the plain text output', async () => {
        const result = await convertPiEvent({
            type: 'tool_execution_end',
            toolCallId: 'tc-3',
            toolName: 'bash',
            result: { content: [{ type: 'text', text: 'ok' }], details: {} },
            isError: false
        });

        expect(result).toEqual([{
            type: 'tool_result',
            id: 'tc-3',
            output: 'ok',
            status: 'completed',
        }]);
    });

    it('falls back to the raw result when content is not a block array', async () => {
        const raw = { some: 'other', shape: true };
        const result = await convertPiEvent({
            type: 'tool_execution_end',
            toolCallId: 'tc-4',
            toolName: 'bash',
            result: raw,
            isError: false
        });

        expect(result).toEqual([{
            type: 'tool_result',
            id: 'tc-4',
            output: raw,
            status: 'completed',
        }]);
    });

    it('should defer turn usage and convert only turn completion', async () => {
        const result = await convertPiEvent({
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

    it('should convert turn_end with toolUse stopReason', async () => {
        const result = await convertPiEvent({
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

    it('should convert turn_end without usage data', async () => {
        const result = await convertPiEvent({
            type: 'turn_end'
        });

        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({
            type: 'turn_complete',
            stopReason: 'stop'
        });
    });

    it('should return empty array for agent_start', async () => {
        expect(await convertPiEvent({ type: 'agent_start' })).toEqual([]);
    });

    it('should return empty array for agent_end', async () => {
        expect(await convertPiEvent({ type: 'agent_end', messages: [] })).toEqual([]);
    });

    it('should return empty array for response events', async () => {
        // Response events use a different type, but we handle gracefully
        expect(await convertPiEvent({ type: 'response', command: 'prompt', success: true } as unknown as PiAgentEvent)).toEqual([]);
    });

    it('should return empty array for turn_start', async () => {
        expect(await convertPiEvent({ type: 'turn_start' })).toEqual([]);
    });

    it('should return empty array for unknown event types', async () => {
        expect(await convertPiEvent({ type: 'something_else' })).toEqual([]);
    });

    it('should not crash on unexpected data structure (safety net)', async () => {
        // Simulate a malformed event that somehow passes through
        const weird = Object.create(null);
        weird.type = 'message_update';
        weird.assistantMessageEvent = undefined;
        // Should not throw
        await expect(convertPiEvent(weird as unknown as PiAgentEvent)).resolves.toEqual([]);
    });
});
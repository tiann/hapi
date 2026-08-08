import { describe, expect, it } from 'vitest';
import { convertAgentMessage } from './messageConverter';

describe('convertAgentMessage', () => {
    it('preserves a stable text stream id on the message wire payload', () => {
        const converted = convertAgentMessage({
            type: 'text',
            text: 'partial response',
            id: 'text-stream-1',
            live: true,
            streamSnapshot: true
        });

        expect(converted).toEqual({
            type: 'message',
            message: 'partial response',
            id: 'text-stream-1',
            streamSnapshot: true
        });
    });

    it('keeps legacy text payloads free of a stream id', () => {
        const converted = convertAgentMessage({
            type: 'text',
            text: 'complete response'
        });

        expect(converted).toEqual({
            type: 'message',
            message: 'complete response'
        });
    });

    it('keeps tool-call status when converting ACP tool events', () => {
        const converted = convertAgentMessage({
            type: 'tool_call',
            id: 'call-1',
            name: 'Bash',
            input: { cmd: 'echo test' },
            status: 'completed'
        });

        expect(converted).toEqual({
            type: 'tool-call',
            callId: 'call-1',
            name: 'Bash',
            input: { cmd: 'echo test' },
            status: 'completed'
        });
    });

    it('preserves ACP native presentation metadata', () => {
        const converted = convertAgentMessage({
            type: 'tool_call',
            id: 'call-native',
            name: 'Bash',
            input: { command: 'free -h' },
            status: 'in_progress',
            title: 'Shell: free -h',
            kind: 'execute'
        });

        expect(converted).toMatchObject({
            nativeTitle: 'Shell: free -h',
            nativeKind: 'execute'
        });
    });

    it('preserves running tool progress without changing the tool input', () => {
        const converted = convertAgentMessage({
            type: 'tool_call',
            id: 'call-progress',
            name: 'Bash',
            input: { command: 'bun test' },
            status: 'in_progress',
            progress: { stdout: 'running tests...\\n' }
        });

        expect(converted).toEqual({
            type: 'tool-call',
            callId: 'call-progress',
            name: 'Bash',
            input: { command: 'bun test' },
            status: 'in_progress',
            progress: { stdout: 'running tests...\\n' }
        });
    });

    it('marks failed tool results as error', () => {
        const converted = convertAgentMessage({
            type: 'tool_result',
            id: 'call-2',
            output: { message: 'boom' },
            status: 'failed'
        });

        expect(converted).toEqual({
            type: 'tool-call-result',
            callId: 'call-2',
            output: { message: 'boom' },
            is_error: true
        });
    });

    it('preserves stable reasoning id when provided', () => {
        const converted = convertAgentMessage({
            type: 'reasoning',
            text: 'thinking',
            id: 'reasoning-stream-1'
        });

        expect(converted).toEqual({
            type: 'reasoning',
            message: 'thinking',
            id: 'reasoning-stream-1'
        });
    });

    it('converts error messages into codex error payloads', () => {
        const converted = convertAgentMessage({
            type: 'error',
            message: 'API quota exceeded.'
        });

        expect(converted).toEqual({
            type: 'error',
            message: 'API quota exceeded.'
        });
    });

    it('converts agent errors into error wire payloads', () => {
        const converted = convertAgentMessage({
            type: 'error',
            message: 'Cursor Agent failed: authentication required'
        });

        expect(converted).toEqual({
            type: 'error',
            message: 'Cursor Agent failed: authentication required'
        });
    });

    it('converts usage messages into token_count payloads', () => {
        const converted = convertAgentMessage({
            type: 'usage',
            inputTokens: 8_119,
            outputTokens: 2,
            cacheReadTokens: 5_760,
            thoughtTokens: 11,
            totalTokens: 13_892,
            contextTokens: 13_879,
            contextWindow: 65_536
        }, 'kimi-k2.5');

        expect(converted).toEqual({
            type: 'token_count',
            model: 'kimi-k2.5',
            usageSchema: 'hapi.usage.v1',
            inputTokenSemantics: 'includes-cache',
            info: {
                total: {
                    inputTokens: 13879,
                    outputTokens: 2,
                    cachedInputTokens: 5760,
                    thoughtTokens: 11,
                    totalTokens: 13892
                },
                contextTokens: 13879,
                modelContextWindow: 65536
            }
        });
    });

    it('includes cache creation in processed input', () => {
        const converted = convertAgentMessage({
            type: 'usage',
            inputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: 10,
            cacheCreationTokens: 5
        }, 'pi-model');

        expect(converted).toMatchObject({
            type: 'token_count',
            info: {
                total: {
                    inputTokens: 115,
                    outputTokens: 20,
                    cachedInputTokens: 10,
                    cacheWriteInputTokens: 5
                }
            }
        });
    });

    it('stamps unknown usage models explicitly', () => {
        const converted = convertAgentMessage({
            type: 'usage',
            inputTokens: 10,
            outputTokens: 2
        });

        expect(converted).toMatchObject({
            type: 'token_count',
            model: null,
            usageSchema: 'hapi.usage.v1',
            inputTokenSemantics: 'includes-cache'
        });
    });
    it('returns null instead of echoing an unrecognized message shape', () => {
        // Unreachable through the type system, but callers forward any non-null
        // result straight into the chat stream — so the runtime contract has to
        // be fail-closed.
        expect(convertAgentMessage({ type: 'not_a_real_type' } as never)).toBeNull();
    });

    it('converts generated_image messages into generated-image wire payloads', () => {
        const converted = convertAgentMessage({
            type: 'generated_image',
            imageId: 'img-1',
            fileName: 'inline.png',
            mimeType: 'image/png',
            source: { ingress: 'mcp', toolName: 'display_image' },
        });

        expect(converted).toMatchObject({
            type: 'generated-image',
            imageId: 'img-1',
            fileName: 'inline.png',
            mimeType: 'image/png',
            source: { ingress: 'mcp', toolName: 'display_image' },
        });
        expect(converted && 'id' in converted && typeof converted.id === 'string').toBe(true);
    });
});

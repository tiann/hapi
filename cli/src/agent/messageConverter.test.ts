import { describe, expect, it } from 'vitest';
import { convertAgentMessage } from './messageConverter';

describe('convertAgentMessage', () => {
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
        });

        expect(converted).toEqual({
            type: 'token_count',
            info: {
                total: {
                    inputTokens: 8119,
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
});

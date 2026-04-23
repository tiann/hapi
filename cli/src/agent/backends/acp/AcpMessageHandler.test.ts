import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@/agent/types';
import { AcpMessageHandler } from './AcpMessageHandler';
import { ACP_SESSION_UPDATE_TYPES } from './constants';

function getToolResult(messages: AgentMessage[], id: string): Extract<AgentMessage, { type: 'tool_result' }> {
    const result = messages.find((message): message is Extract<AgentMessage, { type: 'tool_result' }> =>
        message.type === 'tool_result' && message.id === id
    );
    if (!result) {
        throw new Error(`Missing tool_result for ${id}`);
    }
    return result;
}

describe('AcpMessageHandler', () => {
    it('does not synthesize {status} output when tool completes without payload', () => {
        const messages: AgentMessage[] = [];
        const handler = new AcpMessageHandler((message) => messages.push(message));

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
            toolCallId: 'tool-1',
            title: 'Read',
            rawInput: { path: 'README.md' },
            status: 'in_progress'
        });

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCallUpdate,
            toolCallId: 'tool-1',
            status: 'completed'
        });

        const result = getToolResult(messages, 'tool-1');
        expect(result.status).toBe('completed');
        expect(result.output).toBeUndefined();
    });

    it('keeps raw output when provided by ACP update', () => {
        const messages: AgentMessage[] = [];
        const handler = new AcpMessageHandler((message) => messages.push(message));

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
            toolCallId: 'tool-2',
            title: 'Bash',
            rawInput: { cmd: 'echo ok' },
            status: 'in_progress'
        });

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCallUpdate,
            toolCallId: 'tool-2',
            status: 'completed',
            rawOutput: { stdout: 'ok\n' }
        });

        const result = getToolResult(messages, 'tool-2');
        expect(result.status).toBe('completed');
        expect(result.output).toEqual({ stdout: 'ok\n' });
    });

    it('preserves intra-turn interleave order: text → tool_call → tool_result', () => {
        const messages: AgentMessage[] = [];
        const handler = new AcpMessageHandler((message) => messages.push(message));

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
            content: { type: 'text', text: 'thinking first' }
        });

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
            toolCallId: 'tool-itr-1',
            title: 'Read',
            rawInput: { path: 'README.md' },
            status: 'in_progress'
        });

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCallUpdate,
            toolCallId: 'tool-itr-1',
            status: 'completed',
            rawOutput: { content: 'ok' }
        });

        handler.flushText();

        expect(messages.map((m) => m.type)).toEqual(['text', 'tool_call', 'tool_result']);
        expect(messages[0]).toEqual({ type: 'text', text: 'thinking first' });
    });

    it('preserves intra-turn interleave order: text → tool → text → tool', () => {
        const messages: AgentMessage[] = [];
        const handler = new AcpMessageHandler((message) => messages.push(message));

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
            content: { type: 'text', text: 'step one' }
        });

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
            toolCallId: 'tool-itr-2a',
            title: 'Bash',
            rawInput: { cmd: 'ls' },
            status: 'in_progress'
        });

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCallUpdate,
            toolCallId: 'tool-itr-2a',
            status: 'completed',
            rawOutput: { stdout: 'file.txt' }
        });

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
            content: { type: 'text', text: 'step two' }
        });

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
            toolCallId: 'tool-itr-2b',
            title: 'Read',
            rawInput: { path: 'file.txt' },
            status: 'in_progress'
        });

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCallUpdate,
            toolCallId: 'tool-itr-2b',
            status: 'completed',
            rawOutput: { content: 'hello' }
        });

        handler.flushText();

        expect(messages.map((m) => m.type)).toEqual([
            'text', 'tool_call', 'tool_result',
            'text', 'tool_call', 'tool_result'
        ]);
    });

    it('preserves dedup base when text arrives between toolCall and toolCallUpdate', () => {
        // Regression: while a tool call is in flight the agent may stream
        // additional text as cumulative deltas. tool_call_update must not
        // flush that buffer mid-segment: doing so would both reorder the
        // text (emit before tool_result) and reset the dedup baseline, so
        // the next cumulative chunk would re-emit content already visible.
        const messages: AgentMessage[] = [];
        const handler = new AcpMessageHandler((message) => messages.push(message));

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
            content: { type: 'text', text: 'init' }
        });

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
            toolCallId: 'tool-mid',
            title: 'Bash',
            rawInput: { cmd: 'long' },
            status: 'in_progress'
        });

        // Cumulative chunks arrive WHILE the tool is still running:
        // "live " then "live update" — the second starts with the first,
        // which exercises the dedup branch in appendTextChunk.
        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
            content: { type: 'text', text: 'live ' }
        });
        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
            content: { type: 'text', text: 'live update' }
        });

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCallUpdate,
            toolCallId: 'tool-mid',
            status: 'completed',
            rawOutput: { stdout: 'done' }
        });

        handler.flushText();

        expect(messages.map((m) => m.type)).toEqual(['text', 'tool_call', 'tool_result', 'text']);
        const textMessages = messages.filter((m) => m.type === 'text') as Array<{ type: 'text'; text: string }>;
        expect(textMessages).toHaveLength(2);
        expect(textMessages[0].text).toBe('init');
        expect(textMessages[1].text).toBe('live update');
    });

    it('deduplicates overlapping text chunks within the same text segment across tool boundaries', () => {
        // Cumulative dedup should still work within each text segment separated by tool events.
        const messages: AgentMessage[] = [];
        const handler = new AcpMessageHandler((message) => messages.push(message));

        // First text segment: cumulative chunks ("hello " → "hello world")
        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
            content: { type: 'text', text: 'hello ' }
        });
        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
            content: { type: 'text', text: 'hello world' }
        });

        // Tool boundary flushes the first segment
        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
            toolCallId: 'tool-dedup',
            title: 'Bash',
            rawInput: { cmd: 'ls' },
            status: 'in_progress'
        });

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCallUpdate,
            toolCallId: 'tool-dedup',
            status: 'completed',
            rawOutput: { stdout: '' }
        });

        // Second text segment: cumulative chunks ("bye" → "bye bye")
        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
            content: { type: 'text', text: 'bye' }
        });
        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
            content: { type: 'text', text: 'bye bye' }
        });

        handler.flushText();

        const textMessages = messages.filter((m) => m.type === 'text') as Array<{ type: 'text'; text: string }>;
        expect(textMessages).toHaveLength(2);
        expect(textMessages[0].text).toBe('hello world');
        expect(textMessages[1].text).toBe('bye bye');
    });

    it('ignores text chunks targeted only to user audience', () => {
        const messages: AgentMessage[] = [];
        const handler = new AcpMessageHandler((message) => messages.push(message));

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
            content: {
                type: 'text',
                text: 'user-visible only',
                annotations: {
                    audience: ['user']
                }
            }
        });

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
            content: {
                type: 'text',
                text: 'assistant-visible',
                annotations: {
                    audience: ['assistant']
                }
            }
        });

        handler.flushText();

        expect(messages).toEqual([{ type: 'text', text: 'assistant-visible' }]);
    });

    it('supports annotations array format for audience filtering', () => {
        const messages: AgentMessage[] = [];
        const handler = new AcpMessageHandler((message) => messages.push(message));

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
            content: {
                type: 'text',
                text: 'user-only',
                annotations: [
                    {
                        audience: ['user']
                    }
                ]
            }
        });

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
            content: {
                type: 'text',
                text: 'assistant-only',
                annotations: [
                    {
                        audience: ['assistant']
                    }
                ]
            }
        });

        handler.flushText();

        expect(messages).toEqual([{ type: 'text', text: 'assistant-only' }]);
    });

    it('supports annotations object value.audience format for filtering', () => {
        const messages: AgentMessage[] = [];
        const handler = new AcpMessageHandler((message) => messages.push(message));

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
            content: {
                type: 'text',
                text: 'user-only',
                annotations: {
                    value: {
                        audience: ['user']
                    }
                }
            }
        });

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
            content: {
                type: 'text',
                text: 'assistant-only',
                annotations: {
                    value: {
                        audience: ['assistant']
                    }
                }
            }
        });

        handler.flushText();

        expect(messages).toEqual([{ type: 'text', text: 'assistant-only' }]);
    });

    it('deduplicates overlapping text chunks', () => {
        const messages: AgentMessage[] = [];
        const handler = new AcpMessageHandler((message) => messages.push(message));

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
            content: { type: 'text', text: 'hello wo' }
        });

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
            content: { type: 'text', text: 'world' }
        });

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
            content: { type: 'text', text: 'world' }
        });

        handler.flushText();

        expect(messages).toEqual([{ type: 'text', text: 'hello world' }]);
    });

    it('keeps existing tool name when update only has kind fallback', () => {
        const messages: AgentMessage[] = [];
        const handler = new AcpMessageHandler((message) => messages.push(message));

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
            toolCallId: 'tool-4',
            title: 'hapi_change_title',
            rawInput: { title: 'A' },
            status: 'in_progress'
        });

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCallUpdate,
            toolCallId: 'tool-4',
            kind: 'other',
            rawInput: { title: 'B' },
            status: 'in_progress'
        });

        const calls = messages.filter((message): message is Extract<AgentMessage, { type: 'tool_call' }> =>
            message.type === 'tool_call'
        );
        expect(calls).toHaveLength(2);
        expect(calls[0].name).toBe('hapi_change_title');
        expect(calls[1].name).toBe('hapi_change_title');
    });

    it('intercepts rate_limit_event chunk before it enters the text buffer', () => {
        const messages: AgentMessage[] = [];
        const handler = new AcpMessageHandler((message) => messages.push(message));

        // Normal text chunk first
        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
            content: { type: 'text', text: 'thinking...' }
        });

        // rate_limit_event arrives as a separate chunk in the same turn
        const rateLimitJson = JSON.stringify({
            type: 'rate_limit_event',
            rate_limit_info: {
                status: 'allowed_warning',
                resetsAt: 1774278000,
                rateLimitType: 'five_hour',
                utilization: 0.9,
            },
        });
        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
            content: { type: 'text', text: rateLimitJson }
        });

        handler.flushText();

        // The normal text should be preserved
        const textMessages = messages.filter(m => m.type === 'text');
        expect(textMessages).toHaveLength(2);
        // First: the normal text
        expect(textMessages[0]).toEqual({ type: 'text', text: 'thinking...' });
        // Second: the converted rate limit warning (not raw JSON)
        expect((textMessages[1] as { text: string }).text).toMatch(/^Claude AI usage limit warning\|/);
    });

    it('suppresses allowed rate_limit_event chunk without affecting text buffer', () => {
        const messages: AgentMessage[] = [];
        const handler = new AcpMessageHandler((message) => messages.push(message));

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
            content: { type: 'text', text: 'hello' }
        });

        const allowedJson = JSON.stringify({
            type: 'rate_limit_event',
            rate_limit_info: {
                status: 'allowed',
                resetsAt: 1774278000,
            },
        });
        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
            content: { type: 'text', text: allowedJson }
        });

        handler.flushText();

        // Only the normal text, no rate limit noise
        expect(messages).toEqual([{ type: 'text', text: 'hello' }]);
    });

    it('does not split text buffer when suppressing allowed event mid-stream', () => {
        const messages: AgentMessage[] = [];
        const handler = new AcpMessageHandler((message) => messages.push(message));

        // text → allowed → text → flush should produce ONE merged text message
        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
            content: { type: 'text', text: 'part one ' }
        });

        const allowedJson = JSON.stringify({
            type: 'rate_limit_event',
            rate_limit_info: { status: 'allowed', resetsAt: 1774278000 },
        });
        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
            content: { type: 'text', text: allowedJson }
        });

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
            content: { type: 'text', text: 'part two' }
        });

        handler.flushText();

        // Must be a single text message, not split into two
        expect(messages).toEqual([{ type: 'text', text: 'part one part two' }]);
    });

    it('allows kind fallback to replace placeholder tool name', () => {
        const messages: AgentMessage[] = [];
        const handler = new AcpMessageHandler((message) => messages.push(message));

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
            toolCallId: 'tool-5',
            rawInput: { foo: 'bar' },
            status: 'in_progress'
        });

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCallUpdate,
            toolCallId: 'tool-5',
            kind: 'search',
            rawInput: { foo: 'baz' },
            status: 'in_progress'
        });

        const calls = messages.filter((message): message is Extract<AgentMessage, { type: 'tool_call' }> =>
            message.type === 'tool_call'
        );
        expect(calls).toHaveLength(2);
        expect(calls[0].name).toBe('Tool');
        expect(calls[1].name).toBe('search');
    });

    it('drops leaked session metadata envelope from text buffer', () => {
        const messages: AgentMessage[] = [];
        const handler = new AcpMessageHandler((message) => messages.push(message));

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
            content: { type: 'text', text: 'real answer' }
        });

        // Leaked metadata envelope with parentUuid string
        const metadataJson = JSON.stringify({
            type: 'output',
            data: {
                parentUuid: 'abc-123',
                isSidechain: false,
                userType: 'external',
                sessionId: 'session-456',
                version: '0.0.0',
            },
        });
        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
            content: { type: 'text', text: metadataJson }
        });

        handler.flushText();

        expect(messages).toEqual([{ type: 'text', text: 'real answer' }]);
    });

    it('drops leaked root metadata envelope with parentUuid: null', () => {
        const messages: AgentMessage[] = [];
        const handler = new AcpMessageHandler((message) => messages.push(message));

        const metadataJson = JSON.stringify({
            type: 'output',
            data: {
                parentUuid: null,
                sessionId: 'session-789',
                userType: 'external',
            },
        });
        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
            content: { type: 'text', text: metadataJson }
        });

        handler.flushText();

        expect(messages).toEqual([]);
    });

    it('clears buffered prefix when cumulative metadata chunk arrives', () => {
        const messages: AgentMessage[] = [];
        const handler = new AcpMessageHandler((message) => messages.push(message));

        // First chunk: incomplete JSON prefix
        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
            content: { type: 'text', text: '{"type":"ou' }
        });

        // Second chunk: full cumulative metadata JSON (starts with buffered prefix)
        const metadataJson = JSON.stringify({
            type: 'output',
            data: {
                parentUuid: 'abc-123',
                sessionId: 'session-456',
                userType: 'external',
            },
        });
        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
            content: { type: 'text', text: metadataJson }
        });

        handler.flushText();

        // Both the prefix and the full chunk should be gone
        expect(messages).toEqual([]);
    });

    it('clears buffered prefix when cumulative rate_limit_event chunk arrives', () => {
        const messages: AgentMessage[] = [];
        const handler = new AcpMessageHandler((message) => messages.push(message));

        // First chunk: incomplete JSON prefix
        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
            content: { type: 'text', text: '{"type":"rate' }
        });

        // Second chunk: full cumulative rate_limit_event (allowed — should be suppressed)
        const rateLimitJson = JSON.stringify({
            type: 'rate_limit_event',
            rate_limit_info: {
                status: 'allowed',
                resetsAt: 1774278000,
            },
        });
        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
            content: { type: 'text', text: rateLimitJson }
        });

        handler.flushText();

        // Both the prefix and the full chunk should be gone
        expect(messages).toEqual([]);
    });

    it('clears buffered prefix when cumulative displayable rate_limit_event arrives', () => {
        const messages: AgentMessage[] = [];
        const handler = new AcpMessageHandler((message) => messages.push(message));

        // First chunk: incomplete prefix
        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
            content: { type: 'text', text: '{"type":"rate' }
        });

        // Second chunk: full rate_limit_event with displayable status
        const rateLimitJson = JSON.stringify({
            type: 'rate_limit_event',
            rate_limit_info: {
                status: 'allowed_warning',
                resetsAt: 1774278000,
                utilization: 0.9,
                rateLimitType: 'five_hour',
            },
        });
        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
            content: { type: 'text', text: rateLimitJson }
        });

        handler.flushText();

        // Should only have the converted warning, no raw JSON prefix
        expect(messages).toHaveLength(1);
        expect((messages[0] as { text: string }).text).toMatch(/^Claude AI usage limit warning\|/);
    });

    it('forwards agent_thought_chunk as a reasoning message', () => {
        const messages: AgentMessage[] = [];
        const handler = new AcpMessageHandler((message) => messages.push(message));

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentThoughtChunk,
            content: { type: 'text', text: 'thinking about the problem' }
        });

        expect(messages).toHaveLength(1);
        expect(messages[0]).toEqual({ type: 'reasoning', text: 'thinking about the problem' });
    });

    it('silently drops agent_thought_chunk when content is not a text block', () => {
        const messages: AgentMessage[] = [];
        const handler = new AcpMessageHandler((message) => messages.push(message));

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentThoughtChunk,
            content: { type: 'image', url: 'https://example.com/img.png' }
        });

        expect(messages).toHaveLength(0);
    });

    it('does not flush the text buffer when a thought chunk arrives mid-stream', () => {
        const messages: AgentMessage[] = [];
        const handler = new AcpMessageHandler((message) => messages.push(message));

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
            content: { type: 'text', text: 'partial answer' }
        });

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentThoughtChunk,
            content: { type: 'text', text: 'mid-stream thought' }
        });

        handler.flushText();

        // Both messages are delivered intact with no loss. Reasoning is
        // emitted inline (see AcpMessageHandler) so it precedes the
        // flushed text segment — this is an intentional contract to let
        // thoughts and text interleave without splitting a live segment.
        expect(messages).toHaveLength(2);
        expect(messages).toContainEqual({ type: 'reasoning', text: 'mid-stream thought' });
        expect(messages).toContainEqual({ type: 'text', text: 'partial answer' });
        expect(messages[0]).toEqual({ type: 'reasoning', text: 'mid-stream thought' });
    });

    it('does not drop thought chunks annotated with a non-assistant audience', () => {
        const messages: AgentMessage[] = [];
        const handler = new AcpMessageHandler((message) => messages.push(message));

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentThoughtChunk,
            content: {
                type: 'text',
                text: 'private reasoning',
                annotations: { audience: ['user'] }
            }
        });

        expect(messages).toHaveLength(1);
        expect(messages[0]).toEqual({ type: 'reasoning', text: 'private reasoning' });
    });

    it('forwards sequential thought chunks in arrival order as separate reasoning messages', () => {
        const messages: AgentMessage[] = [];
        const handler = new AcpMessageHandler((message) => messages.push(message));

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentThoughtChunk,
            content: { type: 'text', text: 'first thought' }
        });
        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentThoughtChunk,
            content: { type: 'text', text: 'second thought' }
        });
        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentThoughtChunk,
            content: { type: 'text', text: 'third thought' }
        });

        expect(messages).toEqual([
            { type: 'reasoning', text: 'first thought' },
            { type: 'reasoning', text: 'second thought' },
            { type: 'reasoning', text: 'third thought' }
        ]);
    });

    it('silently drops agent_thought_chunk with empty text', () => {
        const messages: AgentMessage[] = [];
        const handler = new AcpMessageHandler((message) => messages.push(message));

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentThoughtChunk,
            content: { type: 'text', text: '' }
        });

        expect(messages).toHaveLength(0);
    });

    it.each([
        ['null', null],
        ['undefined', undefined],
        ['number', 42],
        ['string', 'not a block'],
        ['array', ['text']]
    ])('silently drops agent_thought_chunk when content is %s', (_label, content) => {
        const messages: AgentMessage[] = [];
        const handler = new AcpMessageHandler((message) => messages.push(message));

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentThoughtChunk,
            content
        });

        expect(messages).toHaveLength(0);
    });
});

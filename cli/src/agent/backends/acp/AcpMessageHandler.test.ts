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

    describe('tool_call_update content normalization (Gemini/OpenCode path)', () => {
        it('unwraps text content block to string output', () => {
            // Gemini sends content: [{type:'content', content:{type:'text', text:'...'}}]
            // when the tool has stdout. HAPI must normalize this to a plain string.
            const messages: AgentMessage[] = [];
            const handler = new AcpMessageHandler((message) => messages.push(message));

            handler.handleUpdate({
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
                toolCallId: 'gem-1',
                title: 'shell',
                rawInput: { cmd: 'echo hello' },
                status: 'in_progress'
            });

            handler.handleUpdate({
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCallUpdate,
                toolCallId: 'gem-1',
                status: 'completed',
                content: [{ type: 'content', content: { type: 'text', text: 'hello\n' } }]
            });

            const result = getToolResult(messages, 'gem-1');
            expect(result.status).toBe('completed');
            expect(result.output).toBe('hello\n');
        });

        it('normalizes empty content array to empty string output', () => {
            // Gemini sends content: [] when returnDisplay is falsy (no visible output).
            // Raw [] must not be forwarded to the web renderer.
            const messages: AgentMessage[] = [];
            const handler = new AcpMessageHandler((message) => messages.push(message));

            handler.handleUpdate({
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
                toolCallId: 'gem-2',
                title: 'shell',
                rawInput: { cmd: 'touch file' },
                status: 'in_progress'
            });

            handler.handleUpdate({
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCallUpdate,
                toolCallId: 'gem-2',
                status: 'completed',
                content: []
            });

            const result = getToolResult(messages, 'gem-2');
            expect(result.status).toBe('completed');
            expect(result.output).toBe('');
        });

        it('preserves diff content block fields in output', () => {
            // Gemini sends content: [{type:'diff', path, oldText, newText, _meta:{kind}}]
            // for file-edit tools. HAPI must surface these fields intact.
            const messages: AgentMessage[] = [];
            const handler = new AcpMessageHandler((message) => messages.push(message));

            handler.handleUpdate({
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
                toolCallId: 'gem-3',
                title: 'write_file',
                rawInput: { path: 'src/foo.ts' },
                status: 'in_progress'
            });

            handler.handleUpdate({
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCallUpdate,
                toolCallId: 'gem-3',
                status: 'completed',
                content: [{
                    type: 'diff',
                    path: 'src/foo.ts',
                    oldText: 'old content',
                    newText: 'new content',
                    _meta: { kind: 'modify' }
                }]
            });

            const result = getToolResult(messages, 'gem-3');
            expect(result.status).toBe('completed');
            expect(result.output).toEqual({
                path: 'src/foo.ts',
                oldText: 'old content',
                newText: 'new content',
                kind: 'modify'
            });
        });

        it('prefers rawOutput over content when both are present (regression guard)', () => {
            // Claude/Codex always send rawOutput. If both fields arrive, rawOutput wins
            // and the ACP content array is ignored to preserve existing behavior.
            const messages: AgentMessage[] = [];
            const handler = new AcpMessageHandler((message) => messages.push(message));

            handler.handleUpdate({
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
                toolCallId: 'reg-1',
                title: 'Bash',
                rawInput: { cmd: 'ls' },
                status: 'in_progress'
            });

            handler.handleUpdate({
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCallUpdate,
                toolCallId: 'reg-1',
                status: 'completed',
                rawOutput: { stdout: 'file.txt\n' },
                content: [{ type: 'content', content: { type: 'text', text: 'should be ignored' } }]
            });

            const result = getToolResult(messages, 'reg-1');
            expect(result.status).toBe('completed');
            expect(result.output).toEqual({ stdout: 'file.txt\n' });
        });

        it('passes through non-array content value unchanged when rawOutput is absent', () => {
            // If an ACP agent sends content as a non-array value (e.g. a plain string or
            // object), normalizeAcpToolContent returns null and we fall back to the
            // original content to avoid silent data loss.
            const messages: AgentMessage[] = [];
            const handler = new AcpMessageHandler((message) => messages.push(message));

            handler.handleUpdate({
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
                toolCallId: 'reg-2',
                title: 'Bash',
                rawInput: { cmd: 'ls' },
                status: 'in_progress'
            });

            handler.handleUpdate({
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCallUpdate,
                toolCallId: 'reg-2',
                status: 'completed',
                content: { stdout: 'file.txt\n' }
            });

            const result = getToolResult(messages, 'reg-2');
            expect(result.status).toBe('completed');
            expect(result.output).toEqual({ stdout: 'file.txt\n' });
        });

        it('falls back to raw content for mixed text+diff array (null from normalizer)', () => {
            // A mixed array [{type:'content',...}, {type:'diff',...}] cannot be safely
            // collapsed into either a string or a single diff object without losing data.
            // normalizeAcpToolContent must return null so the caller falls back to the
            // original content array, preserving all information.
            const messages: AgentMessage[] = [];
            const handler = new AcpMessageHandler((message) => messages.push(message));

            const mixedContent = [
                { type: 'content', content: { type: 'text', text: 'some stdout' } },
                { type: 'diff', path: 'src/foo.ts', oldText: 'old', newText: 'new', _meta: { kind: 'modify' } }
            ];

            handler.handleUpdate({
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
                toolCallId: 'mixed-1',
                title: 'run_and_edit',
                rawInput: { cmd: 'patch' },
                status: 'in_progress'
            });

            handler.handleUpdate({
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCallUpdate,
                toolCallId: 'mixed-1',
                status: 'completed',
                content: mixedContent
            });

            const result = getToolResult(messages, 'mixed-1');
            expect(result.status).toBe('completed');
            // Must fall back to original content array — no information loss
            expect(result.output).toEqual(mixedContent);
        });

        it('falls back to raw content for multi-diff array (null from normalizer)', () => {
            // Multiple diff blocks cannot be collapsed into a single diff object.
            // normalizeAcpToolContent must return null so we keep the full array.
            const messages: AgentMessage[] = [];
            const handler = new AcpMessageHandler((message) => messages.push(message));

            const multiDiffContent = [
                { type: 'diff', path: 'a.ts', oldText: 'a-old', newText: 'a-new', _meta: { kind: 'modify' } },
                { type: 'diff', path: 'b.ts', oldText: 'b-old', newText: 'b-new', _meta: { kind: 'modify' } }
            ];

            handler.handleUpdate({
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
                toolCallId: 'multidiff-1',
                title: 'edit_files',
                rawInput: { files: ['a.ts', 'b.ts'] },
                status: 'in_progress'
            });

            handler.handleUpdate({
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCallUpdate,
                toolCallId: 'multidiff-1',
                status: 'completed',
                content: multiDiffContent
            });

            const result = getToolResult(messages, 'multidiff-1');
            expect(result.status).toBe('completed');
            // Must fall back to original content array — no information loss
            expect(result.output).toEqual(multiDiffContent);
        });

        it('falls back to raw content for unknown block type (null from normalizer)', () => {
            // An unrecognized block type (e.g. {type:'image',...}) cannot be safely
            // normalized. We must return null and let the caller fall back to the original
            // content to avoid silent data loss.
            const messages: AgentMessage[] = [];
            const handler = new AcpMessageHandler((message) => messages.push(message));

            const unknownContent = [
                { type: 'image', url: 'https://example.com/screenshot.png' }
            ];

            handler.handleUpdate({
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
                toolCallId: 'unknown-1',
                title: 'screenshot',
                rawInput: { url: 'https://example.com' },
                status: 'in_progress'
            });

            handler.handleUpdate({
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCallUpdate,
                toolCallId: 'unknown-1',
                status: 'completed',
                content: unknownContent
            });

            const result = getToolResult(messages, 'unknown-1');
            expect(result.status).toBe('completed');
            // Must fall back to original content array — no information loss
            expect(result.output).toEqual(unknownContent);
        });
    });

    describe('tool_call input fallback from kind+title (Gemini sends neither rawInput nor JSON thought)', () => {
        it('derives { file_path } from read kind + title', () => {
            const messages: AgentMessage[] = [];
            const handler = new AcpMessageHandler((message) => messages.push(message));

            handler.handleUpdate({
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
                toolCallId: 'fb-read',
                title: 'README.md',
                kind: 'read',
                status: 'in_progress'
            });

            const toolCall = messages.find(
                (m): m is Extract<AgentMessage, { type: 'tool_call' }> => m.type === 'tool_call'
            );
            expect(toolCall!.input).toEqual({ file_path: 'README.md' });
        });

        it('derives { command } from execute kind + title', () => {
            const messages: AgentMessage[] = [];
            const handler = new AcpMessageHandler((message) => messages.push(message));

            handler.handleUpdate({
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
                toolCallId: 'fb-exec',
                title: 'ls -la /tmp',
                kind: 'execute',
                status: 'in_progress'
            });

            const toolCall = messages.find(
                (m): m is Extract<AgentMessage, { type: 'tool_call' }> => m.type === 'tool_call'
            );
            expect(toolCall!.input).toEqual({ command: 'ls -la /tmp' });
        });

        it('derives { pattern } from search kind + title', () => {
            const messages: AgentMessage[] = [];
            const handler = new AcpMessageHandler((message) => messages.push(message));

            handler.handleUpdate({
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
                toolCallId: 'fb-search',
                title: "'**/AGENTS.md'",
                kind: 'search',
                status: 'in_progress'
            });

            const toolCall = messages.find(
                (m): m is Extract<AgentMessage, { type: 'tool_call' }> => m.type === 'tool_call'
            );
            expect(toolCall!.input).toEqual({ pattern: "'**/AGENTS.md'" });
        });

        it('keeps input null for think kind (no semantic args mapping)', () => {
            // think tool_calls carry topic-update text in title that has no clean
            // mapping to a tool argument shape. Better to leave input null than to
            // fabricate a misleading derived object.
            const messages: AgentMessage[] = [];
            const handler = new AcpMessageHandler((message) => messages.push(message));

            handler.handleUpdate({
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
                toolCallId: 'fb-think',
                title: 'Update topic to: "Researching Project Overview"',
                kind: 'think',
                status: 'in_progress'
            });

            const toolCall = messages.find(
                (m): m is Extract<AgentMessage, { type: 'tool_call' }> => m.type === 'tool_call'
            );
            expect(toolCall!.input).toBeNull();
        });

        it('keeps input null for unknown kind (conservative — only known kinds derive)', () => {
            const messages: AgentMessage[] = [];
            const handler = new AcpMessageHandler((message) => messages.push(message));

            handler.handleUpdate({
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
                toolCallId: 'fb-unknown',
                title: 'something exotic',
                kind: 'futuristic_kind',
                status: 'in_progress'
            });

            const toolCall = messages.find(
                (m): m is Extract<AgentMessage, { type: 'tool_call' }> => m.type === 'tool_call'
            );
            expect(toolCall!.input).toBeNull();
        });

        it('keeps input null when title is missing even for known kind', () => {
            const messages: AgentMessage[] = [];
            const handler = new AcpMessageHandler((message) => messages.push(message));

            handler.handleUpdate({
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
                toolCallId: 'fb-no-title',
                kind: 'read',
                status: 'in_progress'
            });

            const toolCall = messages.find(
                (m): m is Extract<AgentMessage, { type: 'tool_call' }> => m.type === 'tool_call'
            );
            expect(toolCall!.input).toBeNull();
        });

        it('derives { file_path } from edit kind + locations[0].path (write/edit case)', () => {
            // Gemini emits write_file / replace under kind="edit" with rawInput
            // absent. The path lives on `locations[0].path` from the very first
            // tool_call event (title is prose like "Writing to foo.txt", which
            // is not a file_path candidate).
            const messages: AgentMessage[] = [];
            const handler = new AcpMessageHandler((message) => messages.push(message));

            handler.handleUpdate({
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
                toolCallId: 'fb-edit',
                title: 'Writing to foo.txt',
                kind: 'edit',
                locations: [{ path: '/abs/path/foo.txt' }],
                status: 'in_progress'
            });

            const toolCall = messages.find(
                (m): m is Extract<AgentMessage, { type: 'tool_call' }> => m.type === 'tool_call'
            );
            expect(toolCall!.input).toEqual({ file_path: '/abs/path/foo.txt' });
        });

        it('keeps input null for edit kind when locations is empty (no path to derive)', () => {
            // Title like "Writing to foo.txt" is prose, not a file path —
            // synthesizing a file_path from it would be misleading.
            const messages: AgentMessage[] = [];
            const handler = new AcpMessageHandler((message) => messages.push(message));

            handler.handleUpdate({
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
                toolCallId: 'fb-edit-no-loc',
                title: 'Writing to foo.txt',
                kind: 'edit',
                locations: [],
                status: 'in_progress'
            });

            const toolCall = messages.find(
                (m): m is Extract<AgentMessage, { type: 'tool_call' }> => m.type === 'tool_call'
            );
            expect(toolCall!.input).toBeNull();
        });

        it('rawInput wins over kind+title fallback (regression guard)', () => {
            const messages: AgentMessage[] = [];
            const handler = new AcpMessageHandler((message) => messages.push(message));

            handler.handleUpdate({
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
                toolCallId: 'fb-raw-wins',
                title: 'README.md',
                kind: 'read',
                rawInput: { file_path: 'EXPLICIT.md', extra: 'flag' },
                status: 'in_progress'
            });

            const toolCall = messages.find(
                (m): m is Extract<AgentMessage, { type: 'tool_call' }> => m.type === 'tool_call'
            );
            expect(toolCall!.input).toEqual({ file_path: 'EXPLICIT.md', extra: 'flag' });
        });

        it('applies the same fallback on tool_call_update (when rawInput stays absent)', () => {
            // tool_call_update may be the first place we learn kind/title for a
            // call that started as a placeholder. The fallback must still derive.
            const messages: AgentMessage[] = [];
            const handler = new AcpMessageHandler((message) => messages.push(message));

            handler.handleUpdate({
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
                toolCallId: 'fb-update',
                kind: 'execute',
                title: 'ls -la /tmp',
                status: 'in_progress'
            });

            handler.handleUpdate({
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCallUpdate,
                toolCallId: 'fb-update',
                kind: 'execute',
                title: 'ls -la /tmp',
                status: 'completed',
                content: [{ type: 'content', content: { type: 'text', text: 'demo\n' } }]
            });

            const calls = messages.filter(
                (m): m is Extract<AgentMessage, { type: 'tool_call' }> => m.type === 'tool_call'
            );
            // Both initial and update emit a tool_call with derived input.
            expect(calls.length).toBeGreaterThanOrEqual(1);
            for (const tc of calls) {
                expect(tc.input).toEqual({ command: 'ls -la /tmp' });
            }
        });
    });

    describe('real Gemini ACP fixtures (PR evidence)', () => {
        // Each fixture was captured from a live Gemini CLI session via ACP stdio.
        // These tests lock in the current behaviour under SHA a6f9379 so that
        // future changes to AcpMessageHandler cannot silently regress the
        // Gemini-specific handling.
        //
        // Observation from captured gemini-3-flash-preview: Gemini does NOT
        // include rawInput in tool_call events and emits prose (non-JSON)
        // thoughts. There is therefore no JSON-thought-hoisting trigger —
        // tool_call input is null and the thought text surfaces as reasoning.
        const fixtureDir = new URL('./__fixtures__', import.meta.url).pathname;

        const fixtures = [
            {
                // read_file capture has zero agent_thought_chunk events: this
                // model expresses reasoning as a `kind: think` tool_call rather
                // than as a thought chunk, so the reasoning channel is empty.
                name: 'gemini-3-flash-preview / read_file',
                file: `${fixtureDir}/gemini-3-flash-preview-read-file.json`,
                expectedMinToolCalls: 2,
                expectedMinReasoning: 0,
                hasMessageChunks: true,
            },
            {
                name: 'gemini-3-flash-preview / run_shell',
                file: `${fixtureDir}/gemini-3-flash-preview-run-shell.json`,
                expectedMinToolCalls: 1,
                expectedMinReasoning: 1,
                hasMessageChunks: true,
            },
            {
                // write_file: kind=edit, locations carries the file path.
                // Same shape (and zero thought chunks) as read_file.
                name: 'gemini-3-flash-preview / write_file',
                file: `${fixtureDir}/gemini-3-flash-preview-write-file.json`,
                expectedMinToolCalls: 2,
                expectedMinReasoning: 0,
                hasMessageChunks: true,
            },
            {
                // replace (in-place edit): same kind=edit + locations pattern.
                name: 'gemini-3-flash-preview / edit_file',
                file: `${fixtureDir}/gemini-3-flash-preview-edit-file.json`,
                expectedMinToolCalls: 2,
                expectedMinReasoning: 0,
                hasMessageChunks: true,
            },
            // ── gemini-3.1-pro-preview captures (live ACP, 2026-05-04) ──
            // Same handler shape (rawInput omitted, kind+title fallback drives
            // input derivation). The pro tier reuses the same think/read/
            // execute/edit kinds and emits prose thoughts (not JSON), so the
            // assertions below match the flash captures.
            {
                name: 'gemini-3.1-pro-preview / read_file',
                file: `${fixtureDir}/gemini-3.1-pro-preview-read-file.json`,
                expectedMinToolCalls: 2,
                expectedMinReasoning: 0,
                hasMessageChunks: true,
            },
            {
                // run_shell: pro emits a single agent_thought_chunk in addition
                // to the execute tool_call.
                name: 'gemini-3.1-pro-preview / run_shell',
                file: `${fixtureDir}/gemini-3.1-pro-preview-run-shell.json`,
                expectedMinToolCalls: 1,
                expectedMinReasoning: 1,
                hasMessageChunks: true,
            },
            {
                // write_file: kind=edit, locations carries the file path.
                name: 'gemini-3.1-pro-preview / write_file',
                file: `${fixtureDir}/gemini-3.1-pro-preview-write-file.json`,
                expectedMinToolCalls: 1,
                expectedMinReasoning: 0,
                hasMessageChunks: true,
            },
            {
                // replace (in-place edit): pro version interleaves think + read
                // + edit kinds before the final agent_message_chunk burst.
                name: 'gemini-3.1-pro-preview / edit_file',
                file: `${fixtureDir}/gemini-3.1-pro-preview-edit-file.json`,
                expectedMinToolCalls: 2,
                expectedMinReasoning: 0,
                hasMessageChunks: true,
            },
        ] as const;

        for (const fx of fixtures) {
            it(`replays ${fx.name} and produces sane AgentMessage stream`, () => {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const data = require(fx.file) as {
                    model: string;
                    scenario: string;
                    updates: unknown[];
                };

                const messages: AgentMessage[] = [];
                const handler = new AcpMessageHandler((m) => messages.push(m));
                for (const update of data.updates) {
                    handler.handleUpdate(update);
                }
                handler.flushText();

                // ── tool_call: at least one must have been emitted ────────────────
                const toolCalls = messages.filter(
                    (m): m is Extract<AgentMessage, { type: 'tool_call' }> => m.type === 'tool_call'
                );
                expect(toolCalls.length).toBeGreaterThanOrEqual(fx.expectedMinToolCalls);

                // ── tool_call.input: derived from kind+title fallback when rawInput
                //    and JSON thought are both absent. think kind has no semantic
                //    args mapping → input stays null; read/execute/search derive
                //    a typed object from the human-readable title. ───────────────
                // Identify think tool_calls by their original kind in the fixture
                // (deriveToolNameWithSource uses title first, so tc.name is the
                // title string for these — kind isn't on AgentMessage.tool_call).
                const thinkIds = new Set<string>();
                for (const update of data.updates) {
                    if (typeof update === 'object' && update !== null) {
                        const u = update as Record<string, unknown>;
                        if (u.sessionUpdate === 'tool_call' && u.kind === 'think') {
                            const id = typeof u.toolCallId === 'string' ? u.toolCallId : null;
                            if (id) thinkIds.add(id);
                        }
                    }
                }
                for (const tc of toolCalls) {
                    if (thinkIds.has(tc.id)) {
                        expect(tc.input).toBeNull();
                    } else {
                        // After fallback: read → {file_path}, execute → {command},
                        // search → {pattern}. tc.input must be a truthy object.
                        expect(tc.input).not.toBeNull();
                        expect(typeof tc.input).toBe('object');
                    }
                }

                // ── reasoning: at least one prose thought must have surfaced ───────
                const reasoningMsgs = messages.filter(
                    (m): m is Extract<AgentMessage, { type: 'reasoning' }> => m.type === 'reasoning'
                );
                expect(reasoningMsgs.length).toBeGreaterThanOrEqual(fx.expectedMinReasoning);

                // ── no JSON reasoning leak: no reasoning message should be a bare
                //    JSON object that was accidentally not hoisted into a tool_call ──
                for (const r of reasoningMsgs) {
                    const trimmed = r.text.trim();
                    const isLeakedJson = trimmed.startsWith('{') && trimmed.endsWith('}');
                    expect(isLeakedJson).toBe(false);
                }

                // ── text messages: none should be a raw JSON blob ─────────────────
                const textMsgs = messages.filter(
                    (m): m is Extract<AgentMessage, { type: 'text' }> => m.type === 'text'
                );
                for (const t of textMsgs) {
                    const trimmed = t.text.trim();
                    // A text message should never be a bare JSON object
                    const looksLikeJson = trimmed.startsWith('{') && trimmed.endsWith('}');
                    expect(looksLikeJson).toBe(false);
                }

                // ── optional: assert text messages exist for complete captures ─────
                if (fx.hasMessageChunks) {
                    expect(textMsgs.length).toBeGreaterThan(0);
                }
            });
        }
    });

    describe('kind=edit input hoist — Gemini write_file / replace → Claude-shaped input', () => {
        // Gemini ACP kind=edit tools carry the diff in the completed tool_call_update
        // content block rather than in rawInput. Map to canonical Claude shapes:
        //   - _meta.kind='add'    → toolName 'Write' + input {file_path, content: newText}
        //   - _meta.kind='modify' → toolName 'Edit'  + input {file_path, old_string, new_string}
        //   - _meta absent (race/inflight) → fallback: toolName unchanged, input {file_path: locations[0].path}

        function getToolCall(
            messages: AgentMessage[],
            id: string
        ): Extract<AgentMessage, { type: 'tool_call' }> {
            const tc = messages.find(
                (m): m is Extract<AgentMessage, { type: 'tool_call' }> =>
                    m.type === 'tool_call' && m.id === id
            );
            if (!tc) throw new Error(`Missing tool_call for ${id}`);
            return tc;
        }

        it('hoists add diff into Write-shaped input and sets toolName to Write', () => {
            // write_file: kind=edit, _meta.kind=add, oldText='', newText='...'
            // Expected: toolName=Write, input={file_path, content: newText}
            const messages: AgentMessage[] = [];
            const handler = new AcpMessageHandler((m) => messages.push(m));

            handler.handleUpdate({
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
                toolCallId: 'edit-add-1',
                title: 'Writing to foo.txt',
                kind: 'edit',
                locations: [{ path: '/abs/foo.txt' }],
                status: 'in_progress'
            });

            handler.handleUpdate({
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCallUpdate,
                toolCallId: 'edit-add-1',
                title: 'Writing to foo.txt',
                kind: 'edit',
                locations: [{ path: '/abs/foo.txt' }],
                status: 'completed',
                content: [{
                    type: 'diff',
                    path: '/abs/foo.txt',
                    oldText: '',
                    newText: 'line one\nline two\n',
                    _meta: { kind: 'add' }
                }]
            });

            // Last tool_call with this id should have Write name and content input
            const toolCalls = messages.filter(
                (m): m is Extract<AgentMessage, { type: 'tool_call' }> =>
                    m.type === 'tool_call' && m.id === 'edit-add-1'
            );
            const last = toolCalls[toolCalls.length - 1]!;
            expect(last.name).toBe('Write');
            expect(last.input).toEqual({
                file_path: '/abs/foo.txt',
                content: 'line one\nline two\n'
            });
        });

        it('hoists modify diff into Edit-shaped input and sets toolName to Edit', () => {
            // replace: kind=edit, _meta.kind=modify
            // Expected: toolName=Edit, input={file_path, old_string, new_string}
            const messages: AgentMessage[] = [];
            const handler = new AcpMessageHandler((m) => messages.push(m));

            handler.handleUpdate({
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
                toolCallId: 'edit-mod-1',
                title: 'foo.txt: old => new',
                kind: 'edit',
                locations: [{ path: '/abs/foo.txt' }],
                status: 'in_progress'
            });

            handler.handleUpdate({
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCallUpdate,
                toolCallId: 'edit-mod-1',
                title: 'foo.txt: old => new',
                kind: 'edit',
                locations: [{ path: '/abs/foo.txt' }],
                status: 'completed',
                content: [{
                    type: 'diff',
                    path: '/abs/foo.txt',
                    oldText: 'old content\n',
                    newText: 'new content\n',
                    _meta: { kind: 'modify' }
                }]
            });

            const toolCalls = messages.filter(
                (m): m is Extract<AgentMessage, { type: 'tool_call' }> =>
                    m.type === 'tool_call' && m.id === 'edit-mod-1'
            );
            const last = toolCalls[toolCalls.length - 1]!;
            expect(last.name).toBe('Edit');
            expect(last.input).toEqual({
                file_path: '/abs/foo.txt',
                old_string: 'old content\n',
                new_string: 'new content\n'
            });
        });

        it('sets {file_path} input from locations on initial in_progress event', () => {
            // Initial tool_call without content → fallback {file_path} only.
            // This covers the "race / inflight" case where no diff block has
            // arrived yet; hoist only fires on the completed update.
            const messages: AgentMessage[] = [];
            const handler = new AcpMessageHandler((m) => messages.push(m));

            handler.handleUpdate({
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
                toolCallId: 'edit-race-1',
                title: 'Writing to foo.txt',
                kind: 'edit',
                locations: [{ path: '/abs/foo.txt' }],
                status: 'in_progress'
            });

            const tc = getToolCall(messages, 'edit-race-1');
            // Must still have a file_path (from locations) but no content/old_string
            expect(tc.input).toEqual({ file_path: '/abs/foo.txt' });
        });

        it('emits hoisted tool_call { status: completed } before tool_result', () => {
            // Finding 3: verify emit order — reducerTools.ts merges tool_call updates
            // by id, so the hoisted Write/Edit name+input must arrive before the
            // tool_result that signals completion to the UI.
            const messages: AgentMessage[] = [];
            const handler = new AcpMessageHandler((m) => messages.push(m));

            handler.handleUpdate({
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
                toolCallId: 'edit-order-1',
                title: 'Writing to foo.txt',
                kind: 'edit',
                locations: [{ path: '/abs/foo.txt' }],
                status: 'in_progress'
            });

            handler.handleUpdate({
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCallUpdate,
                toolCallId: 'edit-order-1',
                title: 'Writing to foo.txt',
                kind: 'edit',
                locations: [{ path: '/abs/foo.txt' }],
                status: 'completed',
                content: [{
                    type: 'diff',
                    path: '/abs/foo.txt',
                    oldText: '',
                    newText: 'new content\n',
                    _meta: { kind: 'add' }
                }]
            });

            type ToolMsg = Extract<AgentMessage, { type: 'tool_call' | 'tool_result' }>;
            const relevant = messages.filter(
                (m): m is ToolMsg =>
                    (m.type === 'tool_call' || m.type === 'tool_result') &&
                    (m as ToolMsg).id === 'edit-order-1'
            );
            // in_progress tool_call → completed tool_call (hoisted) → tool_result
            expect(relevant).toHaveLength(3);
            expect(relevant[0]!.type).toBe('tool_call');
            expect((relevant[0] as Extract<AgentMessage, { type: 'tool_call' }>).status).toBe('in_progress');
            expect(relevant[1]!.type).toBe('tool_call');
            expect((relevant[1] as Extract<AgentMessage, { type: 'tool_call' }>).status).toBe('completed');
            expect(relevant[2]!.type).toBe('tool_result');
        });

        it('falls back gracefully when content array is present but _meta.kind is absent', () => {
            // Unknown _meta.kind → keep existing fallback, no crash
            const messages: AgentMessage[] = [];
            const handler = new AcpMessageHandler((m) => messages.push(m));

            handler.handleUpdate({
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
                toolCallId: 'edit-nometa-1',
                title: 'Writing to foo.txt',
                kind: 'edit',
                locations: [{ path: '/abs/foo.txt' }],
                status: 'in_progress'
            });

            handler.handleUpdate({
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCallUpdate,
                toolCallId: 'edit-nometa-1',
                title: 'Writing to foo.txt',
                kind: 'edit',
                locations: [{ path: '/abs/foo.txt' }],
                status: 'completed',
                content: [{
                    type: 'diff',
                    path: '/abs/foo.txt',
                    oldText: '',
                    newText: 'new content\n'
                    // _meta absent
                }]
            });

            const toolCalls = messages.filter(
                (m): m is Extract<AgentMessage, { type: 'tool_call' }> =>
                    m.type === 'tool_call' && m.id === 'edit-nometa-1'
            );
            const last = toolCalls[toolCalls.length - 1]!;
            // hoistDiffContentIntoInput returns null when _meta.kind is absent,
            // so no re-emit occurs. The last tool_call still carries the initial
            // {file_path} fallback derived from locations at the in_progress event.
            expect(last.input).toEqual({ file_path: '/abs/foo.txt' });
        });

        it('does not hoist or re-emit tool_call when status is failed', () => {
            // Finding 2: hoist must only run on completed, never on failed.
            // A failed write_file must not promote the name to Write or overwrite input.
            const messages: AgentMessage[] = [];
            const handler = new AcpMessageHandler((m) => messages.push(m));

            handler.handleUpdate({
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
                toolCallId: 'edit-fail-1',
                title: 'Writing to foo.txt',
                kind: 'edit',
                locations: [{ path: '/abs/foo.txt' }],
                status: 'in_progress'
            });

            handler.handleUpdate({
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCallUpdate,
                toolCallId: 'edit-fail-1',
                title: 'Writing to foo.txt',
                kind: 'edit',
                locations: [{ path: '/abs/foo.txt' }],
                status: 'failed',
                content: [{
                    type: 'diff',
                    path: '/abs/foo.txt',
                    oldText: '',
                    newText: 'line one\n',
                    _meta: { kind: 'add' }
                }]
            });

            const toolCalls = messages.filter(
                (m): m is Extract<AgentMessage, { type: 'tool_call' }> =>
                    m.type === 'tool_call' && m.id === 'edit-fail-1'
            );
            // Only the initial in_progress tool_call; hoist must not re-emit on failure
            expect(toolCalls).toHaveLength(1);
            expect(toolCalls[0]!.name).not.toBe('Write');
            expect(toolCalls[0]!.input).toEqual({ file_path: '/abs/foo.txt' });
        });

        it('replays write_file fixture and produces Write-shaped tool_call input', () => {
            // Integration: full fixture replay must produce Write with {file_path, content}
            const fixtureDir = new URL('./__fixtures__', import.meta.url).pathname;
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const data = require(`${fixtureDir}/gemini-3-flash-preview-write-file.json`) as {
                updates: unknown[];
            };

            const messages: AgentMessage[] = [];
            const handler = new AcpMessageHandler((m) => messages.push(m));
            for (const u of data.updates) handler.handleUpdate(u);
            handler.flushText();

            const editToolCalls = messages.filter(
                (m): m is Extract<AgentMessage, { type: 'tool_call' }> =>
                    m.type === 'tool_call' && m.name === 'Write'
            );
            expect(editToolCalls.length).toBeGreaterThanOrEqual(1);
            const tc = editToolCalls[editToolCalls.length - 1]!;
            expect(tc.input).toMatchObject({
                file_path: expect.any(String),
                content: expect.any(String)
            });
            // Must NOT contain old_string / new_string (those are Edit fields)
            expect((tc.input as Record<string, unknown>)['old_string']).toBeUndefined();
            expect((tc.input as Record<string, unknown>)['new_string']).toBeUndefined();
        });

        it('replays edit_file fixture and produces Edit-shaped tool_call input', () => {
            // Integration: full fixture replay must produce Edit with {file_path, old_string, new_string}
            const fixtureDir = new URL('./__fixtures__', import.meta.url).pathname;
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const data = require(`${fixtureDir}/gemini-3-flash-preview-edit-file.json`) as {
                updates: unknown[];
            };

            const messages: AgentMessage[] = [];
            const handler = new AcpMessageHandler((m) => messages.push(m));
            for (const u of data.updates) handler.handleUpdate(u);
            handler.flushText();

            const editToolCalls = messages.filter(
                (m): m is Extract<AgentMessage, { type: 'tool_call' }> =>
                    m.type === 'tool_call' && m.name === 'Edit'
            );
            expect(editToolCalls.length).toBeGreaterThanOrEqual(1);
            const tc = editToolCalls[editToolCalls.length - 1]!;
            expect(tc.input).toMatchObject({
                file_path: expect.any(String),
                old_string: expect.any(String),
                new_string: expect.any(String)
            });
        });
    });
});

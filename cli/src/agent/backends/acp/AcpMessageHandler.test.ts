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

    it('keeps buffered text behind tool lifecycle events', () => {
        const messages: AgentMessage[] = [];
        const handler = new AcpMessageHandler((message) => messages.push(message));

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
            content: { type: 'text', text: 'final answer' }
        });

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
            toolCallId: 'tool-3',
            title: 'Read',
            rawInput: { path: 'README.md' },
            status: 'in_progress'
        });

        handler.handleUpdate({
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCallUpdate,
            toolCallId: 'tool-3',
            status: 'completed',
            rawOutput: { content: 'ok' }
        });

        handler.flushText();

        expect(messages.map((message) => message.type)).toEqual(['tool_call', 'tool_result', 'text']);
        const textMessage = messages[messages.length - 1];
        expect(textMessage).toEqual({ type: 'text', text: 'final answer' });
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
});

import { describe, expect, it } from 'vitest';
import { isUsableToolInput, parseToolCall, parseToolResult } from './opencodeLocalToolParse';

/** Simulate the emit policy used by the local launcher hook handler. */
function collectMessages(parts: unknown[]): Array<{ type: string; name?: string; callId: string; input?: unknown; output?: unknown }> {
    const sentToolCalls = new Set<string>();
    const sentToolResults = new Set<string>();
    const out: Array<{ type: string; name?: string; callId: string; input?: unknown; output?: unknown }> = [];

    for (const part of parts) {
        const toolCall = parseToolCall(part);
        if (toolCall && isUsableToolInput(toolCall.input) && !sentToolCalls.has(toolCall.callId)) {
            sentToolCalls.add(toolCall.callId);
            out.push({ type: 'tool-call', name: toolCall.name, callId: toolCall.callId, input: toolCall.input });
        }
        const toolResult = parseToolResult(part);
        if (toolResult && !sentToolResults.has(toolResult.callId)) {
            if (!sentToolCalls.has(toolResult.callId) && toolCall) {
                sentToolCalls.add(toolResult.callId);
                out.push({ type: 'tool-call', name: toolCall.name, callId: toolCall.callId, input: toolCall.input });
            }
            sentToolResults.add(toolResult.callId);
            out.push({ type: 'tool-call-result', callId: toolResult.callId, output: toolResult.output });
        }
    }
    return out;
}

describe('OpenCode local tool part parsing', () => {
    it('does not emit tool-call on pending with empty input; emits on running with real args', () => {
        const callId = 'call-6049b4cf-0272-4651-be9a-402c3a40c933-0';
        const messages = collectMessages([
            {
                type: 'tool',
                tool: 'hapi_change_title',
                callID: callId,
                id: 'prt_pending',
                state: { status: 'pending', input: {}, raw: '' }
            },
            {
                type: 'tool',
                tool: 'hapi_change_title',
                callID: callId,
                id: 'prt_pending',
                state: { status: 'running', input: { title: 'New chat' } }
            },
            {
                type: 'tool',
                tool: 'hapi_change_title',
                callID: callId,
                id: 'prt_pending',
                state: {
                    status: 'completed',
                    input: { title: 'New chat' },
                    output: 'Successfully changed chat title to: "New chat"',
                    metadata: { truncated: false },
                    title: ''
                }
            }
        ]);

        expect(messages).toEqual([
            {
                type: 'tool-call',
                name: 'hapi_change_title',
                callId,
                input: { title: 'New chat' }
            },
            {
                type: 'tool-call-result',
                callId,
                output: {
                    content: 'Successfully changed chat title to: "New chat"',
                    metadata: { truncated: false },
                    title: '',
                    attachments: undefined
                }
            }
        ]);
    });

    it('does not treat step-start / reasoning parts as tool results', () => {
        const messages = collectMessages([
            { type: 'step-start', id: 'prt_f6aa2a4ef001zo366S85sECnN2' },
            { type: 'reasoning', id: 'prt_f6aa2a4f800197fHOPPOxUPYq0', text: 'thinking' },
            { type: 'step-finish', id: 'prt_f6aa2b267001KCNUN7ZBnwirwj', reason: 'stop' }
        ]);
        expect(messages).toEqual([]);
    });

    it('emits late tool-call from completed part when pending never had args', () => {
        const callId = 'call-late';
        const messages = collectMessages([
            {
                type: 'tool',
                tool: 'bash',
                callID: callId,
                state: { status: 'pending', input: {} }
            },
            {
                type: 'tool',
                tool: 'bash',
                callID: callId,
                state: {
                    status: 'completed',
                    input: { command: 'echo hi' },
                    output: 'hi'
                }
            }
        ]);
        expect(messages.map((m) => m.type)).toEqual(['tool-call', 'tool-call-result']);
        expect(messages[0].input).toEqual({ command: 'echo hi' });
    });
});

import { createHash } from 'node:crypto';
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
    it('preserves the native state title', () => {
        expect(parseToolCall({
            type: 'tool',
            tool: 'bash',
            callID: 'call-title',
            state: {
                status: 'running',
                input: { command: 'bun test' },
                title: 'Run project tests'
            }
        })).toMatchObject({ title: 'Run project tests' });
    });

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

function hashObject(obj: unknown): string {
    return createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

function buildToolSignature(name: string, input: unknown): string {
    return `${name}:${hashObject(input ?? null)}`;
}

function pushQueue(map: Map<string, string[]>, key: string, value: string): void {
    const queue = map.get(key) ?? [];
    queue.push(value);
    map.set(key, queue);
}

function shiftQueue(map: Map<string, string[]>, key: string): string | null {
    const queue = map.get(key);
    if (!queue || queue.length === 0) return null;
    const value = queue.shift() ?? null;
    if (!queue.length) map.delete(key);
    else map.set(key, queue);
    return value;
}

function removeFromQueue(map: Map<string, string[]>, key: string, value: string): void {
    const queue = map.get(key);
    if (!queue || queue.length === 0) return;
    const nextQueue = queue.filter((entry) => entry !== value);
    if (!nextQueue.length) map.delete(key);
    else map.set(key, nextQueue);
}

/** Simulate execute-hook emit policy used by opencodeLocalLauncher. */
function collectExecuteHookMessages(
    events: Array<{ type: 'before' | 'after'; name: string; input?: unknown; id?: string; output?: unknown }>
): Array<{ type: string; name?: string; callId: string; input?: unknown; output?: unknown }> {
    const sentToolCalls = new Set<string>();
    const sentToolResults = new Set<string>();
    const toolExecutionQueues = new Map<string, string[]>();
    const out: Array<{ type: string; name?: string; callId: string; input?: unknown; output?: unknown }> = [];
    let nextId = 0;

    for (const event of events) {
        const toolInput = event.input;
        const signature = buildToolSignature(event.name, toolInput);
        const fallbackSignature = buildToolSignature(event.name, null);
        const existingId = event.id ?? null;
        const isBefore = event.type === 'before';
        const usableInput = isUsableToolInput(toolInput);
        let callId = existingId;

        if (!callId) {
            callId = isBefore
                ? `gen-${nextId++}`
                : shiftQueue(toolExecutionQueues, signature)
                    ?? shiftQueue(toolExecutionQueues, fallbackSignature)
                    ?? `gen-${nextId++}`;
        }

        if (isBefore) {
            if (usableInput) {
                pushQueue(toolExecutionQueues, signature, callId);
                if (fallbackSignature !== signature) {
                    pushQueue(toolExecutionQueues, fallbackSignature, callId);
                }
            } else {
                pushQueue(toolExecutionQueues, fallbackSignature, callId);
            }
            if (!sentToolCalls.has(callId)) {
                if (!usableInput) continue;
                sentToolCalls.add(callId);
                out.push({ type: 'tool-call', name: event.name, callId, input: toolInput });
            }
            continue;
        }

        removeFromQueue(toolExecutionQueues, signature, callId);
        if (fallbackSignature !== signature) {
            removeFromQueue(toolExecutionQueues, fallbackSignature, callId);
        }
        if (!sentToolResults.has(callId)) {
            if (!sentToolCalls.has(callId)) {
                sentToolCalls.add(callId);
                out.push({ type: 'tool-call', name: event.name, callId, input: toolInput });
            }
            sentToolResults.add(callId);
            out.push({ type: 'tool-call-result', callId, output: event.output });
        }
    }
    return out;
}

describe('OpenCode local execute-hook tool emit policy', () => {
    it('pairs empty before with real after via fallback signature and late tool-call', () => {
        const messages = collectExecuteHookMessages([
            { type: 'before', name: 'bash', input: {} },
            { type: 'after', name: 'bash', input: { command: 'echo hi' }, output: 'hi' }
        ]);
        expect(messages.map((m) => m.type)).toEqual(['tool-call', 'tool-call-result']);
        expect(messages[0].callId).toEqual(messages[1].callId);
        expect(messages[0].input).toEqual({ command: 'echo hi' });
    });

    it('does not orphan after when before skipped empty input with stable id', () => {
        const messages = collectExecuteHookMessages([
            { type: 'before', name: 'bash', id: 'stable-1', input: {} },
            { type: 'after', name: 'bash', id: 'stable-1', input: { command: 'ls' }, output: 'ok' }
        ]);
        expect(messages).toEqual([
            { type: 'tool-call', name: 'bash', callId: 'stable-1', input: { command: 'ls' } },
            { type: 'tool-call-result', callId: 'stable-1', output: 'ok' }
        ]);
    });
});

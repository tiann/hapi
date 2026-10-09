import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalizeDiffToolInput } from '@/agent/utils';
import { isUsableToolInput, parseToolCall, parseToolResult } from './opencodeLocalToolParse';

/** Mirrors the launcher's execute-hook normalization: pairing signatures are
 *  computed from the RAW name/input BEFORE canonicalizing, so an id-less
 *  `before` shares a queue key with the full `after`; canonicalization only
 *  affects what gets emitted. */
function canonicalizeHookPair(name: string, input: unknown): { name: string; input: unknown } {
    const canonical = canonicalizeDiffToolInput(input, name);
    return canonical ? { name: canonical.name, input: canonical.input } : { name, input };
}

/** Simulate the emit policy used by the local launcher hook handler. */
function collectMessages(parts: unknown[]): Array<{ type: string; name?: string; callId: string; input?: unknown; output?: unknown }> {
    const sentToolCalls = new Set<string>();
    const sentToolResults = new Set<string>();
    const emittedToolInputs = new Map<string, unknown>();
    const out: Array<{ type: string; name?: string; callId: string; input?: unknown; output?: unknown }> = [];

    for (const part of parts) {
        const toolCall = parseToolCall(part);
        if (toolCall && isUsableToolInput(toolCall.input) && !sentToolResults.has(toolCall.callId)) {
            const previousInput = emittedToolInputs.get(toolCall.callId);
            const previousCanonical = canonicalizeDiffToolInput(previousInput, toolCall.name);
            const currentCanonical = canonicalizeDiffToolInput(toolCall.input, toolCall.name);
            const canonicalChanged = currentCanonical !== null
                && hashObject(currentCanonical) !== hashObject(previousCanonical);
            const shouldEmit = previousInput === undefined || canonicalChanged;
            if (shouldEmit) {
                emittedToolInputs.set(toolCall.callId, toolCall.input);
                sentToolCalls.add(toolCall.callId);
                out.push({ type: 'tool-call', name: toolCall.name, callId: toolCall.callId, input: toolCall.input });
            }
        }
        const toolResult = parseToolResult(part);
        if (toolResult && !sentToolResults.has(toolResult.callId)) {
            if (!sentToolCalls.has(toolResult.callId) && toolCall) {
                sentToolCalls.add(toolResult.callId);
                out.push({ type: 'tool-call', name: toolCall.name, callId: toolCall.callId, input: toolCall.input });
            }
            sentToolResults.add(toolResult.callId);
            emittedToolInputs.delete(toolResult.callId);
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

    it('canonicalizes edit tool parts to the Edit view shape', () => {
        expect(parseToolCall({
            type: 'tool',
            tool: 'edit',
            callID: 'call-edit-canonical',
            state: {
                status: 'running',
                input: { filePath: '/tmp/a.ts', oldString: 'foo', newString: 'bar' }
            }
        })).toEqual({
            callId: 'call-edit-canonical',
            name: 'Edit',
            input: { file_path: '/tmp/a.ts', old_string: 'foo', new_string: 'bar' }
        });
    });

    it('canonicalizes write tool parts to the Write view shape', () => {
        expect(parseToolCall({
            type: 'tool',
            tool: 'write',
            callID: 'call-write-canonical',
            state: {
                status: 'running',
                input: { filePath: '/tmp/b.txt', content: 'hello\n' }
            }
        })).toEqual({
            callId: 'call-write-canonical',
            name: 'Write',
            input: { file_path: '/tmp/b.txt', content: 'hello\n' }
        });
    });

    it('leaves non-diff tool parts untouched', () => {
        expect(parseToolCall({
            type: 'tool',
            tool: 'bash',
            callID: 'call-bash-canonical',
            state: { status: 'running', input: { command: 'ls -la' } }
        })).toEqual({
            callId: 'call-bash-canonical',
            name: 'bash',
            input: { command: 'ls -la' }
        });
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

    it('re-emits a running write when content changes from empty to final (message.part.updated path)', () => {
        const callId = 'call-write-stream';
        const messages = collectMessages([
            {
                type: 'tool',
                tool: 'write',
                callID: callId,
                state: { status: 'running', input: { filePath: '/tmp/b.txt', content: '' } }
            },
            {
                type: 'tool',
                tool: 'write',
                callID: callId,
                state: { status: 'running', input: { filePath: '/tmp/b.txt', content: 'final\n' } }
            },
            {
                type: 'tool',
                tool: 'write',
                callID: callId,
                state: { status: 'completed', input: { filePath: '/tmp/b.txt', content: 'final\n' }, output: 'wrote' }
            }
        ]);
        const calls = messages.filter((m) => m.type === 'tool-call');
        const results = messages.filter((m) => m.type === 'tool-call-result');
        expect(calls.length).toBe(2);
        expect(results.length).toBe(1);
        expect(calls[calls.length - 1]).toMatchObject({
            name: 'Write',
            input: { file_path: '/tmp/b.txt', content: 'final\n' }
        });
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
    const emittedToolInputs = new Map<string, unknown>();
    const toolExecutionQueues = new Map<string, string[]>();
    const out: Array<{ type: string; name?: string; callId: string; input?: unknown; output?: unknown }> = [];
    let nextId = 0;

    const shouldEmit = (callId: string, toolInput: unknown, hint: string): boolean => {
        const previousInput = emittedToolInputs.get(callId);
        const previousCanonical = canonicalizeDiffToolInput(previousInput, hint);
        const currentCanonical = canonicalizeDiffToolInput(toolInput, hint);
        const canonicalChanged = currentCanonical !== null
            && hashObject(currentCanonical) !== hashObject(previousCanonical);
        return previousInput === undefined || canonicalChanged;
    };

    for (const event of events) {
        // Signature is derived from the raw name/input BEFORE canonicalizing
        // (mirrors opencodeLocalLauncher): an id-less `before` with empty or
        // partial args must share a queue key with the full `after`.
        const signature = buildToolSignature(event.name, event.input);
        const fallbackSignature = buildToolSignature(event.name, null);
        const normalized = canonicalizeHookPair(event.name, event.input);
        const eventName = normalized.name;
        const toolInput = normalized.input;
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
            if (!sentToolResults.has(callId) && shouldEmit(callId, toolInput, eventName)) {
                if (!usableInput) continue;
                emittedToolInputs.set(callId, toolInput);
                sentToolCalls.add(callId);
                out.push({ type: 'tool-call', name: eventName, callId, input: toolInput });
            }
            continue;
        }

        removeFromQueue(toolExecutionQueues, signature, callId);
        if (fallbackSignature !== signature) {
            removeFromQueue(toolExecutionQueues, fallbackSignature, callId);
        }
        if (!sentToolResults.has(callId)) {
            if (!sentToolCalls.has(callId) || shouldEmit(callId, toolInput, eventName)) {
                emittedToolInputs.set(callId, toolInput);
                sentToolCalls.add(callId);
                out.push({ type: 'tool-call', name: eventName, callId, input: toolInput });
            }
            sentToolResults.add(callId);
            emittedToolInputs.delete(callId);
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

    it('canonicalizes edit before/after pairs emitted via the execute hook path', () => {
        const messages = collectExecuteHookMessages([
            { type: 'before', name: 'edit', input: {} },
            { type: 'after', name: 'edit', input: { filePath: '/tmp/a.ts', oldString: 'foo', newString: 'bar' }, output: 'ok' }
        ]);
        expect(messages.map((m) => m.type)).toEqual(['tool-call', 'tool-call-result']);
        expect(messages[0]).toMatchObject({
            type: 'tool-call',
            name: 'Edit',
            callId: messages[1].callId,
            input: { file_path: '/tmp/a.ts', old_string: 'foo', new_string: 'bar' }
        });
    });

    it('upgrades a partial edit before to the full canonical input when after arrives', () => {
        // Regression: a partial native `before` ({filePath}) is emitted as-is.
        // When the full `after` arrives it must REPLACE the earlier partial call
        // so the web Edit view receives the complete old_string/new_string args.
        // The replacement is a second tool-call (same callId) followed by the result.
        const messages = collectExecuteHookMessages([
            { type: 'before', name: 'edit', input: { filePath: '/tmp/a.ts' } },
            { type: 'after', name: 'edit', input: { filePath: '/tmp/a.ts', oldString: 'foo', newString: 'bar' }, output: 'ok' }
        ]);
        expect(messages.map((m) => m.type)).toEqual(['tool-call', 'tool-call', 'tool-call-result']);
        expect(messages[0].callId).toEqual(messages[1].callId);
        expect(messages[0].callId).toEqual(messages[2].callId);
        expect(messages[1]).toMatchObject({
            type: 'tool-call',
            name: 'Edit',
            input: { file_path: '/tmp/a.ts', old_string: 'foo', new_string: 'bar' }
        });
    });

    it('canonicalizes write tool calls emitted via the execute hook path', () => {
        const messages = collectExecuteHookMessages([
            { type: 'before', name: 'write', id: 'hook-write-1', input: { filePath: '/tmp/b.txt', content: 'hi\n' } },
            { type: 'after', name: 'write', id: 'hook-write-1', input: { filePath: '/tmp/b.txt', content: 'hi\n' }, output: 'wrote' }
        ]);
        expect(messages[0]).toMatchObject({
            type: 'tool-call',
            name: 'Write',
            input: { file_path: '/tmp/b.txt', content: 'hi\n' }
        });
    });

    it('releases completed calls from upgrade tracking (no re-emit after result)', () => {
        // Once a call is completed (tool-call-result emitted), the upgrade map
        // entry is released. A later stale part for the same callId must not
        // trigger a replacement emit or a duplicate result — the lifecycle is
        // already closed by sentToolResults.
        const messages = collectExecuteHookMessages([
            { type: 'before', name: 'edit', id: 'hook-e-1', input: { filePath: '/tmp/a.ts' } },
            { type: 'after', name: 'edit', id: 'hook-e-1', input: { filePath: '/tmp/a.ts', oldString: 'foo', newString: 'bar' }, output: 'ok' },
            { type: 'after', name: 'edit', id: 'hook-e-1', input: { filePath: '/tmp/a.ts', oldString: 'x', newString: 'y' }, output: 'late' }
        ]);
        expect(messages.map((m) => m.type)).toEqual(['tool-call', 'tool-call', 'tool-call-result']);
        expect(messages.filter((m) => m.type === 'tool-call').length).toBe(2);
        expect(messages.filter((m) => m.type === 'tool-call-result').length).toBe(1);
    });

    it('re-emits a canonical write when content changes from empty to final', () => {
        // {filePath, content:""} already canonicalizes, so the previous
        // null->canonical rule would suppress the final content. The canonical
        // value itself changed, so a replacement tool-call must be emitted.
        const messages = collectExecuteHookMessages([
            { type: 'before', name: 'write', id: 'hook-w-1', input: { filePath: '/tmp/b.txt', content: '' } },
            { type: 'after', name: 'write', id: 'hook-w-1', input: { filePath: '/tmp/b.txt', content: 'final\n' }, output: 'wrote' }
        ]);
        expect(messages.map((m) => m.type)).toEqual(['tool-call', 'tool-call', 'tool-call-result']);
        expect(messages[0].callId).toEqual(messages[1].callId);
        expect(messages[1]).toMatchObject({
            type: 'tool-call',
            name: 'Write',
            input: { file_path: '/tmp/b.txt', content: 'final\n' }
        });
    });
});

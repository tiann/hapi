/**
 * Converts Cursor Agent stream-json events to HAPI AgentMessage format.
 * Cursor emits NDJSON: system/init, thinking, assistant, tool_call, result.
 */

import type { AgentMessage } from '@/agent/types';

export type CursorStreamEvent =
    | { type: 'system'; subtype: 'init'; session_id: string; cwd?: string; model?: string }
    | { type: 'thinking'; subtype: 'delta' | 'completed'; text?: string; session_id: string }
    | {
          type: 'user';
          message: { role: string; content: Array<{ type: string; text: string }> };
          session_id: string;
      }
    | {
          type: 'assistant';
          message: { role: string; content: Array<{ type: string; text: string }> };
          session_id: string;
      }
    | {
          type: 'tool_call';
          subtype: 'started' | 'completed';
          call_id: string;
          tool_call: Record<string, unknown>;
          session_id: string;
      }
    | {
          type: 'result';
          subtype: 'success';
          session_id: string;
          result?: string;
          is_error?: boolean;
      };

export function parseCursorEvent(line: string): CursorStreamEvent | null {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) {
        return null;
    }
    try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed && typeof parsed === 'object' && 'type' in parsed) {
            return parsed as CursorStreamEvent;
        }
    } catch {
        // ignore non-JSON lines (e.g. stderr progress)
    }
    return null;
}

function extractToolName(toolCall: Record<string, unknown>): string {
    if (toolCall.readToolCall) return 'read_file';
    if (toolCall.writeToolCall) return 'write_file';
    if (toolCall.function && typeof toolCall.function === 'object') {
        const fn = toolCall.function as Record<string, unknown>;
        return typeof fn.name === 'string' ? fn.name : 'unknown';
    }
    return 'unknown';
}

function extractToolInput(toolCall: Record<string, unknown>): unknown {
    if (toolCall.readToolCall && typeof toolCall.readToolCall === 'object') {
        const r = (toolCall.readToolCall as Record<string, unknown>).args;
        return r ?? {};
    }
    if (toolCall.writeToolCall && typeof toolCall.writeToolCall === 'object') {
        const w = (toolCall.writeToolCall as Record<string, unknown>).args;
        return w ?? {};
    }
    if (toolCall.function && typeof toolCall.function === 'object') {
        const fn = toolCall.function as Record<string, unknown>;
        return { arguments: fn.arguments };
    }
    return {};
}

function extractToolResult(toolCall: Record<string, unknown>): unknown {
    if (toolCall.readToolCall && typeof toolCall.readToolCall === 'object') {
        const r = toolCall.readToolCall as Record<string, unknown>;
        return r.result ?? r;
    }
    if (toolCall.writeToolCall && typeof toolCall.writeToolCall === 'object') {
        const w = toolCall.writeToolCall as Record<string, unknown>;
        return w.result ?? w;
    }
    return {};
}

/**
 * Transitional safety patch for tiann/hapi#784.
 *
 * cursor-agent in headless `--print --output-format stream-json` mode fabricates
 * the following literal string as the AskQuestion tool result, with no error
 * flag and in ~zero seconds, because there is no IDE surface to render the
 * question. The agent's model then treats this as legitimate user consent.
 *
 * HAPI intercepts the synthetic string at the converter layer and rewrites the
 * tool result to a structured `no_input_surface` failure, so downstream agents
 * see an explicit error instead of fabricated consent.
 *
 * This patch is intentionally scoped to the stream-json launcher and
 * auto-deletes when tiann/hapi#781 (ACP migration) replaces stream-json with
 * the proper bidirectional `cursor/ask_question` ACP method.
 */
const SYNTHETIC_SKIP_MARKER =
    'Questions skipped by the user, continue with the information you already have';

const NO_INPUT_SURFACE_OUTPUT = {
    kind: 'no_input_surface',
    message:
        'cursor-agent fabricated a skip response in headless mode. The operator did not respond. Re-prompt in plain text and wait for a real user message before proceeding.'
} as const;

/**
 * Names cursor-agent has been observed to use (or fall back to) for the
 * AskQuestion tool when its result reaches the stream-json converter.
 */
const ASK_QUESTION_TOOL_NAMES = new Set(['AskQuestion', 'askQuestion', 'ask_question', 'unknown']);

/**
 * Defense-in-depth latency threshold. A real interactive answer cannot arrive
 * faster than this; cursor-agent's fabricated skip arrives in ~0 ms.
 */
const SYNTHETIC_LATENCY_THRESHOLD_MS = 500;

/**
 * Tracks when each tool_call 'started' event arrived, keyed by call_id.
 * Used to detect zero-latency fabricated AskQuestion completions even if the
 * synthetic-string text changes in a future cursor-agent release.
 *
 * Bounded to prevent unbounded growth if 'completed' events are ever missed.
 */
const TOOL_CALL_STARTED_MAX = 1024;
const toolCallStartedAt = new Map<string, number>();

function rememberToolCallStart(callId: string, now: number = Date.now()): void {
    if (toolCallStartedAt.size >= TOOL_CALL_STARTED_MAX) {
        const oldest = toolCallStartedAt.keys().next().value;
        if (typeof oldest === 'string') {
            toolCallStartedAt.delete(oldest);
        }
    }
    toolCallStartedAt.set(callId, now);
}

function takeToolCallElapsedMs(callId: string, now: number = Date.now()): number | null {
    const started = toolCallStartedAt.get(callId);
    if (started === undefined) return null;
    toolCallStartedAt.delete(callId);
    return now - started;
}

function containsSyntheticSkipMarker(toolCall: Record<string, unknown>): boolean {
    try {
        return JSON.stringify(toolCall).includes(SYNTHETIC_SKIP_MARKER);
    } catch {
        return false;
    }
}

function isTrivialResult(result: unknown): boolean {
    if (result === null || result === undefined) return true;
    if (typeof result === 'string') return result.trim().length === 0;
    if (typeof result === 'object') {
        return Object.keys(result as Record<string, unknown>).length === 0;
    }
    return false;
}

function shouldRewriteAsNoInputSurface(opts: {
    toolCall: Record<string, unknown>;
    name: string;
    result: unknown;
    elapsedMs: number | null;
}): boolean {
    if (containsSyntheticSkipMarker(opts.toolCall)) {
        return true;
    }
    if (
        opts.elapsedMs !== null &&
        opts.elapsedMs < SYNTHETIC_LATENCY_THRESHOLD_MS &&
        ASK_QUESTION_TOOL_NAMES.has(opts.name) &&
        isTrivialResult(opts.result)
    ) {
        return true;
    }
    return false;
}

/**
 * Test-only hook to reset the timing tracker between test cases. Not exported
 * from the package surface; consumed by the colocated test file.
 */
export function __resetCursorEventConverterStateForTests(): void {
    toolCallStartedAt.clear();
}

export function convertCursorEventToAgentMessage(event: CursorStreamEvent): AgentMessage | null {
    switch (event.type) {
        case 'assistant': {
            const text = event.message?.content
                ?.filter((c): c is { type: string; text: string } => c.type === 'text')
                .map((c) => c.text)
                .join('') ?? '';
            if (!text) return null;
            return { type: 'text', text };
        }
        case 'tool_call': {
            const toolCall = event.tool_call as Record<string, unknown>;
            const name = extractToolName(toolCall);
            const input = extractToolInput(toolCall);
            if (event.subtype === 'started') {
                rememberToolCallStart(event.call_id);
                return {
                    type: 'tool_call',
                    id: event.call_id,
                    name,
                    input,
                    status: 'in_progress'
                };
            }
            const result = extractToolResult(toolCall);
            const elapsedMs = takeToolCallElapsedMs(event.call_id);
            if (shouldRewriteAsNoInputSurface({ toolCall, name, result, elapsedMs })) {
                return {
                    type: 'tool_result',
                    id: event.call_id,
                    output: { ...NO_INPUT_SURFACE_OUTPUT },
                    status: 'failed'
                };
            }
            return {
                type: 'tool_result',
                id: event.call_id,
                output: result,
                status: 'completed'
            };
        }
        case 'result':
            return { type: 'turn_complete', stopReason: 'success' };
        default:
            return null;
    }
}

/**
 * Converts Cursor Agent stream-json events to HAPI AgentMessage format.
 * Cursor emits NDJSON: system/init, thinking, assistant, tool_call, result.
 *
 * This legacy converter only runs for cursor sessions created before the
 * ACP migration (#799). New cursor remote sessions go through
 * cursorAcpBackend, which handles AskQuestion via the bidirectional
 * `cursor/ask_question` ACP extension method and is immune to the #784
 * fabrication. The intercept below exists for legacy resumed sessions
 * only and removes itself when those sessions drain.
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
    if (toolCall.function && typeof toolCall.function === 'object') {
        const fn = toolCall.function as Record<string, unknown>;
        // Function-shaped tool calls put the agent's input in `arguments`
        // and the cursor-side response in other fields. Surface the
        // response (preferring `result` when present, otherwise everything
        // except `name` / `arguments`) so downstream callers see the
        // cursor-side payload instead of an opaque `{}` placeholder.
        if (fn.result !== undefined) return fn.result;
        const rest: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(fn)) {
            if (k === 'name' || k === 'arguments') continue;
            rest[k] = v;
        }
        return Object.keys(rest).length > 0 ? rest : {};
    }
    return {};
}

/**
 * Transitional safety intercept for tiann/hapi#784.
 *
 * cursor-agent in headless `--print --output-format stream-json` mode
 * fabricates the literal SYNTHETIC_SKIP_MARKER string below as the
 * AskQuestion tool result, with no error flag and in ~zero seconds,
 * because there is no IDE surface to render the question. The agent's
 * model then treats this as legitimate user consent and acts on it.
 *
 * HAPI's legacy converter (this file) rewrites the result to a
 * structured `no_input_surface` failure so downstream consumers (web
 * UI, Telegram, log readers) surface the fabrication as an error
 * instead of silently passing through fabricated consent.
 *
 * Scope: legacy stream-json sessions only. New cursor remote sessions
 * go through cursorAcpBackend with the proper `cursor/ask_question`
 * ACP method and never hit this code. The intercept drains with the
 * legacy session population.
 *
 * Detection rules:
 *   1. Tool name resolves to an AskQuestion-shaped call (explicit
 *      `AskQuestion` / `ask_question` / `askQuestion`) or the
 *      converter's `unknown` fallback (cursor's stream-json drops the
 *      AskQuestion name in some configurations - see #784 issue body).
 *   2. The literal SYNTHETIC_SKIP_MARKER appears in the *response*
 *      portion of the raw tool_call payload. For function-shaped
 *      tools, the response excludes `function.arguments` (agent
 *      input), so a legitimate AskQuestion whose prompt quotes the
 *      marker (e.g. debugging this exact bug) is not rewritten.
 *
 * The earlier timing-signature defense-in-depth (rewrite any sub-500ms
 * AskQuestion-shaped completion with a trivial result) was removed in
 * a follow-up: in real legacy traffic it fires on Anthropic Vertex
 * Claude tool calls (whose `toolu_vrtx_*` shape the converter labels
 * `name=unknown` and whose extracted result is the `{}` fallback) and
 * caught no actual fabrications. The marker-only path is sufficient.
 */
const SYNTHETIC_SKIP_MARKER =
    'Questions skipped by the user, continue with the information you already have';

const NO_INPUT_SURFACE_OUTPUT = {
    kind: 'no_input_surface',
    message:
        'cursor-agent fabricated a skip response in headless mode. The operator did not respond. Re-prompt in plain text and wait for a real user message before proceeding.'
} as const;

const ASK_QUESTION_TOOL_NAMES = new Set([
    'AskQuestion',
    'askQuestion',
    'ask_question',
    'unknown'
]);

/**
 * Recursively checks every string reachable from `value` for the
 * synthetic-skip marker. Guards against cycles via a visited-set.
 */
function containsSyntheticSkipMarker(value: unknown, seen: WeakSet<object> = new WeakSet()): boolean {
    if (typeof value === 'string') {
        return value.includes(SYNTHETIC_SKIP_MARKER);
    }
    if (value && typeof value === 'object') {
        if (seen.has(value as object)) return false;
        seen.add(value as object);
        if (Array.isArray(value)) {
            return value.some((entry) => containsSyntheticSkipMarker(entry, seen));
        }
        return Object.values(value as Record<string, unknown>).some((entry) =>
            containsSyntheticSkipMarker(entry, seen)
        );
    }
    return false;
}

/**
 * Scans the raw `tool_call` payload for the synthetic-skip marker in
 * the response portion only. Function-shaped tools have an agent-
 * controlled `arguments` field that must be excluded (the agent's own
 * prompt text can legitimately quote the marker). Other shapes have
 * no agent-input field at the top level, so the entire payload is
 * scanned.
 *
 * Operates on the raw `tool_call` rather than `extractToolResult`'s
 * output because the latter returns `{}` for tool shapes the converter
 * does not recognize (notably the `toolu_vrtx_*` Anthropic Vertex tool
 * calls cursor-agent surfaces in legacy stream-json mode), discarding
 * the marker before it can be checked.
 */
function findMarkerInToolCallResponse(toolCall: Record<string, unknown>): boolean {
    if (toolCall.function && typeof toolCall.function === 'object') {
        const fn = toolCall.function as Record<string, unknown>;
        for (const [k, v] of Object.entries(fn)) {
            if (k === 'arguments') continue;
            if (containsSyntheticSkipMarker(v)) return true;
        }
        for (const [k, v] of Object.entries(toolCall)) {
            if (k === 'function') continue;
            if (containsSyntheticSkipMarker(v)) return true;
        }
        return false;
    }
    return containsSyntheticSkipMarker(toolCall);
}

function shouldRewriteAsNoInputSurface(name: string, toolCall: Record<string, unknown>): boolean {
    if (!ASK_QUESTION_TOOL_NAMES.has(name)) {
        return false;
    }
    return findMarkerInToolCallResponse(toolCall);
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
                return {
                    type: 'tool_call',
                    id: event.call_id,
                    name,
                    input,
                    status: 'in_progress'
                };
            }
            if (shouldRewriteAsNoInputSurface(name, toolCall)) {
                return {
                    type: 'tool_result',
                    id: event.call_id,
                    output: { ...NO_INPUT_SURFACE_OUTPUT },
                    status: 'failed'
                };
            }
            const result = extractToolResult(toolCall);
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

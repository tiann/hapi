import { isObject } from '@hapi/protocol';

export type ParsedToolCall = {
    callId: string;
    name: string;
    input: unknown;
};

export type ParsedToolResult = {
    callId: string;
    output: unknown;
};

/**
 * OpenCode local hooks often emit tool parts with `state.input: {}` while still
 * pending, then fill real args on `running`/`completed`. Empty objects are not
 * useful tool input for the web UI.
 */
export function isUsableToolInput(value: unknown): boolean {
    if (value == null) return false;
    if (isObject(value) && Object.keys(value).length === 0) return false;
    if (typeof value === 'string' && value.trim().length === 0) return false;
    return true;
}

function getString(value: unknown): string | null {
    if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
    }
    return null;
}

function parseMaybeJson(value: unknown): unknown {
    if (typeof value !== 'string') {
        return value;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return value;
    }
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
            return JSON.parse(trimmed);
        } catch {
            return value;
        }
    }
    return value;
}

export function parseToolCall(part: unknown): ParsedToolCall | null {
    if (!isObject(part)) {
        return null;
    }
    const record = part as Record<string, unknown>;
    // Only real tool parts. Non-tool parts (step-start/reasoning/...) reuse part.id
    // and must not be mistaken for tool_call / tool_result.
    if (getString(record.type) !== 'tool') {
        return null;
    }
    const name = getString(record.tool) || getString(record.name);
    // Prefer OpenCode's tool callID over part.id so lifecycle updates share one id.
    const callId = getString(record.callID)
        || getString(record.callId)
        || getString(record.tool_call_id)
        || getString(record.toolCallId)
        || getString(record.id);
    if (!name || !callId) {
        return null;
    }
    if (isObject(record.state)) {
        const state = record.state as Record<string, unknown>;
        const status = getString(state.status);
        // pending/running/completed/error all carry tool identity; input may only
        // become usable on running/completed.
        if (status !== 'pending' && status !== 'running' && status !== 'completed' && status !== 'error') {
            return null;
        }
        const input = parseMaybeJson(state.input ?? state.raw ?? record.input ?? record.args ?? record.arguments);
        return { callId, name, input };
    }
    const input = parseMaybeJson(record.input ?? record.args ?? record.arguments ?? record.raw);
    return { callId, name, input };
}

export function parseToolResult(part: unknown): ParsedToolResult | null {
    if (!isObject(part)) {
        return null;
    }
    const record = part as Record<string, unknown>;
    // Only completed/error tool parts produce results. step-start/reasoning etc.
    // previously leaked as tool-call-result with output:{} via part.id fallback.
    if (getString(record.type) !== 'tool') {
        return null;
    }
    const callId = getString(record.callID)
        || getString(record.callId)
        || getString(record.tool_call_id)
        || getString(record.toolCallId)
        || getString(record.id);
    if (!callId) {
        return null;
    }
    if (isObject(record.state)) {
        const state = record.state as Record<string, unknown>;
        const status = getString(state.status);
        if (status === 'completed') {
            const output = {
                content: state.output ?? state.title,
                metadata: state.metadata,
                title: state.title,
                attachments: state.attachments
            };
            return { callId, output };
        }
        if (status === 'error') {
            const output = {
                content: state.error,
                isError: true
            };
            return { callId, output };
        }
        return null;
    }
    const output = {
        content: record.content,
        metadata: record.metadata,
        isError: record.is_error
    };
    return { callId, output };
}

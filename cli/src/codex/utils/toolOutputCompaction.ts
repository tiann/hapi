const DEFAULT_MAX_CHARS = 20_000;
const PREVIEW_HEAD_CHARS = 6_000;
const PREVIEW_TAIL_CHARS = 2_000;

function stringifyOutput(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }
    try {
        const serialized = JSON.stringify(value, null, 2);
        return typeof serialized === 'string' ? serialized : String(value);
    } catch {
        return String(value);
    }
}

function previewText(text: string, maxChars: number): string {
    const budget = Math.max(200, maxChars);
    if (text.length <= budget) {
        return text;
    }

    const buildMarker = (omitted: number) =>
        `

[HAPI truncated ${omitted} chars from this tool output. Full output remains in the Codex rollout/tool history.]

`;
    const markerReserve = buildMarker(text.length).length + 16;
    const contentBudget = Math.max(0, budget - markerReserve);
    let head = Math.min(PREVIEW_HEAD_CHARS, Math.ceil(contentBudget * 0.75));
    let tail = Math.min(PREVIEW_TAIL_CHARS, Math.max(0, contentBudget - head));
    let omitted = Math.max(0, text.length - head - tail);
    let marker = buildMarker(omitted);
    let preview = [
        text.slice(0, head),
        marker,
        tail > 0 ? text.slice(-tail) : ''
    ].join('');

    if (preview.length > budget) {
        const overflow = preview.length - budget;
        if (tail >= overflow) {
            tail -= overflow;
        } else {
            head = Math.max(0, head - (overflow - tail));
            tail = 0;
        }
        omitted = Math.max(0, text.length - head - tail);
        marker = buildMarker(omitted);
        preview = [
            text.slice(0, head),
            marker,
            tail > 0 ? text.slice(-tail) : ''
        ].join('');
    }

    return preview;
}


export function compactToolOutputForHapi(
    output: unknown,
    options: {
        callId?: string | null;
        toolName?: string | null;
        maxChars?: number;
    } = {}
): unknown {
    const maxChars = Number.isInteger(options.maxChars) && Number(options.maxChars) > 0
        ? Number(options.maxChars)
        : DEFAULT_MAX_CHARS;
    const serialized = stringifyOutput(output);
    if (serialized.length <= maxChars) {
        return output;
    }

    return {
        type: 'hapi-tool-output-summary',
        truncated: true,
        callId: options.callId ?? undefined,
        toolName: options.toolName ?? undefined,
        originalChars: serialized.length,
        preview: previewText(serialized, maxChars),
        fullOutputRetainedBy: 'codex-rollout',
        note: 'HAPI summarized this oversized tool result to keep the chat bridge responsive; the Codex thread still retains its native tool history.'
    };
}

import type { AgentMessage } from './types';

/**
 * Detect rate_limit_event JSON in agent text output and convert to
 * a standardized AgentMessage, so the web layer doesn't need to
 * parse undocumented Claude-internal JSON formats.
 *
 * Converted text format (pipe-delimited, parsed by web's reducerEvents.ts):
 *   - "Claude AI usage limit warning|{unixSeconds}|{percentInt}|{rateLimitType}"
 *   - "Claude AI usage limit reached|{unixSeconds}|{rateLimitType}"
 *
 * Returns null if the text is not a rate_limit_event (pass through as-is).
 * Returns { suppress: true } for known-noisy statuses (e.g. 'allowed').
 * Returns { suppress: false, message } for statuses worth displaying.
 */
export type RateLimitResult =
    | null
    | { suppress: true }
    | { suppress: false; message: AgentMessage };

export function parseRateLimitText(text: string): RateLimitResult {
    if (text[0] !== '{') return null;

    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null) return null;

    // Unwrap { type: "output", data: { ... } } wrapper
    const record = parsed as Record<string, unknown>;
    let inner = record;
    if (record.type === 'output' && typeof record.data === 'object' && record.data !== null) {
        inner = record.data as Record<string, unknown>;
    }

    if (inner.type !== 'rate_limit_event') return null;

    const info = inner.rate_limit_info;
    if (typeof info !== 'object' || info === null) return null;

    const { status, resetsAt, utilization, rateLimitType } = info as Record<string, unknown>;

    // Suppress early for statuses that never need display,
    // before checking resetsAt — malformed payloads should not leak.
    if (status === 'allowed') {
        return { suppress: true };
    }

    if (typeof resetsAt !== 'number') {
        // Malformed rate_limit_event (missing resetsAt) — suppress to prevent
        // raw JSON from leaking into chat.
        return { suppress: true };
    }

    // Ensure integer for the pipe-delimited format (web regex uses \d+)
    const resetsAtInt = Math.round(resetsAt);

    if (status === 'allowed_warning') {
        const pct = typeof utilization === 'number' ? Math.round(utilization * 100) : 0;
        const limitType = typeof rateLimitType === 'string' ? rateLimitType : '';
        return {
            suppress: false,
            message: {
                type: 'text',
                text: `Claude AI usage limit warning|${resetsAtInt}|${pct}|${limitType}`,
            },
        };
    }

    if (status === 'rejected') {
        const limitType = typeof rateLimitType === 'string' ? rateLimitType : '';
        return {
            suppress: false,
            message: {
                type: 'text',
                text: `Claude AI usage limit reached|${resetsAtInt}|${limitType}`,
            },
        };
    }

    // Unknown status — suppress to prevent raw JSON from leaking into chat.
    // If a new status needs to be displayed, add an explicit branch above.
    return { suppress: true };
}

export const CURSOR_AUTO_RETRY_LIMIT = 3;

const RETRYABLE_CURSOR_ERROR = /(?:Error: (?:T|RetriableError): \[(?:canceled|deadline_exceeded|unavailable)\]|http\/(?:1\.1|2).*stream closed|connection (?:reset|stalled|closed)|ACP request 'session\/prompt' timed out after \d+ms)/i;
const INLINE_CURSOR_ERROR = /^[ \t]*Error: (?:T|RetriableError):/im;

export function isRetryableCursorError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return RETRYABLE_CURSOR_ERROR.test(message);
}

export function stripRetryableCursorError(text: string): string | null {
    const marker = INLINE_CURSOR_ERROR.exec(text);
    if (!marker || !isRetryableCursorError(text.slice(marker.index))) return null;
    const before = text.slice(0, marker.index);
    if ((before.match(/^[ \t]{0,3}(?:```|~~~)/gm)?.length ?? 0) % 2 === 1) return null;
    return text.slice(0, marker.index).trimEnd();
}

import { describe, expect, it } from 'vitest';
import { isRetryableCursorError, stripRetryableCursorError } from './cursorAutoRetry';

describe('Cursor automatic retry classification', () => {
    it('recognizes Cursor connection failures without treating ordinary HTTP/2 prose as inline errors', () => {
        expect(isRetryableCursorError(new Error('http/2 stream closed with error code CANCEL'))).toBe(true);
        expect(isRetryableCursorError(new Error('HTTP/1.1 connection reset'))).toBe(true);
        expect(isRetryableCursorError(new Error('HTTP/2 401 Unauthorized'))).toBe(false);
        expect(stripRetryableCursorError('HTTP/2 is a binary framing protocol.')).toBeNull();
        expect(stripRetryableCursorError(
            'Partial answer\n\nError: RetriableError: [canceled] http/2 stream closed'
        )).toBe('Partial answer');
        expect(stripRetryableCursorError(
            'Example:\n```text\nError: RetriableError: [canceled] http/2 stream closed\n```'
        )).toBeNull();
    });
});

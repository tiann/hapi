import { describe, expect, it } from 'vitest';
import {
    isAcpStallStderrError,
    matchesAcpHttp2Cancel,
    matchesAcpRetryBackoff
} from './acpStderrErrors';
import type { AcpStderrError } from './AcpStdioTransport';

function makeError(partial: Partial<AcpStderrError> & Pick<AcpStderrError, 'type' | 'message'>): AcpStderrError {
    return {
        raw: partial.raw ?? partial.message,
        ...partial
    };
}

describe('acpStderrErrors', () => {
    it('detects quota and rate-limit stderr classes as stall errors', () => {
        expect(isAcpStallStderrError(makeError({
            type: 'quota_exceeded',
            message: 'API quota exceeded.'
        }))).toBe(true);
        expect(isAcpStallStderrError(makeError({
            type: 'rate_limit',
            message: 'Rate limit exceeded.'
        }))).toBe(true);
    });

    it('detects OpenCode retry backoff text as a stall error', () => {
        expect(matchesAcpRetryBackoff('provider unavailable, retrying in 30s')).toBe(true);
        expect(isAcpStallStderrError(makeError({
            type: 'unknown',
            message: 'provider unavailable, retrying in 30s'
        }))).toBe(true);
    });

    it('detects HTTP/2 cancel errors as stall errors', () => {
        const message = 'Error: T: [canceled] http/2 stream closed with error code CANCEL (0x8)';
        expect(matchesAcpHttp2Cancel(message)).toBe(true);
        expect(isAcpStallStderrError(makeError({
            type: 'unknown',
            message
        }))).toBe(true);
    });

    it('does not treat unrelated stderr as stall errors', () => {
        expect(isAcpStallStderrError(makeError({
            type: 'authentication',
            message: 'Authentication failed.'
        }))).toBe(false);
    });
});

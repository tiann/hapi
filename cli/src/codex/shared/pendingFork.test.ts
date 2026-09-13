import { describe, expect, it } from 'vitest';
import { pendingForkParams } from './pendingFork';

describe('persisted Codex fork parameters', () => {
    it.each([{}, { lastTurnId: 'previous' }, { beforeTurnId: 'first' }])('preserves the exact native boundary %j', boundary => {
        expect(pendingForkParams({ sourceThreadId: 'source', ...boundary }, 'source')).toEqual({
            threadId: 'source', ...boundary, deferGoalContinuation: true
        });
    });
    it.each([
        { sourceThreadId: '' }, { sourceThreadId: 'other' },
        { sourceThreadId: 'source', lastTurnId: 'a', beforeTurnId: 'b' },
        { sourceThreadId: 'source', beforeTurnId: '' }
    ])('rejects an invalid anchor or boundary %j', request => {
        expect(() => pendingForkParams(request, 'source')).toThrow(/fork/i);
    });
});

import { describe, expect, it } from 'vitest';
import { CodexRoundDuration } from './roundDuration';

describe('Codex live round duration', () => {
    it('keeps the original start, ignores stale completions and persists once', () => {
        const clock = new CodexRoundDuration();
        clock.start('turn', 1000);
        clock.start('turn', 2000);
        expect(clock.finish('old', 3000, true)).toBeUndefined();
        expect(clock.finish('turn', 4000, true)).toEqual({ type: 'turn_duration', flavor: 'codex', turn_id: 'turn', durationMs: 3000 });
        expect(clock.finish('turn', 5000, true)).toBeUndefined();
        clock.start('instant', 0);
        expect(clock.finish('instant', 0, true)?.durationMs).toBe(0);
    });
    it('does not invent a start for completion-only history or interrupted turns', () => {
        const clock = new CodexRoundDuration();
        expect(clock.finish('imported', 4000, true)).toBeUndefined();
        clock.start('failed', 1000);
        expect(clock.finish('failed', 4000, false)).toBeUndefined();
        expect(clock.finish('failed', 5000, true)).toBeUndefined();
    });
    it.each([NaN, Infinity, -1])('rejects invalid or reversed time %s', time => {
        const clock = new CodexRoundDuration();
        clock.start('turn', 1000);
        expect(clock.finish('turn', time, true)).toBeUndefined();
    });
});

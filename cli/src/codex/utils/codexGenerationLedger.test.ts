import { describe, expect, it } from 'vitest';
import { CodexGenerationLedger } from './codexGenerationLedger';

describe('CodexGenerationLedger', () => {
    it('subtracts a command window measured by Codex itself from the round', () => {
        const ledger = new CodexGenerationLedger();
        ledger.noteTokenUsage(1_000);           // pre-round cumulative total
        ledger.startTurn('t1', 0);
        ledger.endTool('exec-1', 4_000, 3_000); // Codex's own duration: window [1000, 4000]
        ledger.noteTokenUsage(1_050);
        expect(ledger.settle('t1', 5_000, true)).toEqual({ generationMs: 2_000, generationOutputTokens: 50 });
    });

    it('falls back to receive moments when the item carries no native timing', () => {
        const ledger = new CodexGenerationLedger();
        ledger.noteTokenUsage(100);
        ledger.startTurn('t1', 0);
        ledger.beginTool('mcp-1', 1_000);
        ledger.endTool('mcp-1', 2_500);
        ledger.noteTokenUsage(160);
        expect(ledger.settle('t1', 4_000, true)).toEqual({ generationMs: 2_500, generationOutputTokens: 60 });
    });

    it('counts concurrent tool windows once', () => {
        const ledger = new CodexGenerationLedger();
        ledger.noteTokenUsage(0);
        ledger.startTurn('t1', 0);
        ledger.beginTool('exec-1', 1_000);
        ledger.beginTool('exec-2', 2_000);
        ledger.endTool('exec-1', 3_000);
        ledger.endTool('exec-2', 4_000);
        ledger.noteTokenUsage(10);
        expect(ledger.settle('t1', 5_000, true)).toEqual({ generationMs: 2_000, generationOutputTokens: 10 });
    });

    it('excludes a wait for the user and merges it with an overlapping tool window', () => {
        const ledger = new CodexGenerationLedger();
        ledger.noteTokenUsage(0);
        ledger.startTurn('t1', 0);
        // The command item opens before its approval; the wait sits inside.
        ledger.beginTool('exec-1', 1_000);
        const answered = ledger.beginUserWait(1_000);
        answered(1_500);
        ledger.endTool('exec-1', 4_000, 3_000);
        ledger.noteTokenUsage(10);
        // Tool window [1000, 4000] already covers the wait: 5000 - 3000.
        expect(ledger.settle('t1', 5_000, true)).toEqual({ generationMs: 2_000, generationOutputTokens: 10 });
        // A standalone wait is subtracted on its own.
        const second = new CodexGenerationLedger();
        second.noteTokenUsage(0);
        second.startTurn('t1', 0);
        const granted = second.beginUserWait(1_000);
        granted(2_500);
        second.noteTokenUsage(10);
        expect(second.settle('t1', 5_000, true)).toEqual({ generationMs: 3_500, generationOutputTokens: 10 });
    });

    it('derives the round output tokens from the cumulative usage delta', () => {
        const ledger = new CodexGenerationLedger();
        ledger.noteTokenUsage(10_000);          // previous turns
        ledger.startTurn('t1', 0);
        ledger.noteTokenUsage(10_100);          // mid-turn call
        ledger.noteTokenUsage(10_150);          // final call
        expect(ledger.settle('t1', 1_000, true)).toEqual({ generationMs: 1_000, generationOutputTokens: 150 });
    });

    it('measures a thread the CLI seeded to zero before its first turn', () => {
        // Captured from the live 2026-11-11 16:40 E2E rollout: a brand-new
        // thread reports no usage before the turn starts, then cumulative
        // output totals of 50 -> 63 across it. The CLI seeds a thread it
        // created in this process (thread/start) to zero, so the pair must
        // not depend on a pre-round usage snapshot. Resumed and forked
        // threads are covered by the app-server's attach-time usage replay
        // instead and never carry this seed.
        const ledger = new CodexGenerationLedger();
        ledger.noteTokenUsage(0);
        ledger.startTurn('t1', 0);
        ledger.noteTokenUsage(50);
        ledger.noteTokenUsage(63);
        expect(ledger.settle('t1', 4_100, true)).toEqual({ generationMs: 4_100, generationOutputTokens: 63 });
    });

    it('emits nothing without a pre-turn usage baseline', () => {
        // A thread the CLI did not create (resumed or forked) learns its
        // cumulative totals from the app-server's attach-time usage replay;
        // until a snapshot lands before a turn, no pair is measurable, so a
        // mid-turn first snapshot must not be mistaken for a zero baseline.
        const ledger = new CodexGenerationLedger();
        ledger.startTurn('t1', 0);
        ledger.noteTokenUsage(500);             // first snapshot arrives mid-round
        expect(ledger.settle('t1', 1_000, true)).toBeNull();
    });

    it('emits nothing when the turn produced no measurable output tokens', () => {
        const ledger = new CodexGenerationLedger();
        ledger.noteTokenUsage(500);
        ledger.startTurn('t1', 0);
        ledger.noteTokenUsage(500);             // unchanged cumulative total
        expect(ledger.settle('t1', 1_000, true)).toBeNull();
        const shrinking = new CodexGenerationLedger();
        shrinking.noteTokenUsage(500);
        shrinking.startTurn('t1', 0);
        shrinking.noteTokenUsage(400);
        expect(shrinking.settle('t1', 1_000, true)).toBeNull();
    });

    it('emits nothing when no usage was reported at all', () => {
        const ledger = new CodexGenerationLedger();
        ledger.startTurn('t1', 0);
        expect(ledger.settle('t1', 1_000, true)).toBeNull();
    });

    it('keeps no state for a failed turn and measures the next one cleanly', () => {
        const ledger = new CodexGenerationLedger();
        ledger.noteTokenUsage(100);
        ledger.startTurn('t1', 0);
        ledger.beginTool('exec-1', 200);
        expect(ledger.settle('t1', 400, false)).toBeNull();
        ledger.noteTokenUsage(160);
        ledger.startTurn('t2', 500);
        ledger.noteTokenUsage(260);
        expect(ledger.settle('t2', 1_500, true)).toEqual({ generationMs: 1_000, generationOutputTokens: 100 });
    });

    it('records a tool window for a completion that never announced a start', () => {
        const ledger = new CodexGenerationLedger();
        ledger.noteTokenUsage(0);
        ledger.startTurn('t1', 0);
        ledger.endTool('late-exec', 4_000, 3_000);
        ledger.noteTokenUsage(10);
        expect(ledger.settle('t1', 5_000, true)).toEqual({ generationMs: 2_000, generationOutputTokens: 10 });
    });

    it('ignores a completion whose measured duration reaches before the round', () => {
        const ledger = new CodexGenerationLedger();
        ledger.noteTokenUsage(0);
        ledger.startTurn('t1', 3_000);
        ledger.endTool('exec-1', 4_000, 10_000); // window clipped to the round
        ledger.noteTokenUsage(10);
        expect(ledger.settle('t1', 5_000, true)).toEqual({ generationMs: 1_000, generationOutputTokens: 10 });
    });

    it('ignores a completion for another turn without disturbing the live round', () => {
        const ledger = new CodexGenerationLedger();
        ledger.noteTokenUsage(0);
        ledger.startTurn('live', 0);
        ledger.beginTool('exec-1', 1_000);
        ledger.endTool('exec-1', 4_000);
        expect(ledger.settle('stale', 2_000, true)).toBeNull();
        ledger.noteTokenUsage(10);
        expect(ledger.settle('live', 5_000, true)).toEqual({ generationMs: 2_000, generationOutputTokens: 10 });
    });

    it('ignores a repeated start of the same turn', () => {
        const ledger = new CodexGenerationLedger();
        ledger.noteTokenUsage(0);
        ledger.startTurn('t1', 0);
        ledger.beginTool('exec-1', 1_000);
        ledger.startTurn('t1', 3_000);          // replayed start: state and baseline kept
        ledger.endTool('exec-1', 4_000);
        ledger.noteTokenUsage(10);
        expect(ledger.settle('t1', 5_000, true)).toEqual({ generationMs: 2_000, generationOutputTokens: 10 });
    });
});
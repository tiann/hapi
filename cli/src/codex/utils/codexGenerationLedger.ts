import { generationTimeMs, type GenerationIdleWindow } from '@/agent/generationClock';

/**
 * One Codex turn's tok/s bookkeeping, agy-style: the round minus the spans
 * spent running tools or waiting for the user, over the round's output-token
 * delta. Tool windows prefer Codex's own measurements (an item's
 * startedAtMs/completedAtMs or a command's durationMs); HAPI receive moments
 * fill in when an item carries no native timing. The token numerator is the
 * thread-cumulative `total.output_tokens` delta across the round, so a turn
 * is only measurable when a pre-round usage snapshot exists — either the
 * app-server's attach-time usage replay for resumed and forked threads, or
 * the CLI's zero seed for a thread it created in this process. Turn
 * identity mirrors CodexRoundDuration: only the started turn settles, and a
 * stale completion never disturbs the live round's state.
 */
export class CodexGenerationLedger {
    private roundTurnId: string | null = null;
    private roundStart: number | null = null;
    private readonly toolWindows = new Map<string, GenerationIdleWindow>();
    private readonly userWaitWindows: GenerationIdleWindow[] = [];
    private outputTotal: number | null = null;
    private outputBaseline: number | null = null;

    /**
     * Opens the round; the token baseline is whatever was reported before it.
     * The CLI seeds a thread it created in this process (thread/start) to
     * zero via noteTokenUsage(0), so a fresh thread's first turn measures
     * from a real zero baseline. Resumed and forked threads instead receive
     * the app-server's attach-time usage replay (codex
     * request_processors/token_usage_replay.rs): their snapshot lands before
     * the next turn/started, and until then no round is measurable — a
     * mid-turn first snapshot on those threads already includes inherited
     * history and must not stand in for a baseline.
     */
    startTurn(turnId: string | null | undefined, startedAt: number): void {
        if (!turnId || this.roundTurnId === turnId) return;
        this.roundTurnId = turnId;
        this.roundStart = startedAt;
        this.outputBaseline = this.outputTotal;
        this.toolWindows.clear();
        this.userWaitWindows.length = 0;
    }

    beginTool(callId: string, at: number): void {
        let window = this.toolWindows.get(callId);
        if (!window) {
            window = { start: at, end: null };
            this.toolWindows.set(callId, window);
        }
    }

    /**
     * Closes a tool window. A Codex-measured duration replaces the begun
     * window outright: it is immune to delivery skew. Completions without a
     * start (reconnect, late shutdown) still yield their own window.
     */
    endTool(callId: string, at: number, durationMs?: number): void {
        const measured = typeof durationMs === 'number' && Number.isSafeInteger(durationMs) && durationMs > 0;
        if (measured) {
            this.toolWindows.set(callId, { start: at - durationMs, end: at });
            return;
        }
        const window = this.toolWindows.get(callId) ?? { start: at, end: null };
        window.end ??= at;
        this.toolWindows.set(callId, window);
    }

    /**
     * Opens a wait-for-the-user span at the approval request; the returned
     * callback closes it once the answer reached Codex.
     */
    beginUserWait(startedAt: number): (endedAt: number) => void {
        const window: GenerationIdleWindow = { start: startedAt, end: null };
        this.userWaitWindows.push(window);
        return (endedAt: number) => { window.end ??= endedAt; };
    }

    /** Tracks the thread-cumulative output total, in and between turns. */
    noteTokenUsage(totalOutputTokens: number): void {
        if (typeof totalOutputTokens === 'number' && Number.isSafeInteger(totalOutputTokens) && totalOutputTokens >= 0) {
            this.outputTotal = totalOutputTokens;
        }
    }

    /**
     * Drops the open round on app-server reconnect: the resumed turn
     * re-announces itself and must re-measure from its own start, with the
     * pre-disconnect tool windows and token baseline discarded. The
     * cumulative output total survives — it is thread state, not turn state.
     */
    reset(): void {
        this.roundTurnId = null;
        this.roundStart = null;
        this.outputBaseline = null;
        this.toolWindows.clear();
        this.userWaitWindows.length = 0;
    }

    /**
     * The round's generation pair, or null when nothing measurable happened:
     * no matching round, no pre-turn usage baseline, no token delta, or no
     * time left once tools and waits are removed. Failed turns reset without
     * a pair. A completion for another turn is ignored entirely.
     */
    settle(turnId: string | null | undefined, completedAt: number, completed: boolean): { generationMs: number; generationOutputTokens: number } | null {
        if (!turnId || this.roundTurnId !== turnId) return null;
        const roundStart = this.roundStart;
        const baseline = this.outputBaseline;
        const windows = [...this.toolWindows.values(), ...this.userWaitWindows];
        this.roundTurnId = null;
        this.roundStart = null;
        this.outputBaseline = null;
        this.toolWindows.clear();
        this.userWaitWindows.length = 0;
        if (!completed || roundStart === null || baseline === null || this.outputTotal === null) return null;
        const generationOutputTokens = this.outputTotal - baseline;
        const generationMs = generationTimeMs(roundStart, completedAt, windows);
        if (!(generationOutputTokens > 0) || generationMs === null || generationMs <= 0) return null;
        return { generationMs, generationOutputTokens };
    }
}
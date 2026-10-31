/** Tracks only observed live starts; replay callers must never seed this clock. */
export class CodexRoundDuration {
    private active: { turnId: string; startedAt: number } | undefined;

    get turnId(): string | undefined { return this.active?.turnId; }

    start(turnId: string | null | undefined, startedAt: number): void {
        if (!turnId || !Number.isFinite(startedAt) || this.active?.turnId === turnId) return;
        this.active = { turnId, startedAt };
    }

    finish(turnId: string | null | undefined, completedAt: number, completed: boolean) {
        if (!turnId || this.active?.turnId !== turnId) return;
        const { startedAt } = this.active;
        this.active = undefined;
        if (!completed || !Number.isFinite(completedAt) || completedAt < startedAt) return;
        return { type: 'turn_duration' as const, flavor: 'codex' as const, turn_id: turnId, durationMs: completedAt - startedAt };
    }
}

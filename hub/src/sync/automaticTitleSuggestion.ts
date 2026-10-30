import type { SessionCache } from './sessionCache'
import type { TitleSuggestionService } from './titleSuggestion'

/**
 * Best-effort first-turn title fallback.
 *
 * This service owns only the automatic path. The existing manual Generate
 * action remains available after an automatic attempt fails.
 */
export class AutomaticTitleSuggestionService {
    private readonly inFlightSessionIds = new Set<string>()
    private readonly observedTurns = new Map<string, { first: boolean; completed: boolean }>()
    private stopped = false

    constructor(
        private readonly sessionCache: SessionCache,
        private readonly titleSuggestionService: TitleSuggestionService,
        private readonly now: () => number = Date.now
    ) {
    }

    stop(): void {
        this.stopped = true
        this.observedTurns.clear()
    }

    forgetSession(sessionId: string): void {
        this.observedTurns.delete(sessionId)
    }

    onTurnStarted(sessionId: string): void {
        if (this.stopped || !this.titleSuggestionService.isConfigured()) return
        const prior = this.observedTurns.get(sessionId)
        if (prior && !prior.completed) return
        const metadata = this.sessionCache.getSession(sessionId)?.metadata
        if (metadata?.name?.trim() || metadata?.summary?.text?.trim()
            || metadata?.titleSuggestionAutoAttemptedAt !== undefined) return
        try {
            // Capture before assistant output can interleave with steering.
            // Pi completes with a false heartbeat, without a stored ready event.
            const turn = metadata?.titleSuggestionTurn?.completed === false ? { ...metadata.titleSuggestionTurn } : {
                first: !this.titleSuggestionService.hasTitleResponse(sessionId),
                completed: false
            }
            if (this.sessionCache.updateAutomaticTitleTurn(sessionId, turn)) {
                this.observedTurns.set(sessionId, turn)
            }
        } catch {
            // Diagnostics and title fallback must not interrupt agent startup.
        }
    }

    /**
     * Schedule one non-blocking attempt after the first turn becomes idle.
     * Errors are intentionally swallowed: title fallback must never affect the
     * primary agent conversation.
     */
    onTurnCompleted(sessionId: string): Promise<void> {
        if (this.stopped) return Promise.resolve()
        const persistedTurn = this.sessionCache.getSession(sessionId)?.metadata?.titleSuggestionTurn
        const turn = this.observedTurns.get(sessionId)
            ?? (persistedTurn?.completed === false ? { ...persistedTurn } : undefined)
        if (turn) this.observedTurns.set(sessionId, turn)
        if (turn && !turn.completed) {
            turn.completed = true
            try {
                this.sessionCache.updateAutomaticTitleTurn(sessionId, turn)
            } catch {
                // A lifecycle bookkeeping failure must not interrupt chat.
            }
        }
        if (this.stopped || this.inFlightSessionIds.has(sessionId)) return Promise.resolve()
        this.inFlightSessionIds.add(sessionId)

        return Promise.resolve()
            .then(async () => {
                try {
                    if (this.stopped) return
                    if (!this.titleSuggestionService.isConfigured()) return
                    const metadata = this.sessionCache.getSession(sessionId)?.metadata
                    if (metadata?.name?.trim() || metadata?.summary?.text?.trim()
                        || metadata?.titleSuggestionAutoAttemptedAt !== undefined) return
                    if (turn?.first === false) return
                    if (!this.titleSuggestionService.hasCompletedFirstTurn(sessionId, turn?.first)) return
                    if (!this.sessionCache.claimAutomaticTitleAttempt(sessionId, this.now())) return

                    const title = await this.titleSuggestionService.suggestTitle(sessionId)
                    if (!this.stopped) {
                        await this.sessionCache.updateAutomaticSessionSummary(sessionId, title)
                    }
                } catch {
                    // Automatic title generation is best-effort and silent.
                }
            })
            .finally(() => {
                this.inFlightSessionIds.delete(sessionId)
            })
    }
}

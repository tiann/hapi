import type { SessionCache } from './sessionCache'
import type { TitleSuggestionService } from './titleSuggestion'

/**
 * Flavors whose CLI injects no rename tool into the agent prompt, so the
 * autoTitlePerTurn steer cannot reach them. The hub-side per-turn fallback
 * below regenerates metadata.name for exactly these flavors (claude, codex,
 * opencode, grok and pi rename themselves via their title tool). Keep in sync
 * with the flavor system-prompt modules when a flavor gains a native tool.
 */
export const FLAVORS_WITHOUT_NATIVE_TITLE_TOOLS: ReadonlySet<string> = new Set([
    'dsh', 'kimi', 'cursor', 'copilot', 'agy'
])

type AutomaticTitleSuggestionOptions = {
    /**
     * Reads the hub autoTitlePerTurn setting. When it resolves to true the
     * hub rewrites the title itself after every completed turn for flavors
     * without a native rename tool. Undefined disables the fallback.
     */
    isPerTurnTitleEnabled?: () => Promise<boolean>
}

/**
 * Best-effort first-turn title fallback.
 *
 * This service owns only the automatic path. The existing manual Generate
 * action remains available after an automatic attempt fails.
 *
 * Per-turn mode: the CLI-side autoTitlePerTurn steer only works for flavors
 * with a native rename tool. For the rest (FLAVORS_WITHOUT_NATIVE_TITLE_TOOLS)
 * the hub regenerates the title after every turn while the setting is on.
 * Manual pins still win — a nameLocked / titleLocked session is never
 * rewritten by the fallback.
 */
export class AutomaticTitleSuggestionService {
    private readonly inFlightSessionIds = new Set<string>()
    private readonly observedTurns = new Map<string, { first: boolean; completed: boolean }>()
    private stopped = false

    constructor(
        private readonly sessionCache: SessionCache,
        private readonly titleSuggestionService: TitleSuggestionService,
        private readonly now: () => number = Date.now,
        private readonly options: AutomaticTitleSuggestionOptions = {}
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
                    // The undefined check must stay synchronous: awaiting an
                    // absent gate would defer the first-turn path by a
                    // microtask tick and break in-flight ordering guarantees.
                    if (this.options.isPerTurnTitleEnabled !== undefined) {
                        if (await this.shouldRewriteTitlePerTurn(sessionId)) {
                            const title = await this.titleSuggestionService.suggestTitle(sessionId)
                            if (!this.stopped) {
                                await this.sessionCache.updatePerTurnSessionTitle(sessionId, title)
                            }
                            return
                        }
                    }
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

    /**
     * Hub-side per-turn rewrite gate: the toggle is on, the provider is
     * configured (checked by the caller), the session runs a flavor without a
     * native rename tool, and no manual pin (nameLocked / titleLocked) holds
     * the title. The pin check reads the raw store row via the cache because
     * the sanitized cache view strips hub-owned fields; the flavor check uses
     * the cached view, where flavor survives sanitization.
     */
    private async shouldRewriteTitlePerTurn(sessionId: string): Promise<boolean> {
        if (!this.options.isPerTurnTitleEnabled) return false
        let perTurnEnabled = false
        try {
            perTurnEnabled = await this.options.isPerTurnTitleEnabled()
        } catch {
            // A settings-read failure must not take the first-turn fallback
            // down with it; degrade to the legacy path instead.
            return false
        }
        if (!perTurnEnabled) return false
        const metadata = this.sessionCache.getSession(sessionId)?.metadata as
            | { flavor?: unknown }
            | null
            | undefined
        if (!metadata) return false
        if (typeof metadata.flavor !== 'string' || !FLAVORS_WITHOUT_NATIVE_TITLE_TOOLS.has(metadata.flavor)) return false
        if (this.sessionCache.isSessionNamePinned(sessionId)) return false
        return true
    }
}

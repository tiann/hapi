/**
 * Single-flight + last-good cache for session enumeration RPCs
 * (ListSlashCommands / ListSkills).
 *
 * These RPCs are served by the runner/engine on the session's machine. When
 * the engine is mid-turn (or its socket is reconnecting), the RPC can queue
 * for tens of seconds (observed 20s+ in production) while clients re-request
 * the same enumeration on every session open. Enumerations change rarely, so:
 *   - concurrent callers share one in-flight fetch (single-flight)
 *   - a result younger than ttlMs is served without any RPC
 *   - a stale result is served immediately while it revalidates in background
 *   - a cold fetch is capped at fetchTimeoutMs; on timeout/failure the last
 *     good result (if any) is served instead
 *
 * Entries are keyed per session. The engine releases a session's entries
 * when it leaves the active set (deleted or archived), so memory is bounded
 * by the live session count rather than the hub's lifetime.
 */

interface EnumerationEntry {
    inFlight?: Promise<unknown>
    value?: unknown
    fetchedAt?: number
}

export class SessionEnumerationCache {
    private readonly entries = new Map<string, EnumerationEntry>()

    constructor(
        private readonly options: {
            ttlMs: number
            fetchTimeoutMs: number
            now?: () => number
        }
    ) {}

    /** Drop every entry belonging to the given session. Keys are
     *  `<sessionId>|<agent>` composites and session ids cannot contain '|',
     *  so a `sessionId|` prefix match is unambiguous. A fetch still in
     *  flight resolves against its detached entry object, so a late success
     *  cannot resurrect a released key — the next get() starts cold. */
    releaseSession(sessionId: string): void {
        const prefix = `${sessionId}|`
        for (const key of [...this.entries.keys()]) {
            if (key.startsWith(prefix)) {
                this.entries.delete(key)
            }
        }
    }

    async get<T>(
        key: string,
        fetch: () => Promise<T>,
        isCacheable: (value: T) => boolean = () => true
    ): Promise<T> {
        const now = this.options.now ?? Date.now
        let entry = this.entries.get(key)
        if (!entry) {
            entry = {}
            this.entries.set(key, entry)
        }

        // Fresh value: serve without any RPC.
        if (
            entry.value !== undefined &&
            entry.fetchedAt !== undefined &&
            now() - entry.fetchedAt < this.options.ttlMs
        ) {
            return entry.value as T
        }

        if (!entry.inFlight) {
            const started = (async () => fetch())().then(
                (value) => {
                    if (isCacheable(value)) {
                        entry.value = value
                        entry.fetchedAt = now()
                    }
                    return value
                },
                (error) => {
                    // Keep the last good value; propagate so cold callers react.
                    throw error
                }
            )
            entry.inFlight = started
            // Nobody may end up awaiting this fetch (stale callers are served
            // synchronously below) — swallow late rejections after it settles.
            void started.finally(() => {
                if (entry.inFlight === started) {
                    entry.inFlight = undefined
                }
            }).catch(() => {})
        }

        if (entry.value !== undefined) {
            // Stale-while-revalidate: serve what we have; the in-flight fetch
            // above refreshes the entry for later callers.
            return entry.value as T
        }

        // Cold path: wait for the shared fetch, capped at fetchTimeoutMs. The
        // underlying fetch keeps running past the cap so a late success still
        // populates the cache for the next caller.
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined
        try {
            return await Promise.race([
                entry.inFlight as Promise<T>,
                new Promise<never>((_, reject) => {
                    timeoutHandle = setTimeout(
                        () => reject(new Error('Enumeration RPC timed out')),
                        this.options.fetchTimeoutMs
                    )
                })
            ])
        } finally {
            if (timeoutHandle !== undefined) {
                clearTimeout(timeoutHandle)
            }
        }
    }
}

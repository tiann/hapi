import type { Suggestion, SuggestionRequestContext } from '@/hooks/useActiveSuggestions'

/** Keep one query's remote results visible while refreshing local suggestions. */
export function createDeferredSuggestions() {
    let cachedKey: string | undefined
    let cached: Suggestion[] = []
    let generation = 0

    return (
        key: string,
        local: Suggestion[],
        load: () => Promise<Suggestion[]>,
        context: SuggestionRequestContext,
    ): Suggestion[] => {
        if (key !== cachedKey) {
            cachedKey = key
            cached = []
        }
        const request = ++generation
        // Defer even an already-resolved loader until the initial list is published.
        void Promise.resolve().then(async () => {
            if (context.signal.aborted) return
            const remote = await load()
            if (context.signal.aborted || request !== generation) return
            cached = remote
            context.publish([...local, ...remote])
        }).catch(() => {
            // Keep local and previously loaded candidates usable while offline.
        })
        return [...local, ...cached]
    }
}

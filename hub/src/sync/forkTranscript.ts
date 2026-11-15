/**
 * Select the HAPI transcript prefix to hydrate into a forked child session.
 * Historical fork excludes the boundary message and everything after it.
 * A current fork without a recorded boundary copies the full source
 * transcript. Restart-safe current forks use selectForkTranscriptThrough.
 * Pending scheduled/queued rows (`invokedAt == null`) are never copied — they
 * are not part of the native history being forked and would otherwise fire on
 * both the source and the child.
 *
 * Messages are ordered by invocation/display time (then seq) before slicing so
 * a late-seq agent reply that appeared before a queued user turn is retained.
 */
export function selectForkTranscriptPrefix<T extends {
    localId: string | null
    invokedAt: number | null
    createdAt: number
    seq: number
}>(
    messages: T[],
    messageLocalId?: string
): T[] {
    const ordered = messages.slice().sort((a, b) => {
        const byTime = (a.invokedAt ?? a.createdAt) - (b.invokedAt ?? b.createdAt)
        return byTime !== 0 ? byTime : a.seq - b.seq
    })
    let scoped: T[]
    if (!messageLocalId) {
        scoped = ordered
    } else {
        const cutoff = ordered.findIndex((message) => message.localId === messageLocalId)
        if (cutoff < 0) {
            throw new Error('Fork boundary message not found')
        }
        scoped = ordered.slice(0, cutoff)
    }
    return scoped.filter((message) => message.invokedAt != null)
}

/** Select an inclusive current-tip fork prefix through the last source message. */
export function selectForkTranscriptThrough<T extends {
    localId: string | null
    invokedAt: number | null
    createdAt: number
    seq: number
}>(
    messages: T[],
    messageLocalId: string
): T[] {
    // An empty id explicitly represents a current fork of an empty transcript.
    if (!messageLocalId) return []
    const ordered = messages.slice().sort((a, b) => {
        const byTime = (a.invokedAt ?? a.createdAt) - (b.invokedAt ?? b.createdAt)
        return byTime !== 0 ? byTime : a.seq - b.seq
    })
    const cutoff = ordered.findIndex((message) => message.localId === messageLocalId)
    if (cutoff < 0) {
        throw new Error('Fork tip boundary message not found')
    }
    return ordered.slice(0, cutoff + 1).filter((message) => message.invokedAt != null)
}

/** Return the latest invoked message localId usable as a restart-safe fork tip. */
export function latestForkTranscriptLocalId<T extends {
    localId: string | null
    invokedAt: number | null
    createdAt: number
    seq: number
}>(messages: T[]): string | undefined {
    const ordered = messages.slice().sort((a, b) => {
        const byTime = (a.invokedAt ?? a.createdAt) - (b.invokedAt ?? b.createdAt)
        return byTime !== 0 ? byTime : a.seq - b.seq
    })
    return ordered
        .reverse()
        .find((message) => message.invokedAt != null && message.localId != null)
        ?.localId ?? undefined
}

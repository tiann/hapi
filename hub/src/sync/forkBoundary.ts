/**
 * Fork and rewind boundary resolution for HAPI transcripts — the single home
 * for the cut rules shared by fork execution, fork/rewind preview, and
 * boundary token validation.
 *
 * `selectForkTranscriptPrefix` selects the HAPI transcript prefix to hydrate
 * into a forked child session. Historical fork excludes the boundary message
 * and everything after it. Current fork copies the full source transcript.
 * Pending scheduled/queued rows (`invokedAt == null`) are never copied — they
 * are not part of the native history being forked and would otherwise fire on
 * both the source and the child.
 *
 * Messages are ordered by invocation/display time (then seq) before slicing so
 * a late-seq agent reply that appeared before a queued user turn is retained.
 */

export interface BoundaryRow {
    localId: string | null
    invokedAt: number | null
    createdAt: number
    seq: number
}

export type ResolvedBoundary<T> = {
    /** Rows on the kept side of the cut. */
    prefix: T[]
    /** Rows on the removed side of the cut, in transcript order. */
    excluded: T[]
    /** Max seq among invoked rows at resolution time. */
    tailSeq: number
}

function positionAt(row: BoundaryRow): number {
    return row.invokedAt ?? row.createdAt
}

function byPosition<T extends BoundaryRow>(a: T, b: T): number {
    const byTime = positionAt(a) - positionAt(b)
    return byTime !== 0 ? byTime : a.seq - b.seq
}

/** Same position rule as `truncateMessagesFromLocalId`: rows at/after the
 *  boundary row's (position, seq) are on the removed side. */
function isAtOrAfterCut<T extends BoundaryRow>(row: T, cut: { at: number; seq: number }): boolean {
    const at = positionAt(row)
    return at > cut.at || (at === cut.at && row.seq >= cut.seq)
}

function findCut<T extends BoundaryRow>(ordered: T[], localId: string): { at: number; seq: number } {
    const cut = ordered.find((row) => row.localId === localId)
    if (!cut) {
        throw new Error('Fork boundary message not found')
    }
    return { at: positionAt(cut), seq: cut.seq }
}

function maxInvokedSeq<T extends BoundaryRow>(ordered: T[]): number {
    let tailSeq = 0
    for (const row of ordered) {
        if (row.invokedAt != null && row.seq > tailSeq) tailSeq = row.seq
    }
    return tailSeq
}

/** Max seq among invoked rows — the tail position a boundary token pins. */
export function invokedTailSeq<T extends BoundaryRow>(rows: T[]): number {
    return maxInvokedSeq(rows)
}

function splitAtCut<T extends BoundaryRow>(ordered: T[], cut: { at: number; seq: number }, invokedOnly: boolean): {
    prefix: T[]
    excluded: T[]
} {
    const prefix: T[] = []
    const excluded: T[] = []
    for (const row of ordered) {
        if (invokedOnly && row.invokedAt == null) continue
        ;(isAtOrAfterCut(row, cut) ? excluded : prefix).push(row)
    }
    return { prefix, excluded }
}

/**
 * Resolve the fork side of a boundary. `current` and `latestCompleted` keep
 * every invoked row unless the boundary owner supplies an explicit
 * `cutBeforeLocalId`; `message` cuts before `messageLocalId`.
 */
export function resolveForkBoundary<T extends BoundaryRow>(
    rows: T[],
    options: {
        mode: 'current' | 'message' | 'latestCompleted'
        messageLocalId?: string
        cutBeforeLocalId?: string
    }
): ResolvedBoundary<T> {
    const ordered = rows.slice().sort(byPosition)
    const tailSeq = maxInvokedSeq(ordered)
    const cutLocalId = options.cutBeforeLocalId ?? (options.mode === 'message' ? options.messageLocalId : undefined)
    if (!cutLocalId) {
        return { prefix: ordered.filter((row) => row.invokedAt != null), excluded: [], tailSeq }
    }
    const cut = findCut(ordered, cutLocalId)
    return { ...splitAtCut(ordered, cut, true), tailSeq }
}

/**
 * Resolve the rewind side of a boundary: the source keeps everything strictly
 * before `messageLocalId` and deletes the rows at/after it, mirroring
 * `truncateMessagesFromLocalId` exactly (uninvoked rows included).
 */
export function resolveRewindBoundary<T extends BoundaryRow>(
    rows: T[],
    messageLocalId: string
): ResolvedBoundary<T> {
    const ordered = rows.slice().sort(byPosition)
    const cut = findCut(ordered, messageLocalId)
    return { ...splitAtCut(ordered, cut, false), tailSeq: maxInvokedSeq(ordered) }
}

/**
 * Select the HAPI transcript prefix to hydrate into a forked child session
 * (current fork: full invoked transcript; historical fork: rows before the
 * boundary message). Thin wrapper over `resolveForkBoundary`.
 */
export function selectForkTranscriptPrefix<T extends BoundaryRow>(
    messages: T[],
    messageLocalId?: string
): T[] {
    return resolveForkBoundary(messages, {
        mode: messageLocalId ? 'message' : 'current',
        messageLocalId
    }).prefix
}
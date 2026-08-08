import { clearDraft, getDraft, saveDraft } from '@/lib/composer-drafts'
import {
    getDraftAttachments,
    getRestoredUploadMetadata,
    moveDraftAttachments,
    saveDraftAttachments,
    type AttachmentDraftInput,
} from '@/lib/composer-attachment-drafts'

type ComposerDraftSnapshot = {
    text: string
    attachments: AttachmentDraftInput[]
}

/** In-flight handoff may carry a live cancellation check sampled at save time. */
export type AttachmentDraftHandoff = AttachmentDraftInput & {
    isCancelled?: () => boolean
}

const liveSnapshots = new Map<string, ComposerDraftSnapshot>()
const MAX_LIVE_SNAPSHOTS = 50

type HandoffState = {
    targetSessionId: string
    pending: AttachmentDraftHandoff[]
    done: Promise<void>
    resolveDone: () => void
}

const activeHandoffs = new Map<string, HandoffState>()
/** Source → target after a handoff completes, so staggered adds append instead of reloading the source. */
const completedHandoffs = new Map<string, string>()
/** Last visible inactive attachment ids, so a later empty composer can drop them from IndexedDB. */
const inactiveVisibleIds = new Map<string, Set<string>>()
/** Serialize read/merge/write so unmount + effect cannot race, and reopen can await the latest. */
const inactivePersistQueue = new Map<string, Promise<AttachmentDraftInput[]>>()
/** In-flight cross-session transfers: inactive persist must not recreate the source row. */
type PendingTransfer = {
    targetSessionId: string
    /** Attachment-aware revision recorded during the move (never invent empty from keystrokes). */
    latest?: { text: string; attachments: AttachmentDraftInput[] }
    /** Text-only keystrokes while inactive (no live attachment snapshot). */
    latestText?: string
}
const pendingTransfers = new Map<string, PendingTransfer>()

function samplePendingTransferText(sessionId: string, fallback: string): string {
    const pending = pendingTransfers.get(sessionId)
    return pending?.latest?.text
        ?? pending?.latestText
        ?? liveSnapshots.get(sessionId)?.text
        ?? fallback
}

export function setComposerDraftSnapshot(
    sessionId: string,
    text: string,
    attachments: readonly AttachmentDraftInput[],
): void {
    // A fresh live snapshot means this session is active in a composer again.
    completedHandoffs.delete(sessionId)
    // Keep the in-memory fast path bounded because snapshots retain File blobs.
    if (!liveSnapshots.has(sessionId) && liveSnapshots.size >= MAX_LIVE_SNAPSHOTS) {
        const oldestSessionId = liveSnapshots.keys().next().value
        if (oldestSessionId) liveSnapshots.delete(oldestSessionId)
    }
    liveSnapshots.set(sessionId, { text, attachments: [...attachments] })
}

/**
 * Cheap text-only update for inactive composers. Avoids queuing another
 * IndexedDB blob merge on every keystroke when attachments are unchanged.
 */
export function updateComposerDraftTextSnapshot(sessionId: string, text: string): void {
    saveDraft(sessionId, text)
    const existing = liveSnapshots.get(sessionId)
    if (existing) {
        liveSnapshots.set(sessionId, { ...existing, text })
    }
    // Keep in-flight transfer text in sync without inventing attachments: [] —
    // inactive composers withhold hidden stored files from liveSnapshots.
    const pending = pendingTransfers.get(sessionId)
    if (!pending) return
    pending.latestText = text
    if (pending.latest) {
        pending.latest = { ...pending.latest, text }
    }
}

/** Stable membership/metadata key for attachment-only persist effects. */
export function attachmentDraftRevision(attachments: readonly AttachmentDraftInput[]): string {
    return attachments
        .map(({ id, path, uploadSessionId }) => `${id}:${path ?? ''}:${uploadSessionId ?? ''}`)
        .join('\0')
}

export function clearComposerDraftSnapshot(sessionId: string): void {
    liveSnapshots.delete(sessionId)
    // Keep completedHandoffs: a handed-off source must stay tombstoned so
    // unmount cleanup cannot recreate the obsolete draft.
    inactiveVisibleIds.delete(sessionId)
    pendingTransfers.delete(sessionId)
}

/** True after a cross-session transfer retired this source id. */
export function composerDraftWasHandedOff(sessionId: string): boolean {
    return completedHandoffs.has(sessionId)
}

/** Drop per-mount visibility tracking so a remount does not treat hidden stored files as user-removed. */
export function resetInactiveComposerAttachmentVisibility(sessionId: string): void {
    inactiveVisibleIds.delete(sessionId)
}

/** Test/helper: drop the handoff tombstone so a session id can be reused. */
export function forgetComposerDraftHandoff(sessionId: string): void {
    completedHandoffs.delete(sessionId)
}

function stripSessionScopedUploadFields(attachment: AttachmentDraftInput): AttachmentDraftInput {
    return {
        ...attachment,
        path: undefined,
        previewUrl: undefined,
        uploadSessionId: undefined,
    }
}

function mergeAttachmentsById(
    base: readonly AttachmentDraftInput[],
    pending: readonly AttachmentDraftInput[],
): AttachmentDraftInput[] {
    const byId = new Map<string, AttachmentDraftInput>()
    for (const attachment of base) {
        byId.set(attachment.id, attachment)
    }
    for (const attachment of pending) {
        byId.set(attachment.id, attachment)
    }
    return [...byId.values()]
}

async function loadPersistedAttachments(
    sessionId: string,
    options: { throwOnError?: boolean } = {},
): Promise<AttachmentDraftInput[]> {
    return (await getDraftAttachments(sessionId, options)).map((file, index) => {
        const metadata = getRestoredUploadMetadata(file)
        return {
            id: metadata?.id ?? `transferred-${index}-${file.name}`,
            file,
            path: metadata?.path,
            previewUrl: metadata?.previewUrl,
            uploadSessionId: metadata?.uploadSessionId,
        }
    })
}

async function persistInactiveComposerAttachmentsNow(
    sessionId: string,
    text: string,
    visibleAttachments: readonly AttachmentDraftInput[],
): Promise<AttachmentDraftInput[]> {
    // A queued persist may settle during/after the source move — buffer onto
    // the in-flight transfer instead of recreating the retiring source row.
    if (pendingTransfers.has(sessionId)) {
        // A newer synchronous barrier edit already recorded latest; keep it.
        // Re-read the map after awaits — TS would otherwise keep a stale
        // `pending.latest` narrowing across the async gap.
        const latestBeforeRead = pendingTransfers.get(sessionId)?.latest
        if (latestBeforeRead) {
            return latestBeforeRead.attachments
        }
        saveDraft(sessionId, text)
        const previousVisibleIds = inactiveVisibleIds.get(sessionId) ?? new Set<string>()
        // Fail closed: never publish pending.latest / liveSnapshots from a
        // best-effort empty read that would erase hidden stored files on move.
        const stored = await loadPersistedAttachments(sessionId, { throwOnError: true })
        const latestAfterRead = pendingTransfers.get(sessionId)?.latest
        if (latestAfterRead) {
            return latestAfterRead.attachments
        }
        // Transfer may have finished while we read storage.
        if (!pendingTransfers.has(sessionId)) {
            if (composerDraftWasHandedOff(sessionId)) {
                return [...visibleAttachments]
            }
        } else {
            const retained = stored.filter((item) => !previousVisibleIds.has(item.id))
            const merged = mergeAttachmentsById(retained, visibleAttachments)
            const pending = pendingTransfers.get(sessionId)
            if (pending) {
                pending.latest = { text, attachments: merged }
            }
            liveSnapshots.set(sessionId, { text, attachments: merged })
            inactiveVisibleIds.set(sessionId, new Set(visibleAttachments.map((item) => item.id)))
            return merged
        }
    }
    if (composerDraftWasHandedOff(sessionId)) {
        return [...visibleAttachments]
    }
    saveDraft(sessionId, text)
    const previousVisibleIds = inactiveVisibleIds.get(sessionId) ?? new Set<string>()
    const stored = await loadPersistedAttachments(sessionId, { throwOnError: true })
    // Drop ids that were previously visible but are gone now (operator removed
    // a failed-resume pick). Hidden stored files outside that set are retained.
    const retained = stored.filter((item) => !previousVisibleIds.has(item.id))
    const merged = mergeAttachmentsById(retained, visibleAttachments)
    inactiveVisibleIds.set(sessionId, new Set(visibleAttachments.map((item) => item.id)))

    if (visibleAttachments.length === 0) {
        // Inactive composers must not publish a live snapshot of hidden files.
        liveSnapshots.delete(sessionId)
        // Do not clear completedHandoffs here — that tombstone must survive
        // empty inactive remounts after a cross-session move.
        if (previousVisibleIds.size > 0) {
            saveDraftAttachments(sessionId, retained)
        }
        return retained
    }

    saveDraftAttachments(sessionId, merged)
    setComposerDraftSnapshot(sessionId, text, merged)
    return merged
}

/**
 * Persist text for an inactive composer. When the user has visible pending
 * attachments (e.g. resume failed after pick), merge them into IndexedDB
 * instead of replacing the hidden stored list or discarding the new picks.
 * Concurrent calls for one session are serialized.
 */
export async function persistInactiveComposerAttachments(
    sessionId: string,
    text: string,
    visibleAttachments: readonly AttachmentDraftInput[],
): Promise<AttachmentDraftInput[]> {
    // Source session was already moved to a resumed id — do not recreate it.
    if (composerDraftWasHandedOff(sessionId)) {
        return []
    }
    // Transfer in flight: record the latest visible state for the target, and
    // never write IndexedDB under the retiring source id.
    const pending = pendingTransfers.get(sessionId)
    if (pending) {
        pending.latestText = text
        saveDraft(sessionId, text)
        // Empty visible during transfer is common (hidden stored files). Do not
        // invent pending.latest with attachments: [] — that would erase IDB.
        if (visibleAttachments.length === 0) {
            if (pending.latest) {
                pending.latest = { ...pending.latest, text }
                return [...pending.latest.attachments]
            }
            const existing = liveSnapshots.get(sessionId)
            if (existing) {
                liveSnapshots.set(sessionId, { ...existing, text })
                return [...existing.attachments]
            }
            return []
        }
        const attachments = [...visibleAttachments]
        pending.latest = { text, attachments }
        liveSnapshots.set(sessionId, { text, attachments })
        inactiveVisibleIds.set(sessionId, new Set(attachments.map((item) => item.id)))
        return attachments
    }
    const previous = inactivePersistQueue.get(sessionId) ?? Promise.resolve([] as AttachmentDraftInput[])
    const next = previous
        .catch(() => [] as AttachmentDraftInput[])
        .then(() => persistInactiveComposerAttachmentsNow(sessionId, text, visibleAttachments))
    inactivePersistQueue.set(sessionId, next)
    try {
        return await next
    } finally {
        if (inactivePersistQueue.get(sessionId) === next) {
            inactivePersistQueue.delete(sessionId)
        }
    }
}

async function awaitInactivePersist(sessionId: string): Promise<void> {
    const pending = inactivePersistQueue.get(sessionId)
    if (pending) await pending.catch(() => {})
}

export type TransferComposerDraftOptions = {
    /**
     * Immutable text captured at send/resume time. Prefer this over drafts that
     * may already have been cleared by assistant-ui while resume was in flight.
     */
    textOverride?: string
}

function resolveTransferredText(
    sampled: string,
    options?: TransferComposerDraftOptions,
): string {
    return options?.textOverride !== undefined ? options.textOverride : sampled
}

/** Copy a draft to the new id returned by resume/reopen before navigating. */
export async function transferComposerDraft(
    sourceSessionId: string,
    targetSessionId: string,
    pendingAttachments: readonly AttachmentDraftHandoff[] = [],
    options?: TransferComposerDraftOptions,
): Promise<void> {
    if (sourceSessionId === targetSessionId && pendingAttachments.length === 0) {
        // Same-id resume often no-ops attachments, but Send still needs the
        // submitted text restored after assistant-ui cleared the composer.
        if (options?.textOverride !== undefined) {
            saveDraft(targetSessionId, options.textOverride)
            const existing = liveSnapshots.get(targetSessionId)
            if (existing) {
                liveSnapshots.set(targetSessionId, {
                    ...existing,
                    text: options.textOverride,
                })
            }
        }
        return
    }

    const crossSession = sourceSessionId !== targetSessionId
    // Install the barrier before any await so a concurrent inactive persist
    // cannot recreate the source or miss recording latest onto the transfer.
    if (crossSession) {
        pendingTransfers.set(sourceSessionId, { targetSessionId })
    }

    try {
        // Flush any in-flight inactive merge so reopen cannot race a pending read.
        await awaitInactivePersist(sourceSessionId)

        const sourceLive = liveSnapshots.get(sourceSessionId)

        let text: string
        let baseAttachments: AttachmentDraftInput[]

        // Always read the source draft. A previously visited target may still sit
        // in liveSnapshots; using it would shadow the reopened session's draft.
        if (sourceLive) {
            text = sourceLive.text
            baseAttachments = sourceLive.attachments
        } else {
            text = getDraft(sourceSessionId)
            try {
                // Fail closed: a transient IndexedDB read must not look like an
                // empty draft and then delete the source during the durable move.
                baseAttachments = await loadPersistedAttachments(sourceSessionId, {
                    throwOnError: true,
                })
            } catch (error) {
                // Resume already resolved a new id; keep the independently readable
                // text under the target even when attachment storage aborts.
                if (crossSession) {
                    saveDraft(targetSessionId, resolveTransferredText(text, options))
                }
                throw error
            }
        }

        const buildTransferredAttachments = (): AttachmentDraftInput[] => {
            // Sample cancellation at write time (after any awaited IDB drain inside
            // moveDraftAttachments) so a remove() during the wait still drops the file.
            const cancelledIds = new Set<string>()
            for (const item of pendingAttachments) {
                if (item.isCancelled?.()) cancelledIds.add(item.id)
            }

            // Prefer edits recorded while the move was in flight over the snapshot
            // captured at transfer start.
            const pendingLatest = pendingTransfers.get(sourceSessionId)?.latest
            const currentBase = pendingLatest?.attachments
                ?? liveSnapshots.get(sourceSessionId)?.attachments
                ?? baseAttachments

            // Cross-session reopen cannot reuse source-authorized upload paths.
            // Same-target staggered appends must keep path/uploadSessionId already
            // written by earlier uploads on that resumed composer.
            const normalizedBase = (
                sourceSessionId === targetSessionId
                    ? currentBase
                    : currentBase.map(stripSessionScopedUploadFields)
            ).filter((item) => !cancelledIds.has(item.id))
            const normalizedPending = pendingAttachments
                .filter((item) => !cancelledIds.has(item.id))
                .map((attachment) => ({
                    id: attachment.id,
                    file: attachment.file,
                    previewUrl: attachment.previewUrl,
                    path: undefined,
                    uploadSessionId: undefined,
                }))
            return mergeAttachmentsById(normalizedBase, normalizedPending)
        }

        let attachments: AttachmentDraftInput[]
        let transferredText = text
        if (crossSession) {
            // Durable move: await target put + source delete before navigation so a
            // reload cannot lose the draft, and tombstone the source so unmount
            // cleanup cannot recreate it under the obsolete id.
            try {
                attachments = await moveDraftAttachments(
                    sourceSessionId,
                    targetSessionId,
                    buildTransferredAttachments,
                )
                // Always rewrite the target at least once after the durable move so
                // isCancelled flips during the IDB commit window still prune the file.
                // Repeat until pending edits and the cancellation set are stable.
                const cancellationRevision = () => JSON.stringify(
                    pendingAttachments
                        .filter((item) => item.isCancelled?.())
                        .map((item) => item.id)
                        .sort(),
                )
                for (;;) {
                    const pendingState = pendingTransfers.get(sourceSessionId)
                    const latest = pendingState?.latest
                    const textMarker = pendingState?.latestText
                    const cancelMarker = cancellationRevision()
                    transferredText = samplePendingTransferText(
                        sourceSessionId,
                        getDraft(sourceSessionId),
                    )
                    attachments = buildTransferredAttachments()
                    await moveDraftAttachments(
                        targetSessionId,
                        targetSessionId,
                        () => attachments,
                    )
                    const after = pendingTransfers.get(sourceSessionId)
                    if (
                        after?.latest === latest
                        && after?.latestText === textMarker
                        && cancellationRevision() === cancelMarker
                    ) {
                        break
                    }
                }
                transferredText = resolveTransferredText(
                    samplePendingTransferText(
                        sourceSessionId,
                        getDraft(sourceSessionId),
                    ),
                    options,
                )
                saveDraft(targetSessionId, transferredText)
                clearDraft(sourceSessionId)
                completedHandoffs.set(sourceSessionId, targetSessionId)
                liveSnapshots.delete(sourceSessionId)
                inactiveVisibleIds.delete(sourceSessionId)
            } catch (error) {
                // Hub resume already succeeded; keep navigating. Copy text + in-memory
                // attachments to the target without claiming a durable handoff so the
                // source IndexedDB row remains if the operator reloads the old id.
                transferredText = resolveTransferredText(
                    samplePendingTransferText(
                        sourceSessionId,
                        getDraft(sourceSessionId),
                    ),
                    options,
                )
                attachments = buildTransferredAttachments()
                saveDraft(targetSessionId, transferredText)
                saveDraftAttachments(targetSessionId, attachments)
                setComposerDraftSnapshot(targetSessionId, transferredText, attachments)
                throw error
            }
        } else {
            attachments = buildTransferredAttachments()
            transferredText = resolveTransferredText(transferredText, options)
            saveDraft(targetSessionId, transferredText)
            saveDraftAttachments(targetSessionId, attachments)
        }
        setComposerDraftSnapshot(targetSessionId, transferredText, attachments)
    } finally {
        if (crossSession) {
            pendingTransfers.delete(sourceSessionId)
        }
    }
}

/**
 * Move drafts after a successful hub resume/reopen, then always run `navigate`.
 * Local IndexedDB failures must not strand the UI on a deleted source route.
 */
export async function transferComposerDraftThenNavigate(
    sourceSessionId: string,
    targetSessionId: string,
    navigate: () => void | Promise<void>,
    pendingAttachments: readonly AttachmentDraftHandoff[] = [],
    options?: TransferComposerDraftOptions,
): Promise<void> {
    try {
        await transferComposerDraft(
            sourceSessionId,
            targetSessionId,
            pendingAttachments,
            options,
        )
    } catch (error) {
        console.warn('[composer-draft] transfer failed after resume; continuing navigation', error)
    }
    await navigate()
}

/**
 * Resume/upload handoff for a newly selected inactive-session attachment.
 * Concurrent multi-file drops share one transfer + navigation; late files merge into the target.
 */
export async function handoffComposerDraft(
    sourceSessionId: string,
    targetSessionId: string,
    pending: AttachmentDraftHandoff,
    onNavigable: (targetSessionId: string) => void | Promise<void>,
): Promise<void> {
    const pendingItem: AttachmentDraftHandoff = {
        id: pending.id,
        file: pending.file,
        previewUrl: pending.previewUrl,
        isCancelled: pending.isCancelled,
    }

    if (sourceSessionId === targetSessionId) {
        await transferComposerDraft(sourceSessionId, targetSessionId, [pendingItem])
        return
    }

    const completedTarget = completedHandoffs.get(sourceSessionId)
    if (completedTarget === targetSessionId) {
        await transferComposerDraft(targetSessionId, targetSessionId, [pendingItem])
        return
    }

    const existing = activeHandoffs.get(sourceSessionId)
    if (existing) {
        if (!existing.pending.some((item) => item.id === pendingItem.id)) {
            existing.pending.push(pendingItem)
        }
        await existing.done
        // Append onto the target draft itself so an unrelated prior target
        // snapshot cannot replace the transferred source content.
        await transferComposerDraft(targetSessionId, targetSessionId, [pendingItem])
        return
    }

    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => {
        resolveDone = resolve
    })
    const state: HandoffState = {
        targetSessionId,
        pending: [pendingItem],
        done,
        resolveDone,
    }
    activeHandoffs.set(sourceSessionId, state)

    try {
        // Let concurrent add() callbacks enqueue into state.pending before transferring.
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 0)
        })
        const batch = [...state.pending]
        try {
            await transferComposerDraft(sourceSessionId, targetSessionId, batch)
            // Re-sample the full batch until cancellation is stable across the
            // same-target rewrite (multi-file removes can land mid-await).
            const cancellationRevision = () => JSON.stringify(
                batch
                    .filter((item) => item.isCancelled?.())
                    .map((item) => item.id)
                    .sort(),
            )
            let observedCancellationRevision = '[]'
            for (;;) {
                const nextCancellationRevision = cancellationRevision()
                if (nextCancellationRevision === observedCancellationRevision) break
                observedCancellationRevision = nextCancellationRevision
                await transferComposerDraft(targetSessionId, targetSessionId, batch)
            }
        } catch (error) {
            console.warn('[composer-draft] handoff transfer failed; still navigating', error)
        }
        // Navigate even when the local durable move failed — resume may already
        // have deleted the source session row.
        await onNavigable(targetSessionId)
        const late = state.pending.filter((item) => !batch.some((early) => early.id === item.id))
        if (late.length > 0) {
            try {
                await transferComposerDraft(targetSessionId, targetSessionId, late)
            } catch (error) {
                console.warn('[composer-draft] late handoff append failed', error)
            }
        }
    } finally {
        resolveDone()
        activeHandoffs.delete(sourceSessionId)
    }
}

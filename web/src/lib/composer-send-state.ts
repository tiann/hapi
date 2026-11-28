import { reconcileQueuedEditRecoveryClear } from './queued-edit-recovery'
import type { SendMessageSettlement } from '@/hooks/mutations/useSendMessage'
import { clearDraftsAfterSend } from '@/lib/clearDraftsAfterSend'
import { getDraft } from '@/lib/composer-drafts'

export type PendingComposerSend = {
    attemptId: string | null
    sessionId: string
    text: string
    programmaticEditRevision: number
    draftRevision: number
    originalText?: string
    attachmentIds?: readonly string[]
}

const pendingComposerSends = new Map<string, Map<string | null, PendingComposerSend>>()
const composerProgrammaticEditRevisions = new Map<string, number>()
const composerDraftRevisions = new Map<string, number>()
const composerTextRevisions = new Map<string, number>()
const lastSuccessfulComposerClears = new Map<string, { text: string; revision: number }>()
const MAX_RECENT_CLEARS = 128
const composerSendSettlements = new Map<string, Map<string, SendMessageSettlement>>()
const listeners = new Set<() => void>()

/** Test isolation; production state intentionally survives route unmounts. */
export function resetComposerSendStateForTests(): void {
    pendingComposerSends.clear()
    composerProgrammaticEditRevisions.clear()
    composerDraftRevisions.clear()
    composerTextRevisions.clear()
    lastSuccessfulComposerClears.clear()
    composerSendSettlements.clear()
    notify()
}

function notify(): void {
    for (const listener of listeners) listener()
}

export function subscribeComposerSendState(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
}

export function getPendingComposerSend(sessionId: string, attemptId?: string | null): PendingComposerSend | null {
    const attempts = pendingComposerSends.get(sessionId)
    if (!attempts) return null
    if (attemptId !== undefined) return attempts.get(attemptId) ?? null
    return Array.from(attempts.values()).at(-1) ?? null
}

export function recordPendingComposerSend(send: PendingComposerSend): void {
    const attempts = pendingComposerSends.get(send.sessionId) ?? new Map()
    attempts.set(send.attemptId, send)
    pendingComposerSends.set(send.sessionId, attempts)
    if (send.attemptId !== null) reconcileSuccessfulSend(send.sessionId, send.attemptId)
    notify()
}

export function consumePendingComposerSend(sessionId: string, attemptId: string | null): void {
    const attempts = pendingComposerSends.get(sessionId)
    if (!attempts?.delete(attemptId)) return
    if (!attempts.size) pendingComposerSends.delete(sessionId)
    notify()
}

export function getComposerProgrammaticEditRevision(sessionId: string): number {
    return composerProgrammaticEditRevisions.get(sessionId) ?? 0
}

export function getComposerDraftRevision(sessionId: string): number {
    return composerDraftRevisions.get(sessionId) ?? 0
}

export function getComposerTextRevision(sessionId: string): number {
    return composerTextRevisions.get(sessionId) ?? 0
}

export function recordComposerTextChange(sessionId: string): void {
    composerTextRevisions.set(sessionId, getComposerTextRevision(sessionId) + 1)
    recordComposerDraftChange(sessionId)
}

export function getSuccessfulComposerClear(sessionId: string) {
    return lastSuccessfulComposerClears.get(sessionId)
}

export function recordSuccessfulComposerClear(sessionId: string, text: string): void {
    if (!text) return
    lastSuccessfulComposerClears.delete(sessionId)
    const revision = getComposerTextRevision(sessionId)
    lastSuccessfulComposerClears.set(sessionId, { text, revision })
    reconcileQueuedEditRecoveryClear(sessionId, text, revision)
    if (lastSuccessfulComposerClears.size > MAX_RECENT_CLEARS) {
        const oldest = lastSuccessfulComposerClears.keys().next().value
        if (oldest !== undefined) lastSuccessfulComposerClears.delete(oldest)
    }
}

export function recordComposerDraftChange(sessionId: string): void {
    composerDraftRevisions.set(sessionId, getComposerDraftRevision(sessionId) + 1)
    notify()
}

export function recordComposerProgrammaticEdit(sessionId: string): void {
    composerProgrammaticEditRevisions.set(
        sessionId,
        getComposerProgrammaticEditRevision(sessionId) + 1,
    )
    recordComposerTextChange(sessionId)
}

export function getComposerSendSettlements(sessionId: string | undefined): ReadonlyMap<string, SendMessageSettlement> | null {
    return sessionId ? composerSendSettlements.get(sessionId) ?? null : null
}

export function getComposerSendSettlement(sessionId: string | null): SendMessageSettlement | null {
    if (!sessionId) return null
    const byAttempt = composerSendSettlements.get(sessionId)
    if (!byAttempt) return null
    // Show an older completed attempt even while a newer POST remains
    // pending. The composer matches this result to that attempt's acceptance.
    const attempts = pendingComposerSends.get(sessionId)
    if (attempts?.size) {
        for (const settlement of byAttempt.values()) {
            if (attempts.has(settlement.attemptId)) return settlement
        }
        if (Array.from(attempts.keys()).some(attemptId => attemptId !== null)) return null
    }
    return byAttempt.values().next().value ?? null
}

export function publishComposerSendSettlement(settlement: SendMessageSettlement): void {
    const byAttempt = new Map(composerSendSettlements.get(settlement.sessionId))
    byAttempt.set(settlement.attemptId, settlement)
    composerSendSettlements.set(settlement.sessionId, byAttempt)
    reconcileSuccessfulSend(settlement.sessionId, settlement.attemptId)
    notify()
}

/**
 * Clear durable draft storage as soon as both halves of a successful send are
 * known. The mounted composer still owns live assistant-ui cleanup, but this
 * path keeps a route-unmounted or refreshed page from resurrecting a sent
 * draft. Preserve newer text, but still discard exact IDs that were sent.
 */
function reconcileSuccessfulSend(sessionId: string, attemptId: string): void {
    const pending = getPendingComposerSend(sessionId, attemptId)
    if (!pending) return
    const settlement = composerSendSettlements.get(sessionId)?.get(attemptId)
    if (settlement?.status !== 'success' || settlement.source !== 'send') return
    const sentText = settlement.originalText ?? pending.originalText ?? settlement.text
    const sentAttachmentIds = settlement.attachmentIds ?? pending.attachmentIds
    const currentText = getDraft(sessionId)
    const preserveText = getComposerDraftRevision(sessionId) !== pending.draftRevision
        || (currentText !== '' && currentText !== sentText)
    if (preserveText) {
        if (sentAttachmentIds?.length) clearDraftsAfterSend(sessionId, null, sentText, sentAttachmentIds, true)
        return
    }
    if (currentText === sentText) recordSuccessfulComposerClear(sessionId, sentText)
    if (sentAttachmentIds !== undefined) {
        clearDraftsAfterSend(sessionId, null, sentText, sentAttachmentIds)
        return
    }
    clearDraftsAfterSend(sessionId, null, sentText)
}

export function consumeComposerSendSettlement(sessionId: string, attemptId: string): void {
    const byAttempt = new Map(composerSendSettlements.get(sessionId))
    if (!byAttempt.delete(attemptId)) return
    if (byAttempt.size === 0) composerSendSettlements.delete(sessionId)
    else composerSendSettlements.set(sessionId, byAttempt)
    notify()
}

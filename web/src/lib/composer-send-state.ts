import type { SendMessageSettlement } from '@/hooks/mutations/useSendMessage'
import { clearDraftsAfterSend } from '@/lib/clearDraftsAfterSend'

export type PendingComposerSend = {
    attemptId: string | null
    sessionId: string
    text: string
    programmaticEditRevision: number
    draftRevision: number
}

const pendingComposerSends = new Map<string, PendingComposerSend>()
const composerProgrammaticEditRevisions = new Map<string, number>()
const composerDraftRevisions = new Map<string, number>()
const composerSendSettlements = new Map<string, Map<string, SendMessageSettlement>>()
const listeners = new Set<() => void>()

/** Test isolation; production state intentionally survives route unmounts. */
export function resetComposerSendStateForTests(): void {
    pendingComposerSends.clear()
    composerProgrammaticEditRevisions.clear()
    composerDraftRevisions.clear()
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

export function getPendingComposerSend(sessionId: string): PendingComposerSend | null {
    return pendingComposerSends.get(sessionId) ?? null
}

export function recordPendingComposerSend(send: PendingComposerSend): void {
    pendingComposerSends.set(send.sessionId, send)
    reconcileSuccessfulSend(send.sessionId)
    notify()
}

export function consumePendingComposerSend(sessionId: string, attemptId: string | null): void {
    const current = pendingComposerSends.get(sessionId)
    if (!current || current.attemptId !== attemptId) return
    pendingComposerSends.delete(sessionId)
    notify()
}

export function getComposerProgrammaticEditRevision(sessionId: string): number {
    return composerProgrammaticEditRevisions.get(sessionId) ?? 0
}

export function getComposerDraftRevision(sessionId: string): number {
    return composerDraftRevisions.get(sessionId) ?? 0
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
    composerDraftRevisions.set(sessionId, getComposerDraftRevision(sessionId) + 1)
    notify()
}

export function getComposerSendSettlement(sessionId: string | null): SendMessageSettlement | null {
    if (!sessionId) return null
    const byAttempt = composerSendSettlements.get(sessionId)
    if (!byAttempt) return null
    const pendingAttemptId = pendingComposerSends.get(sessionId)?.attemptId
    if (pendingAttemptId !== null && pendingAttemptId !== undefined) {
        return byAttempt.get(pendingAttemptId) ?? null
    }
    return byAttempt.values().next().value ?? null
}

export function publishComposerSendSettlement(settlement: SendMessageSettlement): void {
    const byAttempt = composerSendSettlements.get(settlement.sessionId) ?? new Map<string, SendMessageSettlement>()
    byAttempt.set(settlement.attemptId, settlement)
    composerSendSettlements.set(settlement.sessionId, byAttempt)
    reconcileSuccessfulSend(settlement.sessionId)
    notify()
}

/**
 * Clear durable draft storage as soon as both halves of a successful send are
 * known. The mounted composer still owns live assistant-ui cleanup, but this
 * path keeps a route-unmounted or refreshed page from resurrecting a sent
 * draft. A newer draft revision always wins and remains intact.
 */
function reconcileSuccessfulSend(sessionId: string): void {
    const pending = pendingComposerSends.get(sessionId)
    if (!pending?.attemptId) return
    const settlement = composerSendSettlements.get(sessionId)?.get(pending.attemptId)
    if (settlement?.status !== 'success') return
    if (getComposerDraftRevision(sessionId) !== pending.draftRevision) return
    clearDraftsAfterSend(sessionId, null, settlement.text)
}

export function consumeComposerSendSettlement(sessionId: string, attemptId: string): void {
    const byAttempt = composerSendSettlements.get(sessionId)
    if (!byAttempt?.delete(attemptId)) return
    if (byAttempt.size === 0) composerSendSettlements.delete(sessionId)
    notify()
}

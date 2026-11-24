import type { Database } from 'bun:sqlite'

import { hasConversationMessageContent } from '@hapi/protocol/messages'
import { decodeMessageContent } from './contentCodec'
import { prepareCached } from './statementCache'

import type { StoredMessage } from './types'
import {
    addMessage,
    upsertToolCallMessage,
    getLiveToolWork,
    retireOpenChildToolWork,
    syncNativeQueuedMessage,
    addImportedMessage,
    cancelQueuedMessage,
    deleteLiveReasoningSnapshots,
    deleteQueuedMessageById,
    claimIndeterminateMessage,
    lookupQueuedMessage,
    getMessages,
    getFirstMessages,
    getDeliverableMessagesAfter,
    getMessagesByPosition,
    getMessagesAfterPosition,
    getNewestMessagePosition,
    getMessageEpoch,
    bumpMessageEpoch,
    getLocalMessageStates,
    getUninvokedLocalMessages,
    getMatureScheduledMessages,
    getImmediateQueuedLocalMessages,
    countFutureScheduledBySessionIds,
    countFutureScheduledLocalMessages,
    minFutureScheduledAtBySessionIds,
    countMessages,
    markMessagesInvoked,
    markMessagesIndeterminate,
    markDispatchingMessagesIndeterminate,
    setMessagesDeliveryState,
    markUninvokedImmediateMessages,
    mergeSessionMessages,
    moveUninvokedScheduledMessages,
    moveUninvokedMessages,
    copyMessageToSession as copyStoredMessageToSession,
    copyMessagesToSession as copyStoredMessagesToSession,
    addMessageSweepingLiveSnapshots,
    deleteLiveTextSnapshots,
    getAllMessages,
    getMessagesAfterSeq,
    getMaxSeq,
    getMinSeq,
    getMessageSeqById,
    getMessageById,
    truncateMessagesFromLocalId,
    truncateOpenCodeRewind,
    type CancelQueuedMessageResult,
    type LookupQueuedMessageResult,
    type LocalMessageState,
    type MessagePosition,
    type UpsertToolCallResult,
    type AddMessageSweepResult,
} from './messages'
import {
    hasPotentiallyIncompleteMessageContent,
    searchMessageContent,
    searchMessageContentInSession,
    type MessageContentSearchMatch,
    type SessionMessageContentSearchResult
} from './messageContentSearch'

export class MessageStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    truncateOpenCodeRewind(sessionId: string, cutoffSeq: number, boundaryId: string): number {
        return truncateOpenCodeRewind(this.db, sessionId, cutoffSeq, boundaryId)
    }

    addMessage(sessionId: string, content: unknown, localId?: string, scheduledAt?: number | null, createdAt?: number): StoredMessage {
        return addMessage(this.db, sessionId, content, localId, scheduledAt, createdAt)
    }
    addMessageSweepingLiveSnapshots(
        sessionId: string,
        content: unknown,
        localId?: string,
        scheduledAt?: number | null,
        createdAt?: number
    ): AddMessageSweepResult {
        return addMessageSweepingLiveSnapshots(this.db, sessionId, content, localId, scheduledAt, createdAt)
    }

    deleteLiveTextSnapshots(sessionId: string, streamId: string, keepMessageId?: string): number {
        return deleteLiveTextSnapshots(this.db, sessionId, streamId, keepMessageId)
    }

    upsertToolCallMessage(sessionId: string, content: unknown, callId: string, localId?: string, createdAt?: number): UpsertToolCallResult {
        return upsertToolCallMessage(this.db, sessionId, content, callId, localId, createdAt)
    }

    /** Whether the session tail still holds unsettled tool work (see
     *  getLiveToolWork in messages.ts for the liveness contract). */
    getLiveToolWork(sessionId: string): boolean {
        return getLiveToolWork(this.db, sessionId)
    }

    /** Clear open child / running-child work when the owning worker exits. */
    retireOpenChildToolWork(sessionId: string): boolean {
        return retireOpenChildToolWork(this.db, sessionId)
    }

    syncNativeQueuedMessage(sessionId: string, localId: string, text: string): StoredMessage {
        return syncNativeQueuedMessage(this.db, sessionId, localId, text)
    }

    deleteLiveReasoningSnapshots(sessionId: string, streamId: string, keepMessageId?: string): number {
        return deleteLiveReasoningSnapshots(this.db, sessionId, streamId, keepMessageId)
    }

    addImportedMessage(sessionId: string, content: unknown, localId: string, createdAt: number): { message: StoredMessage; inserted: boolean } {
        return addImportedMessage(this.db, sessionId, content, localId, createdAt)
    }

    copyMessageToSession(
        sessionId: string,
        message: Pick<StoredMessage, 'content' | 'createdAt' | 'localId' | 'invokedAt' | 'scheduledAt' | 'deliveryState'>
    ): StoredMessage {
        // 中文注释：重复会话合并时需要保留源消息的时间戳和排队信息，因此走专门的复制入口而不是普通 addMessage。
        return copyStoredMessageToSession(this.db, sessionId, message)
    }

    copyMessagesToSession(
        sessionId: string,
        messages: Array<Pick<StoredMessage, 'content' | 'createdAt' | 'localId' | 'invokedAt' | 'scheduledAt' | 'deliveryState'>>
    ): number {
        return copyStoredMessagesToSession(this.db, sessionId, messages)
    }

    getAllMessages(sessionId: string): StoredMessage[] {
        return getAllMessages(this.db, sessionId)
    }

    getMessagesAfterSeq(sessionId: string, afterSeq: number): StoredMessage[] {
        return getMessagesAfterSeq(this.db, sessionId, afterSeq)
    }

    getMaxSeq(sessionId: string): number {
        return getMaxSeq(this.db, sessionId)
    }

    getMinSeq(sessionId: string): number | null {
        return getMinSeq(this.db, sessionId)
    }

    getSeqById(sessionId: string, messageId: string): number | null {
        return getMessageSeqById(this.db, sessionId, messageId)
    }

    getMessageById(sessionId: string, messageId: string): StoredMessage | null {
        return getMessageById(this.db, sessionId, messageId)
    }

    getMessages(sessionId: string, limit: number = 200): StoredMessage[] {
        return getMessages(this.db, sessionId, limit)
    }

    getFirstMessages(sessionId: string, limit: number = 50): StoredMessage[] {
        return getFirstMessages(this.db, sessionId, limit)
    }

    getDeliverableMessagesAfter(sessionId: string, afterSeq: number, now: number, limit: number = 200): StoredMessage[] {
        return getDeliverableMessagesAfter(this.db, sessionId, afterSeq, now, limit)
    }

    getMessagesByPosition(sessionId: string, limit: number, before?: { at: number; seq: number }): StoredMessage[] {
        return getMessagesByPosition(this.db, sessionId, limit, before)
    }

    getMessagesAfterPosition(
        sessionId: string,
        limit: number,
        after: MessagePosition,
        until?: MessagePosition
    ): StoredMessage[] {
        return getMessagesAfterPosition(this.db, sessionId, limit, after, until)
    }

    getNewestMessagePosition(sessionId: string): MessagePosition | null {
        return getNewestMessagePosition(this.db, sessionId)
    }

    getMessageEpoch(sessionId: string): number {
        return getMessageEpoch(this.db, sessionId)
    }

    bumpMessageEpoch(sessionId: string): number {
        return bumpMessageEpoch(this.db, sessionId)
    }

    getLocalMessageStates(sessionId: string, localIds: string[]): LocalMessageState[] {
        return getLocalMessageStates(this.db, sessionId, localIds)
    }

    getUninvokedLocalMessages(sessionId: string, options?: { deliverableOnly?: boolean }): StoredMessage[] {
        return getUninvokedLocalMessages(this.db, sessionId, options)
    }

    getMatureScheduledMessages(beforeTime: number): StoredMessage[] {
        return getMatureScheduledMessages(this.db, beforeTime)
    }

    getImmediateQueuedLocalMessages(sessionId: string): StoredMessage[] {
        return getImmediateQueuedLocalMessages(this.db, sessionId)
    }

    countFutureScheduledLocalMessages(sessionId: string, now: number = Date.now()): number {
        return countFutureScheduledLocalMessages(this.db, sessionId, now)
    }

    countFutureScheduledBySessionIds(sessionIds: string[], now: number = Date.now()): Map<string, number> {
        return countFutureScheduledBySessionIds(this.db, sessionIds, now)
    }

    minFutureScheduledAtBySessionIds(sessionIds: string[], now: number = Date.now()): Map<string, number> {
        return minFutureScheduledAtBySessionIds(this.db, sessionIds, now)
    }

    // ponytail: scans through leading bookkeeping; index content if that prefix becomes costly.
    hasConversationContent(sessionId: string): boolean {
        const statement = prepareCached(
            this.db,
            'SELECT seq, content FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT 16'
        )
        let afterSeq = -1
        while (true) {
            const rows = statement.all(sessionId, afterSeq) as Array<{ seq: number; content: string | Uint8Array }>
            if (rows.length === 0) {
                return false
            }
            for (const row of rows) {
                if (hasConversationMessageContent(decodeMessageContent(row.content))) {
                    return true
                }
            }
            if (rows.length < 16) {
                return false
            }
            afterSeq = rows[rows.length - 1]!.seq
        }
    }

    countMessages(sessionId: string): number {
        return countMessages(this.db, sessionId)
    }

    searchContent(
        query: string,
        namespace: string,
        limit: number = 50,
        sessionIds?: readonly string[]
    ): MessageContentSearchMatch[] {
        return searchMessageContent(this.db, query, namespace, limit, sessionIds)
    }

    searchContentInSession(
        query: string,
        namespace: string,
        sessionId: string,
        limit: number = 500
    ): SessionMessageContentSearchResult {
        return searchMessageContentInSession(this.db, query, namespace, sessionId, limit)
    }

    hasPotentiallyIncompleteContent(
        namespace: string,
        query: string,
        sessionIds?: readonly string[]
    ): boolean {
        return hasPotentiallyIncompleteMessageContent(this.db, namespace, query, sessionIds)
    }

    cancelQueuedMessage(sessionId: string, messageId: string): CancelQueuedMessageResult {
        return cancelQueuedMessage(this.db, sessionId, messageId)
    }

    lookupQueuedMessage(sessionId: string, messageId: string): LookupQueuedMessageResult {
        return lookupQueuedMessage(this.db, sessionId, messageId)
    }

    deleteQueuedMessageById(sessionId: string, messageId: string): boolean {
        return deleteQueuedMessageById(this.db, sessionId, messageId)
    }

    claimIndeterminateMessage(sessionId: string, messageId: string): StoredMessage | null {
        return claimIndeterminateMessage(this.db, sessionId, messageId)
    }

    markMessagesInvoked(sessionId: string, localIds: string[], invokedAt: number): number {
        return markMessagesInvoked(this.db, sessionId, localIds, invokedAt)
    }

    markDispatchingMessagesIndeterminate(sessionId: string): string[] {
        return markDispatchingMessagesIndeterminate(this.db, sessionId)
    }

    markMessagesIndeterminate(sessionId: string, localIds: string[]): number {
        return markMessagesIndeterminate(this.db, sessionId, localIds)
    }

    setMessagesDeliveryState(sessionId: string, localIds: string[], state: 'queued' | 'dispatching' | 'indeterminate'): number {
        return setMessagesDeliveryState(this.db, sessionId, localIds, state)
    }

    markUninvokedImmediateMessages(sessionId: string, invokedAt: number): string[] {
        return markUninvokedImmediateMessages(this.db, sessionId, invokedAt)
    }

    moveUninvokedScheduledMessages(fromSessionId: string, toSessionId: string): number {
        return moveUninvokedScheduledMessages(this.db, fromSessionId, toSessionId)
    }

    moveUninvokedMessages(fromSessionId: string, toSessionId: string): number {
        return moveUninvokedMessages(this.db, fromSessionId, toSessionId)
    }

    mergeSessionMessages(fromSessionId: string, toSessionId: string): { moved: number; oldMaxSeq: number; newMaxSeq: number } {
        return mergeSessionMessages(this.db, fromSessionId, toSessionId)
    }

    truncateMessagesFromLocalId(
        sessionId: string,
        localId: string,
        replacement: Array<{
            content: unknown
            localId?: string | null
            createdAt?: number
            invokedAt?: number | null
        }> = [],
        upToSeq?: number
    ): { deleted: number; inserted: number; epoch: number } {
        return truncateMessagesFromLocalId(this.db, sessionId, localId, replacement, upToSeq)
    }
}

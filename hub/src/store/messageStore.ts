import type { Database } from 'bun:sqlite'

import type { StoredMessage } from './types'
import { addMessage, cancelQueuedMessage, deleteQueuedMessageById, lookupQueuedMessage, getMessages, getMessagesAfter, getMessagesByPosition, getUninvokedLocalMessages, markMessagesInvoked, mergeSessionMessages, type CancelQueuedMessageResult, type LookupQueuedMessageResult } from './messages'

export class MessageStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    addMessage(sessionId: string, content: unknown, localId?: string): StoredMessage {
        return addMessage(this.db, sessionId, content, localId)
    }

    getMessages(sessionId: string, limit: number = 200, beforeSeq?: number): StoredMessage[] {
        return getMessages(this.db, sessionId, limit, beforeSeq)
    }

    getMessagesAfter(sessionId: string, afterSeq: number, limit: number = 200): StoredMessage[] {
        return getMessagesAfter(this.db, sessionId, afterSeq, limit)
    }

    getMessagesByPosition(sessionId: string, limit: number, before?: { at: number; seq: number }): StoredMessage[] {
        return getMessagesByPosition(this.db, sessionId, limit, before)
    }

    getUninvokedLocalMessages(sessionId: string): StoredMessage[] {
        return getUninvokedLocalMessages(this.db, sessionId)
    }

    cancelQueuedMessage(sessionId: string, messageId: string): CancelQueuedMessageResult {
        return cancelQueuedMessage(this.db, sessionId, messageId)
    }

    lookupQueuedMessage(sessionId: string, messageId: string): LookupQueuedMessageResult {
        return lookupQueuedMessage(this.db, sessionId, messageId)
    }

    deleteQueuedMessageById(sessionId: string, messageId: string): void {
        deleteQueuedMessageById(this.db, sessionId, messageId)
    }

    markMessagesInvoked(sessionId: string, localIds: string[], invokedAt: number): void {
        markMessagesInvoked(this.db, sessionId, localIds, invokedAt)
    }

    mergeSessionMessages(fromSessionId: string, toSessionId: string): { moved: number; oldMaxSeq: number; newMaxSeq: number } {
        return mergeSessionMessages(this.db, fromSessionId, toSessionId)
    }
}

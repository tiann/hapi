import type { Database } from 'bun:sqlite'

import type { StoredMessage } from './types'
import { addMessage, getMessages, getMessagesAfter, mergeSessionMessages, mergeSessionMessagesInTransaction } from './messages'

export class MessageStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    addMessage(sessionId: string, content: unknown, localId?: string): StoredMessage {
        return addMessage(this.db, sessionId, content, localId)
    }

    getMessages(
        sessionId: string,
        limit: number = 200,
        beforeSeq?: number,
        options?: { maxLimit?: number }
    ): StoredMessage[] {
        return getMessages(this.db, sessionId, limit, beforeSeq, options)
    }

    getMessagesAfter(
        sessionId: string,
        afterSeq: number,
        limit: number = 200,
        options?: { maxLimit?: number }
    ): StoredMessage[] {
        return getMessagesAfter(this.db, sessionId, afterSeq, limit, options)
    }

    mergeSessionMessages(fromSessionId: string, toSessionId: string): { moved: number; oldMaxSeq: number; newMaxSeq: number } {
        return mergeSessionMessages(this.db, fromSessionId, toSessionId)
    }

    mergeSessionMessagesInTransaction(fromSessionId: string, toSessionId: string): { moved: number; oldMaxSeq: number; newMaxSeq: number } {
        return mergeSessionMessagesInTransaction(this.db, fromSessionId, toSessionId)
    }
}

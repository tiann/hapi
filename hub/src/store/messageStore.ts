import type { Database } from 'bun:sqlite'

import type { StoredMessage } from './types'
import { addMessage, cloneSessionMessages, getMessageBySeq, getMessages, getMessagesAfter, getMessagesByPosition, getNextUserMessageSeq, getPreviousUserMessageSeq, getUninvokedLocalMessages, markMessagesInvoked, mergeSessionMessages } from './messages'

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

    getMessageBySeq(sessionId: string, seq: number): StoredMessage | null {
        return getMessageBySeq(this.db, sessionId, seq)
    }

    getNextUserMessageSeq(sessionId: string, afterSeq: number): number | null {
        return getNextUserMessageSeq(this.db, sessionId, afterSeq)
    }

    getPreviousUserMessageSeq(sessionId: string, beforeSeq: number): number | null {
        return getPreviousUserMessageSeq(this.db, sessionId, beforeSeq)
    }

    markMessagesInvoked(sessionId: string, localIds: string[], invokedAt: number): void {
        markMessagesInvoked(this.db, sessionId, localIds, invokedAt)
    }

    mergeSessionMessages(fromSessionId: string, toSessionId: string): { moved: number; oldMaxSeq: number; newMaxSeq: number } {
        return mergeSessionMessages(this.db, fromSessionId, toSessionId)
    }

    cloneSessionMessages(fromSessionId: string, toSessionId: string, beforeSeq?: number): { cloned: number; sourceMaxSeq: number; targetMaxSeq: number } {
        return cloneSessionMessages(this.db, fromSessionId, toSessionId, beforeSeq)
    }
}

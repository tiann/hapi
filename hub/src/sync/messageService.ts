import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol'
import type { AttachmentMetadata, DecryptedMessage } from '@hapi/protocol/types'
import type { Server } from 'socket.io'
import type { Store } from '../store'
import type { StoredMessage } from '../store'
import { EventPublisher } from './eventPublisher'
import {
    extractAgentOutputUserText,
    extractTextContent,
    isSkippableCodexPseudoUserMessage,
    readCompleteMessagePage,
} from './messagePage'
import type { MessagePageOptions, MessagePageResult } from './messagePage'

const RECENT_USER_MESSAGE_PAGE_SIZE = 200
const RECENT_USER_MESSAGE_MAX_LIMIT = 10
export type RecentUserMessage = {
    id: string
    seq: number
    createdAt: number
    text: string
}

function extractRecentUserMessage(message: StoredMessage): RecentUserMessage | null {
    const record = unwrapRoleWrappedRecordEnvelope(message.content)
    if (!record) {
        return null
    }

    const text = record.role === 'user'
        ? extractTextContent(record.content)
        : record.role === 'agent'
            ? extractAgentOutputUserText(record.content)
            : null

    if (text === null || text.trim().length === 0) {
        return null
    }
    if (isSkippableCodexPseudoUserMessage(message, text, record.meta)) {
        return null
    }
    return {
        id: message.id,
        seq: message.seq,
        createdAt: message.createdAt,
        text
    }
}

function dedupeKey(text: string): string {
    return text.replace(/\r\n?/g, '\n').trim()
}

export class MessageService {
    constructor(
        private readonly store: Store,
        private readonly io: Server,
        private readonly publisher: EventPublisher
    ) {
    }

    getMessagesPage(sessionId: string, options: MessagePageOptions): MessagePageResult {
        return readCompleteMessagePage(this.store.messages, sessionId, options)
    }

    getMessagesAfter(sessionId: string, options: { afterSeq: number; limit: number }): DecryptedMessage[] {
        const stored = this.store.messages.getMessagesAfter(sessionId, options.afterSeq, options.limit)
        return stored.map((message) => ({
            id: message.id,
            seq: message.seq,
            localId: message.localId,
            content: message.content,
            createdAt: message.createdAt
        }))
    }

    getRecentUserMessages(sessionId: string, options: { limit: number }): RecentUserMessage[] {
        const requestedLimit = Number.isFinite(options.limit)
            ? Math.max(1, Math.min(RECENT_USER_MESSAGE_MAX_LIMIT, Math.trunc(options.limit)))
            : RECENT_USER_MESSAGE_MAX_LIMIT
        const recent: RecentUserMessage[] = []
        const seen = new Set<string>()
        let beforeSeq: number | undefined

        while (recent.length < requestedLimit) {
            const page = this.store.messages.getMessages(sessionId, RECENT_USER_MESSAGE_PAGE_SIZE, beforeSeq)
            if (page.length === 0) {
                break
            }

            for (let index = page.length - 1; index >= 0; index -= 1) {
                const extracted = extractRecentUserMessage(page[index]!)
                if (!extracted) {
                    continue
                }
                const key = dedupeKey(extracted.text)
                if (seen.has(key)) {
                    continue
                }
                seen.add(key)
                recent.push(extracted)
                if (recent.length >= requestedLimit) {
                    break
                }
            }

            if (page.length < RECENT_USER_MESSAGE_PAGE_SIZE) {
                break
            }
            beforeSeq = page[0]?.seq
            if (beforeSeq === undefined) {
                break
            }
        }

        return recent
    }

    async sendMessage(
        sessionId: string,
        payload: {
            text: string
            localId?: string | null
            attachments?: AttachmentMetadata[]
            sentFrom?: 'telegram-bot' | 'webapp'
        }
    ): Promise<void> {
        const sentFrom = payload.sentFrom ?? 'webapp'

        const content = {
            role: 'user',
            content: {
                type: 'text',
                text: payload.text,
                attachments: payload.attachments
            },
            meta: {
                sentFrom
            }
        }

        const msg = this.store.messages.addMessage(sessionId, content, payload.localId ?? undefined)

        const update = {
            id: msg.id,
            seq: msg.seq,
            createdAt: msg.createdAt,
            body: {
                t: 'new-message' as const,
                sid: sessionId,
                message: {
                    id: msg.id,
                    seq: msg.seq,
                    createdAt: msg.createdAt,
                    localId: msg.localId,
                    content: msg.content
                }
            }
        }
        this.io.of('/cli').to(`session:${sessionId}`).emit('update', update)

        this.publisher.emit({
            type: 'message-received',
            sessionId,
            message: {
                id: msg.id,
                seq: msg.seq,
                localId: msg.localId,
                content: msg.content,
                createdAt: msg.createdAt
            }
        })
    }
}

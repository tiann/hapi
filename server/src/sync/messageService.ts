import type { AttachmentMetadata, DecryptedMessage } from '@hapi/protocol/types'
import type { Server } from 'socket.io'
import type { Store } from '../store'
import { EventPublisher } from './eventPublisher'

export class MessageService {
    constructor(
        private readonly store: Store,
        private readonly io: Server,
        private readonly publisher: EventPublisher
    ) {
    }

    getMessagesPage(sessionId: string, options: { limit: number; beforeSeq: number | null }): {
        messages: DecryptedMessage[]
        page: {
            limit: number
            beforeSeq: number | null
            nextBeforeSeq: number | null
            hasMore: boolean
        }
    } {
        console.log('[MessageService.getMessagesPage] Fetching messages:', {
            sessionId,
            limit: options.limit,
            beforeSeq: options.beforeSeq
        })

        const stored = this.store.messages.getMessages(sessionId, options.limit, options.beforeSeq ?? undefined)

        console.log('[MessageService.getMessagesPage] Database returned:', {
            sessionId,
            storedCount: stored.length
        })

        const messages: DecryptedMessage[] = stored.map((message) => ({
            id: message.id,
            seq: message.seq,
            localId: message.localId,
            content: message.content,
            createdAt: message.createdAt
        }))

        let oldestSeq: number | null = null
        for (const message of messages) {
            if (typeof message.seq !== 'number') continue
            if (oldestSeq === null || message.seq < oldestSeq) {
                oldestSeq = message.seq
            }
        }

        const nextBeforeSeq = oldestSeq
        const hasMore = nextBeforeSeq !== null
            && this.store.messages.getMessages(sessionId, 1, nextBeforeSeq).length > 0

        console.log('[MessageService.getMessagesPage] Returning:', {
            sessionId,
            messageCount: messages.length,
            hasMore,
            nextBeforeSeq
        })

        return {
            messages,
            page: {
                limit: options.limit,
                beforeSeq: options.beforeSeq,
                nextBeforeSeq,
                hasMore
            }
        }
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

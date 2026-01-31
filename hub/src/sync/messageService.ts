import type { AttachmentMetadata, DecryptedMessage, MessageUsage } from '@hapi/protocol/types'
import type { Server } from 'socket.io'
import type { Store } from '../store'
import { EventPublisher } from './eventPublisher'

// Extract usage information from message content
function extractUsageFromContent(content: unknown): MessageUsage | undefined {
    if (!content || typeof content !== 'object') return undefined

    // Check if content has usage directly (Claude format)
    if ('usage' in content && typeof content.usage === 'object' && content.usage !== null) {
        const usage = content.usage as Record<string, unknown>
        const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined
        const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined
        const cacheCreation = typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : undefined
        const cacheRead = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : undefined
        const serviceTier = typeof usage.service_tier === 'string' ? usage.service_tier : undefined

        if (inputTokens !== undefined && outputTokens !== undefined) {
            return {
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                cache_creation_input_tokens: cacheCreation,
                cache_read_input_tokens: cacheRead,
                service_tier: serviceTier
            }
        }
    }

    // Check if content is in codex format with nested data
    if ('content' in content && typeof content.content === 'object' && content.content !== null) {
        const contentObj = content.content as Record<string, unknown>
        if ('type' in contentObj && contentObj.type === 'output' && 'data' in contentObj) {
            const data = contentObj.data as Record<string, unknown>
            if ('message' in data && typeof data.message === 'object' && data.message !== null) {
                const message = data.message as Record<string, unknown>
                if ('usage' in message && typeof message.usage === 'object' && message.usage !== null) {
                    const usage = message.usage as Record<string, unknown>
                    const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined
                    const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined
                    const cacheCreation = typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : undefined
                    const cacheRead = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : undefined
                    const serviceTier = typeof usage.service_tier === 'string' ? usage.service_tier : undefined

                    if (inputTokens !== undefined && outputTokens !== undefined) {
                        return {
                            input_tokens: inputTokens,
                            output_tokens: outputTokens,
                            cache_creation_input_tokens: cacheCreation,
                            cache_read_input_tokens: cacheRead,
                            service_tier: serviceTier
                        }
                    }
                }
            }
        }
    }

    return undefined
}

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
        const stored = this.store.messages.getMessages(sessionId, options.limit, options.beforeSeq ?? undefined)
        const messages: DecryptedMessage[] = stored.map((message) => ({
            id: message.id,
            seq: message.seq,
            localId: message.localId,
            content: message.content,
            createdAt: message.createdAt,
            usage: extractUsageFromContent(message.content)
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
            createdAt: message.createdAt,
            usage: extractUsageFromContent(message.content)
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

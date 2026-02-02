import type { Server } from 'socket.io'
import type { Store } from '../store'
import { EventPublisher } from './eventPublisher'
import type { SessionCache } from './sessionCache'
import { SessionLock } from './sessionLock'
import * as messageQueue from '../store/messageQueue'

const MAX_QUEUE_SIZE = 50

export class MessageQueueService {
    private readonly sessionLock: SessionLock

    constructor(
        private readonly store: Store,
        private readonly io: Server,
        private readonly publisher: EventPublisher,
        private readonly sessionCache: SessionCache
    ) {
        this.sessionLock = new SessionLock()

        // Recover messages stuck in 'processing' state
        messageQueue.recoverProcessingMessages(store.db)
    }

    /**
     * Submit message: execute immediately if session unlocked, otherwise enqueue
     */
    async submitMessage(
        sessionId: string,
        payload: {
            text: string
            localId?: string | null
            attachments?: Array<any>
            sentFrom?: 'telegram-bot' | 'webapp' | 'tui'
        }
    ): Promise<{ queued: boolean; queuePosition?: number; error?: string }> {
        const session = this.sessionCache.getSession(sessionId)
        if (!session) {
            throw new Error('Session not found')
        }

        // Check queue size limit
        const queueSize = messageQueue.getQueueCount(this.store.db, sessionId)
        if (queueSize >= MAX_QUEUE_SIZE) {
            return {
                queued: false,
                error: `Queue full (max ${MAX_QUEUE_SIZE} messages)`
            }
        }

        // Check if session is currently locked
        const hasQueuedMessages = queueSize > 0
        if (this.sessionLock.isLocked(sessionId) || hasQueuedMessages) {
            // Enqueue to database
            const content = this.buildMessageContent(payload)
            const queued = messageQueue.enqueueMessage(
                this.store.db,
                sessionId,
                content,
                payload.localId ?? undefined
            )

            this.broadcastQueueUpdate(sessionId)

            this.publisher.emit({
                type: 'message-queued',
                sessionId,
                queueId: queued.id
            })

            return {
                queued: true,
                queuePosition: queueSize + 1
            }
        }

        // Attempt immediate send with lock
        const sent = await this.sessionLock.executeOrEnqueue(sessionId, async () => {
            await this.sendMessageDirectly(sessionId, payload)
        })

        if (sent) {
            // Successfully sent immediately
            // Process any queued messages now
            this.processQueueAsync(sessionId)

            return { queued: false }
        } else {
            // Race: lock was acquired between check and execute
            // Fallback to enqueue
            const content = this.buildMessageContent(payload)
            const queued = messageQueue.enqueueMessage(
                this.store.db,
                sessionId,
                content,
                payload.localId ?? undefined
            )

            this.broadcastQueueUpdate(sessionId)

            return {
                queued: true,
                queuePosition: queueSize + 1
            }
        }
    }

    /**
     * Process next queued message (called after message completion)
     */
    private async processQueueAsync(sessionId: string): Promise<void> {
        // Don't await - run in background
        this.processNextMessage(sessionId).catch(err => {
            console.error('[MessageQueueService] Error processing queue:', err)
        })
    }

    /**
     * Process next message in queue with locking
     */
    private async processNextMessage(sessionId: string): Promise<boolean> {
        const next = messageQueue.getNextQueuedMessage(this.store.db, sessionId)
        if (!next) {
            return false // Queue empty
        }

        // Attempt to acquire lock and process
        return await this.sessionLock.executeOrEnqueue(sessionId, async () => {
            await this.processQueuedMessage(next)

            // After successful processing, recursively process next
            await this.processNextMessage(sessionId)
        })
    }

    /**
     * Process a single queued message
     */
    private async processQueuedMessage(queued: messageQueue.QueuedMessage): Promise<void> {
        const sessionId = queued.sessionId

        try {
            // Mark as processing
            messageQueue.markQueuedMessageProcessing(this.store.db, queued.id)
            this.broadcastQueueUpdate(sessionId)

            this.publisher.emit({
                type: 'message-processing',
                sessionId,
                queueId: queued.id
            })

            // Extract payload from content
            const content = queued.content as any
            const payload = {
                text: content.content?.text ?? '',
                localId: queued.localId,
                attachments: content.content?.attachments,
                sentFrom: content.meta?.sentFrom
            }

            // Send the message
            await this.sendMessageDirectly(sessionId, payload)

            // Remove from queue on success
            messageQueue.removeQueuedMessage(this.store.db, queued.id)
            this.broadcastQueueUpdate(sessionId)

            this.publisher.emit({
                type: 'message-queue-completed',
                sessionId,
                queueId: queued.id
            })
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error'
            const errorType: messageQueue.ErrorType = this.classifyError(error)

            messageQueue.markQueuedMessageFailed(
                this.store.db,
                queued.id,
                errorMsg,
                errorType
            )

            this.broadcastQueueUpdate(sessionId)

            this.publisher.emit({
                type: 'message-queue-failed',
                sessionId,
                queueId: queued.id,
                error: errorMsg
            })

            throw error // Propagate to stop queue processing
        }
    }

    /**
     * Retry a failed message
     */
    async retryFailedMessage(sessionId: string, queueId: string): Promise<void> {
        const queued = messageQueue.getQueuedMessage(this.store.db, queueId)
        if (!queued || queued.sessionId !== sessionId) {
            throw new Error('Queued message not found')
        }

        if (queued.status !== 'failed') {
            throw new Error('Message is not in failed state')
        }

        // Reset to queued status
        messageQueue.resetQueuedMessageToQueued(this.store.db, queueId)
        this.broadcastQueueUpdate(sessionId)

        // Trigger queue processing
        this.processQueueAsync(sessionId)
    }

    /**
     * Cancel/delete a queued message
     */
    async cancelQueuedMessage(sessionId: string, queueId: string): Promise<void> {
        const queued = messageQueue.getQueuedMessage(this.store.db, queueId)
        if (!queued || queued.sessionId !== sessionId) {
            throw new Error('Queued message not found')
        }

        if (queued.status === 'processing') {
            throw new Error('Cannot cancel message that is currently processing')
        }

        messageQueue.removeQueuedMessage(this.store.db, queueId)
        this.broadcastQueueUpdate(sessionId)

        this.publisher.emit({
            type: 'message-queue-cancelled',
            sessionId,
            queueId
        })
    }

    /**
     * Called when session becomes ready (thinking → false transition)
     */
    async onSessionReady(sessionId: string): Promise<void> {
        // Check if there are queued messages
        const hasQueued = messageQueue.getQueueCount(this.store.db, sessionId) > 0
        if (!hasQueued) {
            return
        }

        // Process queue in background
        this.processQueueAsync(sessionId)
    }

    private buildMessageContent(payload: {
        text: string
        attachments?: any[]
        sentFrom?: string
    }): unknown {
        return {
            role: 'user',
            content: {
                type: 'text',
                text: payload.text,
                attachments: payload.attachments
            },
            meta: {
                sentFrom: payload.sentFrom ?? 'webapp'
            }
        }
    }

    private async sendMessageDirectly(
        sessionId: string,
        payload: {
            text: string
            localId?: string | null
            attachments?: any[]
            sentFrom?: 'telegram-bot' | 'webapp' | 'tui'
        }
    ): Promise<void> {
        const content = this.buildMessageContent(payload)

        const msg = this.store.messages.addMessage(
            sessionId,
            content,
            payload.localId ?? undefined
        )

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

    private broadcastQueueUpdate(sessionId: string): void {
        const queue = messageQueue.getQueuedMessages(this.store.db, sessionId)

        this.io.of('/cli').to(`session:${sessionId}`).emit('queue-update', {
            sessionId,
            queue: queue.map(q => ({
                id: q.id,
                localId: q.localId,
                status: q.status,
                createdAt: q.createdAt,
                text: this.extractText(q.content),
                errorMessage: q.errorMessage,
                errorType: q.errorType,
                retryCount: q.retryCount
            }))
        })
    }

    private extractText(content: unknown): string {
        const c = content as any
        return c?.content?.text ?? ''
    }

    private classifyError(error: unknown): messageQueue.ErrorType {
        const msg = error instanceof Error ? error.message.toLowerCase() : ''

        // Transient errors (network, timeout, etc.)
        if (msg.includes('timeout') || msg.includes('network') || msg.includes('econnrefused')) {
            return 'transient'
        }

        // Terminal errors (validation, not found, etc.)
        return 'terminal'
    }

    getQueueCount(sessionId: string): number {
        return messageQueue.getQueueCount(this.store.db, sessionId)
    }
}

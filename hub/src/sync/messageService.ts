import type { AttachmentMetadata, DecryptedMessage } from '@hapi/protocol/types'
import type { Server } from 'socket.io'
import { randomUUID } from 'node:crypto'
import type { Store, CancelQueuedMessageResult } from '../store'
import { EventPublisher } from './eventPublisher'

export class MessageService {
    constructor(
        private readonly store: Store,
        private readonly io: Server,
        private readonly publisher: EventPublisher,
        private readonly onSessionActivity?: (sessionId: string, updatedAt: number) => void
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
            invokedAt: message.invokedAt
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

    getMessagesPageByPosition(
        sessionId: string,
        options: { limit: number; before?: { at: number; seq: number } | null }
    ): {
        messages: DecryptedMessage[]
        page: {
            limit: number
            nextBeforeSeq: number | null
            nextBeforeAt: number | null
            hasMore: boolean
        }
    } {
        const before = options.before ?? undefined
        const pageRows = this.store.messages.getMessagesByPosition(sessionId, options.limit, before)

        // Latest-page request (no cursor): also include uninvoked local user messages
        // out-of-band, so refresh / secondary clients can still see queued rows even
        // when their position key (createdAt) places them outside the latest page.
        // The cursor stays anchored to pageRows so out-of-band rows don't affect
        // pagination of older pages.
        const queuedRows = before === undefined
            ? this.store.messages.getUninvokedLocalMessages(sessionId)
            : []

        const byId = new Map<string, typeof pageRows[number]>()
        for (const row of pageRows) byId.set(row.id, row)
        for (const row of queuedRows) byId.set(row.id, row)

        const stored = [...byId.values()].sort((a, b) => {
            const at = (a.invokedAt ?? a.createdAt) - (b.invokedAt ?? b.createdAt)
            return at !== 0 ? at : a.seq - b.seq
        })

        const messages: DecryptedMessage[] = stored.map((message) => ({
            id: message.id,
            seq: message.seq,
            localId: message.localId,
            content: message.content,
            createdAt: message.createdAt,
            invokedAt: message.invokedAt
        }))

        // The cursor is the oldest row in the actual position-ordered page (pageRows[0]).
        // Out-of-band queued rows are not part of the cursor — they are pinned to
        // every latest-page response.
        const oldest = pageRows[0] ?? null
        const oldestSeq: number | null = oldest?.seq ?? null
        const oldestPositionAt: number | null = oldest
            ? oldest.invokedAt ?? oldest.createdAt
            : null

        const hasMore = oldestSeq !== null && oldestPositionAt !== null
            && this.store.messages.getMessagesByPosition(
                sessionId,
                1,
                { at: oldestPositionAt, seq: oldestSeq }
            ).length > 0

        return {
            messages,
            page: {
                limit: options.limit,
                nextBeforeSeq: oldestSeq,
                nextBeforeAt: oldestPositionAt,
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
            invokedAt: message.invokedAt
        }))
    }

    async cancelQueuedMessage(
        sessionId: string,
        messageId: string
    ): Promise<CancelQueuedMessageResult> {
        // Phase 1: look up the row WITHOUT deleting it.
        // This lets us ask the CLI first and only DELETE if the CLI confirms removal.
        const lookup = this.store.messages.lookupQueuedMessage(sessionId, messageId)

        if (lookup.status === 'absent') {
            // Row not found — already cancelled or wrong id.
            return { status: 'cancelled', localId: null }
        }

        if (lookup.status === 'invoked') {
            // DB row already has invoked_at — CLI consumed it before we arrived.
            // Return the full invoked row so the web client can restore authoritative
            // state (with correct invokedAt) instead of a stale queued snapshot.
            return lookup
        }

        // Phase 2: row is still queued.  Ask the CLI whether it already shifted the item
        // (race window between collectBatch() shift and messages-consumed ack).
        const { localId, resolvedId } = lookup

        if (!localId) {
            // No localId — row exists but has no cancel path; treat as cancelled.
            this.store.messages.deleteQueuedMessageById(sessionId, resolvedId)
            this.publisher.emit({ type: 'message-cancelled', sessionId, messageId })
            return { status: 'cancelled', localId: null }
        }

        // Phase 2a: if no CLI socket is currently in the session room, the CLI is
        // offline and there is nobody to ack with.  Delete the row immediately so a
        // later CLI reconnect cannot pick it up via seq-backfill and re-enqueue the
        // cancelled message.
        //
        // TOCTOU note: deleteQueuedMessageById already has an invoked_at IS NULL guard,
        // so if a CLI socket joins between the cliCount read and the DELETE and wins the
        // race by calling markMessagesInvoked first, the DELETE becomes a no-op.
        // We re-read the row after the delete to detect that case and handle it exactly
        // like Race-B (ack returned removed:false).
        const roomName = `session:${sessionId}`
        const cliCount = this.io.of('/cli').adapter.rooms.get(roomName)?.size ?? 0
        if (cliCount === 0) {
            this.store.messages.deleteQueuedMessageById(sessionId, resolvedId)
            // Re-check: if CLI joined and invoked the message between our cliCount read
            // and the DELETE, the delete was a no-op and the row now has invoked_at set.
            const recheck = this.store.messages.lookupQueuedMessage(sessionId, resolvedId)
            if (recheck.status === 'invoked') {
                // CLI beat us — treat identically to Race-B (ack returned not-found).
                this.publisher.emit({
                    type: 'messages-consumed',
                    sessionId,
                    localIds: [localId],
                    invokedAt: recheck.message.invokedAt!,
                })
                return recheck
            }
            // Row is gone (absent) — clean cancel.
            this.publisher.emit({
                type: 'message-cancelled',
                sessionId,
                messageId,
                localId,
            })
            return { status: 'cancelled', localId }
        }

        const ackResult = await this.requestCliCancelAck(sessionId, localId, messageId, 500)

        if (ackResult === 'not-found' || ackResult === 'timeout') {
            // CLI could not remove the item — it was already shift()-ed or CLI is
            // offline.  Stamp invoked_at immediately so the message lands in the thread
            // as 'sent' instead of disappearing.  The agent's later assistant message
            // (if it produced one) joins the same thread normally.
            const invokedAt = Date.now()
            try {
                this.store.messages.markMessagesInvoked(sessionId, [localId], invokedAt)
            } catch (err) {
                console.error('cancelQueuedMessage: markMessagesInvoked failed', err)
                // DB write failed — let the HTTP 500 surface to the caller.
                throw err
            }
            // Notify all SSE subscribers (other open tabs) that this queued row is now
            // invoked so they remove it from the floating bar.  Without this emit, only
            // the tab that sent the DELETE request learns about the status change via the
            // HTTP response; every other subscriber keeps the row in the queued bar until
            // a refresh or a later event.  Mirrors the identical publish in the normal
            // CLI-driven path (sessionHandlers.ts messages-consumed handler).
            this.publisher.emit({
                type: 'messages-consumed',
                sessionId,
                localIds: [localId],
                invokedAt,
            })
            // Re-fetch the single row via lookupQueuedMessage to avoid the 200-row
            // pagination cap of getMessages.  After markMessagesInvoked the row will
            // have invoked_at set, so lookupQueuedMessage returns status='invoked'.
            const recheck = this.store.messages.lookupQueuedMessage(sessionId, localId)
            if (recheck.status === 'invoked') {
                return recheck
            }
            // Row absent from DB after markMessagesInvoked — edge case, treat as cancelled
            return { status: 'cancelled', localId }
        }

        // Phase 3: CLI confirmed removal.  Now DELETE the DB row and broadcast SSE.
        this.store.messages.deleteQueuedMessageById(sessionId, resolvedId)
        this.publisher.emit({
            type: 'message-cancelled',
            sessionId,
            messageId
        })

        return { status: 'cancelled', localId }
    }

    /**
     * Ask the CLI (via socket.io ack) whether it removed the in-memory queue item.
     * Returns 'removed', 'not-found', or 'timeout'.
     *
     * Re-uses the existing 'update' event channel with a cancel-queued-message body,
     * matching the ack pattern already used by rpcGateway
     * (socket.timeout(ms).emitWithAck / BroadcastOperator.timeout(ms).emit + ack cb).
     */
    private requestCliCancelAck(
        sessionId: string,
        localId: string,
        messageId: string,
        timeoutMs: number
    ): Promise<'removed' | 'not-found' | 'timeout'> {
        return new Promise((resolve) => {
            const room = this.io.of('/cli').to(`session:${sessionId}`)
            // socket.io v4 BroadcastOperator: .timeout(ms).emit(event, data, ackCb)
            // ack signature: (err: Error | null, responses: T[])
            room.timeout(timeoutMs).emit(
                'update',
                {
                    id: randomUUID(),
                    seq: 0,
                    createdAt: Date.now(),
                    body: {
                        t: 'cancel-queued-message' as const,
                        sid: sessionId,
                        messageId,
                        localId
                    }
                },
                (err: Error | null, responses: Array<{ removed: boolean }>) => {
                    // Check responses before err: in a reconnect overlap or any room with
                    // multiple CLI sockets, Socket.IO may set err (one socket timed out)
                    // while still delivering successful responses from the sockets that did
                    // ack. Any confirmed removal wins over the partial timeout.
                    const removed = responses?.some((r) => r.removed === true) ?? false
                    if (removed) {
                        resolve('removed')
                        return
                    }
                    if (err) {
                        resolve('timeout')
                        return
                    }
                    resolve('not-found')
                }
            )
        })
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
        this.onSessionActivity?.(sessionId, msg.createdAt)

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
                createdAt: msg.createdAt,
                invokedAt: msg.invokedAt
            }
        })
    }
}

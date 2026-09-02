import {
    HAPI_SESSION_EXPORT_SCHEMA_VERSION,
    SESSION_EXPORT_MAX_BYTES,
    SESSION_EXPORT_MESSAGE_LIMIT,
    type HapiSessionExport,
    type HapiSessionExportResult
} from '@hapi/protocol/sessionExport'
import type { AttachmentMetadata, DecryptedMessage, Session } from '@hapi/protocol/types'
import { isHubScratchlistAttachmentPath } from '@hapi/protocol'
import {
    isClaudeChatVisibleMessage,
    isRedundantGoalStatusEventContent,
    unwrapRoleWrappedRecordEnvelope
} from '@hapi/protocol/messages'
import { isObject } from '@hapi/protocol'
import type { MessageDeliveryMode, MessagesResponse, QueuedStateResponse } from '@hapi/protocol/apiTypes'
import type { Server } from 'socket.io'
import { randomUUID } from 'node:crypto'
import type { Store, CancelQueuedMessageResult } from '../store'
import { EventPublisher } from './eventPublisher'

type StoredMessageForDelivery = ReturnType<Store['messages']['getMessages']>[number]
type MessagePosition = { at: number; seq: number }

function messagePosition(message: StoredMessageForDelivery): MessagePosition {
    return {
        at: message.invokedAt ?? message.createdAt,
        seq: message.seq
    }
}

function comparePosition(a: MessagePosition, b: MessagePosition): number {
    return a.at !== b.at ? a.at - b.at : a.seq - b.seq
}

function isWebVisibleStoredMessage(message: StoredMessageForDelivery): boolean {
    return !isRedundantGoalStatusEventContent(message.content)
}

function toDecryptedMessage(message: StoredMessageForDelivery): DecryptedMessage {
    return {
        id: message.id,
        seq: message.seq,
        localId: message.localId,
        content: message.content,
        createdAt: message.createdAt,
        invokedAt: message.invokedAt,
        scheduledAt: message.scheduledAt,
        ...(message.deliveryState ? { deliveryState: message.deliveryState } : {})
    }
}

function toVisibleDecryptedMessages(messages: StoredMessageForDelivery[]): DecryptedMessage[] {
    return messages.filter(isWebVisibleStoredMessage).map(toDecryptedMessage)
}

function jsonByteLength(value: unknown): number {
    const json = JSON.stringify(value)
    return json === undefined ? Number.MAX_SAFE_INTEGER : Buffer.byteLength(json, 'utf8')
}

function estimateSessionExportBytes(
    session: Session,
    exportedAt: number,
    messages: StoredMessageForDelivery[],
    scratchlist: HapiSessionExport['scratchlist']
): number {
    const prefix = JSON.stringify({
        schemaVersion: HAPI_SESSION_EXPORT_SCHEMA_VERSION,
        exportedAt,
        session
    })
    const suffix = JSON.stringify({ scratchlist })
    if (prefix === undefined || suffix === undefined) {
        return Number.MAX_SAFE_INTEGER
    }

    const messageBytes = messages.reduce(
        (total, message, index) => total + jsonByteLength(toDecryptedMessage(message)) + (index > 0 ? 1 : 0),
        0
    )
    return Buffer.byteLength(prefix.slice(0, -1), 'utf8')
        + Buffer.byteLength(',"messages":[', 'utf8')
        + messageBytes
        + Buffer.byteLength(`],${suffix.slice(1)}`, 'utf8')
}

function isQueuedUserMessage(message: StoredMessageForDelivery): boolean {
    const record = unwrapRoleWrappedRecordEnvelope(message.content)
    return record?.role === 'user' && message.invokedAt === null
}

function isExportVisibleStoredMessage(message: StoredMessageForDelivery): boolean {
    if (!isWebVisibleStoredMessage(message) || isQueuedUserMessage(message)) {
        return false
    }

    const record = unwrapRoleWrappedRecordEnvelope(message.content)
    if (record?.role !== 'agent') {
        return true
    }

    if (!isObject(record.content) || record.content.type !== 'output') {
        return true
    }

    const data = isObject(record.content.data) ? record.content.data : null
    if (!data) {
        return true
    }

    if (Boolean(data.isMeta) || Boolean(data.isCompactSummary)) {
        return false
    }

    return isClaudeChatVisibleMessage({ type: data.type, subtype: data.subtype })
}

function getNormalizedDeliveryMode(
    metadata: unknown,
    requestedDeliveryMode: MessageDeliveryMode | undefined,
    scheduledAt: number | null | undefined
): MessageDeliveryMode {
    if (requestedDeliveryMode !== 'steer' || scheduledAt != null) {
        return 'queue'
    }

    return isObject(metadata) && metadata.flavor === 'pi' ? 'steer' : 'queue'
}

/**
 * Native steer is scoped to the Pi turn active at the initial live emit. Once
 * a durable row is delivered through reconnect, backfill, a clear gate, or a
 * scheduled scan, that turn identity is no longer provable. Preserve stored
 * provenance for Web diagnostics, but make deferred CLI delivery an ordinary
 * queue item so it cannot steer a later generation.
 */
export type RetryIndeterminateMessageResult =
    | { status: 'retried'; localId: string }
    | { status: 'already-queued'; localId: string | null }
    | { status: 'retry-unavailable'; localId: string }
    | { status: 'invoked'; message: DecryptedMessage }
    | { status: 'not-found' }

function contentForDeferredDelivery(content: unknown): unknown {
    if (!isObject(content) || content.role !== 'user' || !isObject(content.meta)) {
        return content
    }
    if (content.meta.deliveryMode !== 'steer') return content
    return {
        ...content,
        meta: {
            ...content.meta,
            deliveryMode: 'queue' as const
        }
    }
}

function getUserMessageAttachments(content: unknown): AttachmentMetadata[] {
    if (!isObject(content) || content.role !== 'user' || !isObject(content.content)) {
        return []
    }
    return Array.isArray(content.content.attachments)
        ? content.content.attachments as AttachmentMetadata[]
        : []
}

function replaceUserMessageAttachments(content: unknown, attachments: AttachmentMetadata[]): unknown {
    if (!isObject(content) || !isObject(content.content)) return content
    return {
        ...content,
        content: {
            ...content.content,
            attachments,
        }
    }
}

type MessageServiceOptions = {
    validateScheduledAttachments?: (
        sessionId: string,
        attachments: AttachmentMetadata[],
    ) => Promise<void>
    materializeScheduledAttachments?: (
        sessionId: string,
        attachments: AttachmentMetadata[],
    ) => Promise<AttachmentMetadata[]>
    deleteScheduledAttachments?: (
        sessionId: string,
        attachments: AttachmentMetadata[],
    ) => Promise<void>
    deleteMaterializedScheduledAttachments?: (
        sessionId: string,
        attachments: AttachmentMetadata[],
    ) => Promise<void>
    withScheduledAttachmentLock?: <T>(
        sessionId: string,
        fn: () => Promise<T>,
    ) => Promise<T>
    withScheduledAttachmentLocks?: <T>(
        sessionIds: readonly string[],
        fn: () => Promise<T>,
    ) => Promise<T>
    rehomeScheduledMessageAttachments?: (
        sourceSessionId: string,
        targetSessionId: string,
        message: StoredMessageForDelivery,
    ) => Promise<StoredMessageForDelivery>
}

export class MessageService {
    /** One scheduled-matured SSE per localId per hub process (cleared on cancel/consume paths here). */
    private readonly scheduledMatureNotifiedLocalIds = new Set<string>()
    /** CLI upload paths are session-scoped; reuse them until the CLI session ends. */
    private readonly scheduledAttachmentDeliveryCache = new Map<string, AttachmentMetadata[]>()
    /** Materialized uploads invalidated during reconnect, awaiting a live RPC target for cleanup. */
    private readonly pendingScheduledAttachmentDeliveryCleanup = new Map<string, AttachmentMetadata[]>()
    /** In-flight materialization results from a previous CLI connection are stale after reconnect. */
    private readonly scheduledAttachmentDeliveryGenerations = new Map<string, number>()
    /** A deferred materialization has not emitted its row to the CLI yet. */
    private readonly materializingScheduledMessageKeys = new Set<string>()
    /** Keep mature delivery FIFO per session without blocking unrelated sessions. */
    private readonly matureReleaseInFlightSessions = new Set<string>()

    private withScheduledAttachmentLocks<T>(sessionIds: readonly string[], fn: () => Promise<T>): Promise<T> {
        if (this.options.withScheduledAttachmentLocks) {
            return this.options.withScheduledAttachmentLocks(sessionIds, fn)
        }
        if (sessionIds.length === 1 && this.options.withScheduledAttachmentLock) {
            return this.options.withScheduledAttachmentLock(sessionIds[0]!, fn)
        }
        return fn()
    }

    private withScheduledAttachmentLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
        return this.withScheduledAttachmentLocks([sessionId], fn)
    }

    private resolveScheduledAttachmentLockSessionIds(sessionId: string): string[] {
        const source = this.store.sessions.getSession(sessionId)
        if (!source) throw new Error('Message source session not found')

        const metadata = isObject(source.metadata) ? source.metadata : null
        const supersededBySessionId = metadata && typeof metadata.supersededBySessionId === 'string'
            ? metadata.supersededBySessionId
            : undefined
        const clearOperation = metadata && isObject(metadata.opencodeClearOperation)
            ? metadata.opencodeClearOperation
            : null
        const replacementSessionId = clearOperation && typeof clearOperation.replacementSessionId === 'string'
            ? clearOperation.replacementSessionId
            : undefined
        const targetSessionId = supersededBySessionId
            ?? (clearOperation?.state !== 'aborted' ? replacementSessionId : undefined)
            ?? sessionId

        if (targetSessionId !== sessionId
            && !this.store.sessions.getSessionByNamespace(targetSessionId, source.namespace)) {
            throw new Error('OpenCode clear redirect target is unavailable in the source namespace')
        }
        return targetSessionId === sessionId ? [sessionId] : [sessionId, targetSessionId]
    }
    private readonly activeIndeterminateRetries = new Set<string>()

    constructor(
        private readonly store: Store,
        private readonly io: Server,
        private readonly publisher: EventPublisher,
        private readonly onSessionActivity?: (sessionId: string, updatedAt: number) => void,
        private readonly options: MessageServiceOptions = {},
    ) {
    }

    clearScheduledAttachmentDeliveryCache(sessionId: string): void {
        this.scheduledAttachmentDeliveryGenerations.set(
            sessionId,
            (this.scheduledAttachmentDeliveryGenerations.get(sessionId) ?? 0) + 1,
        )
        const staleAttachments: AttachmentMetadata[] = []
        for (const [cacheKey, attachments] of this.scheduledAttachmentDeliveryCache) {
            if (cacheKey.startsWith(`${sessionId}:`)) {
                this.scheduledAttachmentDeliveryCache.delete(cacheKey)
                staleAttachments.push(...attachments)
            }
        }
        if (staleAttachments.length > 0) {
            const unique = new Map(
                (this.pendingScheduledAttachmentDeliveryCleanup.get(sessionId) ?? [])
                    .concat(staleAttachments)
                    .map((attachment) => [attachment.path, attachment])
            )
            this.pendingScheduledAttachmentDeliveryCleanup.set(sessionId, [...unique.values()])
        }
    }

    async flushScheduledAttachmentDeliveryCleanup(sessionId: string): Promise<void> {
        const attachments = this.pendingScheduledAttachmentDeliveryCleanup.get(sessionId)
        if (!attachments) return
        this.pendingScheduledAttachmentDeliveryCleanup.delete(sessionId)
        await this.cleanupMaterializedScheduledAttachments(sessionId, attachments)
    }

    private async cleanupMaterializedScheduledAttachments(
        sessionId: string,
        attachments: AttachmentMetadata[],
    ): Promise<void> {
        if (!this.options.deleteMaterializedScheduledAttachments || attachments.length === 0) return
        try {
            await this.options.deleteMaterializedScheduledAttachments(sessionId, attachments)
        } catch (error) {
            console.error('[Scratchlist] failed to clean cancelled scheduled uploads', error)
        }
    }

    private async releaseScheduledAttachments(
        sessionId: string,
        messages: StoredMessageForDelivery[],
    ): Promise<void> {
        const deleteScheduledAttachments = this.options.deleteScheduledAttachments
        if (!deleteScheduledAttachments || messages.length === 0) return
        for (const message of messages) {
            this.scheduledAttachmentDeliveryCache.delete(`${sessionId}:${message.id}`)
        }
        const attachments = messages
            .filter((message) => message.scheduledAt !== null)
            .flatMap((message) => getUserMessageAttachments(message.content))
            .filter((attachment) => isHubScratchlistAttachmentPath(attachment.path))
        await this.withScheduledAttachmentLock(sessionId, async () => {
            // Re-read scratchlist references while holding the same lock as
            // scheduled acceptance and explicit draft deletion. A snapshot
            // taken before the lock could delete a blob for a newly accepted
            // scheduled row.
            const unique = new Map(attachments.map((attachment) => [attachment.path, attachment]))
            const scratchlistPaths = new Set(
                this.store.scratchlist
                    .list(sessionId)
                    .flatMap((entry) => entry.attachments.map((attachment) => attachment.path))
            )
            const deletable = [...unique.values()].filter(
                (attachment) => !this.store.messages.hasUninvokedAttachmentReference(sessionId, attachment.path)
                    && !scratchlistPaths.has(attachment.path)
            )
            if (deletable.length === 0) return
            await deleteScheduledAttachments(sessionId, deletable)
        })
    }

    async releaseConsumedScheduledAttachments(sessionId: string, localIds: string[]): Promise<void> {
        if (localIds.length === 0) return
        const messages = this.store.messages.getMessagesByLocalIds(sessionId, localIds)
        await this.releaseScheduledAttachments(sessionId, messages)
    }

    async reconcileConsumedScheduledAttachments(sessionId: string): Promise<void> {
        const messages = this.store.messages.getConsumedScheduledMessages(sessionId)
        await this.releaseScheduledAttachments(sessionId, messages)
    }

    private async releaseCancelledScheduledAttachment(
        sessionId: string,
        message: StoredMessageForDelivery,
    ): Promise<void> {
        if (message.scheduledAt === null) return
        const cacheKey = `${sessionId}:${message.id}`
        const staged = this.scheduledAttachmentDeliveryCache.get(cacheKey)
        try {
            await this.releaseScheduledAttachments(sessionId, [message])
        } finally {
            this.scheduledAttachmentDeliveryCache.delete(cacheKey)
            if (staged) await this.cleanupMaterializedScheduledAttachments(sessionId, staged)
        }
    }

    private async releaseInvokedScheduledAttachment(
        sessionId: string,
        message: StoredMessageForDelivery,
    ): Promise<void> {
        // A not-found/timeout cancel acknowledgement is ambiguous: the CLI
        // may already have dequeued the row and started consuming the staged
        // upload. Release only the durable Hub source; the CLI owns the staged
        // path until its session lifecycle cleans it up.
        await this.releaseScheduledAttachments(sessionId, [message])
    }

    private forgetScheduledMatureNotified(localIds: Iterable<string>): void {
        for (const localId of localIds) {
            this.scheduledMatureNotifiedLocalIds.delete(localId)
        }
    }

    private recordConsumedAcknowledgement(
        sessionId: string,
        localId: string,
    ): CancelQueuedMessageResult {
        const invokedAt = Date.now()
        this.store.messages.markMessagesInvoked(sessionId, [localId], invokedAt)
        this.publisher.emit({ type: 'messages-consumed', sessionId, localIds: [localId], invokedAt })
        const settled = this.store.messages.lookupQueuedMessage(sessionId, localId)
        return settled.status === 'invoked'
            ? settled
            : { status: 'cancelled', localId }
    }

    getMessages(sessionId: string, limit: number = 200): DecryptedMessage[] {
        const stored = this.store.messages.getMessages(sessionId, limit)
        return toVisibleDecryptedMessages(stored)
    }

    getQueuedState(sessionId: string, localIds: string[]): QueuedStateResponse {
        const states = this.store.messages.getLocalMessageStates(sessionId, localIds)
        return {
            queuedLocalIds: states
                .filter((state) => state.invokedAt === null && state.deliveryState !== 'indeterminate' && state.deliveryState !== 'dispatching')
                .map((state) => state.localId),
            indeterminateLocalIds: states
                .filter((state) => state.invokedAt === null && (state.deliveryState === 'indeterminate' || state.deliveryState === 'dispatching'))
                .map((state) => state.localId),
            invokedLocalMessages: states.flatMap((state) => state.invokedAt === null
                ? []
                : [{ localId: state.localId, invokedAt: state.invokedAt }])
        }
    }

    getSessionExport(
        sessionId: string,
        session: Session,
        options: { force?: boolean } = {}
    ): HapiSessionExportResult {
        const storedMessages = this.store.messages.getAllMessages(sessionId)
            .filter(isExportVisibleStoredMessage)
            .sort((a, b) => {
                const aAt = a.invokedAt ?? a.createdAt
                const bAt = b.invokedAt ?? b.createdAt
                return aAt !== bAt ? aAt - bAt : a.seq - b.seq
            })

        // Chronological ASC for archive readability (store list is DESC).
        const scratchlist = this.store.scratchlist.list(sessionId)
            .slice()
            .sort((a, b) => {
                if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
                return a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0
            })
            .map((row) => ({
                entryId: row.entryId,
                text: row.text,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
                position: row.position,
                attachments: row.attachments
            }))

        const exportedAt = Date.now()
        const estimatedBytes = estimateSessionExportBytes(session, exportedAt, storedMessages, scratchlist)
        if (estimatedBytes > SESSION_EXPORT_MAX_BYTES) {
            return {
                type: 'too-large',
                count: storedMessages.length,
                estimatedBytes,
                maxBytes: SESSION_EXPORT_MAX_BYTES
            }
        }

        if (!options.force && storedMessages.length > SESSION_EXPORT_MESSAGE_LIMIT) {
            return {
                type: 'warning',
                count: storedMessages.length,
                limit: SESSION_EXPORT_MESSAGE_LIMIT,
                estimatedBytes
            }
        }

        return {
            type: 'success',
            payload: {
                schemaVersion: HAPI_SESSION_EXPORT_SCHEMA_VERSION,
                exportedAt,
                session,
                messages: storedMessages.map(toDecryptedMessage),
                scratchlist
            }
        }
    }

    getMessagesPage(
        sessionId: string,
        options: {
            limit: number
            before?: MessagePosition | null
            after?: MessagePosition | null
            until?: MessagePosition | null
            epoch?: number | null
        }
    ): MessagesResponse {
        const epoch = this.store.messages.getMessageEpoch(sessionId)
        if (options.after) {
            if (options.epoch !== undefined && options.epoch !== null && options.epoch !== epoch) {
                return this.getLatestOrBeforeMessagesPage(sessionId, options.limit, null, epoch, true)
            }
            return this.getAfterMessagesPage(
                sessionId,
                options.limit,
                options.after,
                options.until ?? null,
                epoch
            )
        }
        return this.getLatestOrBeforeMessagesPage(
            sessionId,
            options.limit,
            options.before ?? null,
            epoch,
            false
        )
    }

    private getLatestOrBeforeMessagesPage(
        sessionId: string,
        limit: number,
        requestedBefore: MessagePosition | null,
        epoch: number,
        reset: boolean
    ): MessagesResponse {
        const direction = requestedBefore ? 'before' as const : 'latest' as const
        const snapshotHead = this.store.messages.getNewestMessagePosition(sessionId)
        let before = requestedBefore ?? undefined
        let pageRows = this.store.messages.getMessagesByPosition(sessionId, limit, requestedBefore ?? undefined)

        // Latest-page request (no cursor): also include uninvoked local user messages
        // out-of-band, so refresh / secondary clients can still see queued rows even
        // when their position key (createdAt) places them outside the latest page.
        // The cursor stays anchored to pageRows so out-of-band rows don't affect
        // pagination of older pages.
        let queuedRows = requestedBefore === null
            ? this.store.messages.getUninvokedLocalMessages(sessionId)
            : []

        let byId = new Map<string, typeof pageRows[number]>()
        for (const row of pageRows) byId.set(row.id, row)
        for (const row of queuedRows) byId.set(row.id, row)

        let stored = [...byId.values()].sort((a, b) => {
            const at = (a.invokedAt ?? a.createdAt) - (b.invokedAt ?? b.createdAt)
            return at !== 0 ? at : a.seq - b.seq
        })

        let messages = toVisibleDecryptedMessages(stored)

        // The cursor is the oldest row in the actual position-ordered page (pageRows[0]).
        // Out-of-band queued rows are not part of the cursor — they are pinned to
        // every latest-page response.
        let oldest = pageRows[0] ?? null
        let oldestSeq: number | null = oldest?.seq ?? null
        let oldestPositionAt: number | null = oldest
            ? oldest.invokedAt ?? oldest.createdAt
            : null

        let hasMore = oldestSeq !== null && oldestPositionAt !== null
            && this.store.messages.getMessagesByPosition(
                sessionId,
                1,
                { at: oldestPositionAt, seq: oldestSeq }
            ).length > 0

        while (messages.length === 0 && hasMore && oldestSeq !== null && oldestPositionAt !== null) {
            before = { at: oldestPositionAt, seq: oldestSeq }
            pageRows = this.store.messages.getMessagesByPosition(sessionId, limit, before)
            queuedRows = []

            byId = new Map<string, typeof pageRows[number]>()
            for (const row of pageRows) byId.set(row.id, row)
            for (const row of queuedRows) byId.set(row.id, row)

            stored = [...byId.values()].sort((a, b) => {
                const at = (a.invokedAt ?? a.createdAt) - (b.invokedAt ?? b.createdAt)
                return at !== 0 ? at : a.seq - b.seq
            })
            messages = toVisibleDecryptedMessages(stored)

            oldest = pageRows[0] ?? null
            oldestSeq = oldest?.seq ?? null
            oldestPositionAt = oldest
                ? oldest.invokedAt ?? oldest.createdAt
                : null
            hasMore = oldestSeq !== null && oldestPositionAt !== null
                && this.store.messages.getMessagesByPosition(
                    sessionId,
                    1,
                    { at: oldestPositionAt, seq: oldestSeq }
                ).length > 0
        }

        return {
            messages,
            page: {
                direction,
                limit,
                epoch,
                reset,
                nextBeforeSeq: oldestSeq,
                nextBeforeAt: oldestPositionAt,
                nextAfterSeq: null,
                nextAfterAt: null,
                snapshotHeadSeq: snapshotHead?.seq ?? null,
                snapshotHeadAt: snapshotHead?.at ?? null,
                hasMore
            }
        }
    }

    private getAfterMessagesPage(
        sessionId: string,
        limit: number,
        after: MessagePosition,
        requestedUntil: MessagePosition | null,
        epoch: number
    ): MessagesResponse {
        const currentHead = this.store.messages.getNewestMessagePosition(sessionId)
        const snapshotHead = currentHead && requestedUntil
            ? (comparePosition(requestedUntil, currentHead) <= 0 ? requestedUntil : currentHead)
            : requestedUntil ?? currentHead

        if (!snapshotHead || comparePosition(snapshotHead, after) <= 0) {
            return {
                messages: [],
                page: {
                    direction: 'after',
                    limit,
                    epoch,
                    reset: false,
                    nextBeforeSeq: null,
                    nextBeforeAt: null,
                    nextAfterSeq: after.seq,
                    nextAfterAt: after.at,
                    snapshotHeadSeq: snapshotHead?.seq ?? null,
                    snapshotHeadAt: snapshotHead?.at ?? null,
                    hasMore: false
                }
            }
        }

        const pageRows = this.store.messages.getMessagesAfterPosition(
            sessionId,
            limit,
            after,
            snapshotHead
        )
        const last = pageRows[pageRows.length - 1] ?? null
        const nextAfter = last ? messagePosition(last) : snapshotHead
        const hasMore = last !== null && comparePosition(nextAfter, snapshotHead) < 0

        return {
            messages: toVisibleDecryptedMessages(pageRows),
            page: {
                direction: 'after',
                limit,
                epoch,
                reset: false,
                nextBeforeSeq: null,
                nextBeforeAt: null,
                nextAfterSeq: nextAfter.seq,
                nextAfterAt: nextAfter.at,
                snapshotHeadSeq: snapshotHead.seq,
                snapshotHeadAt: snapshotHead.at,
                hasMore
            }
        }
    }

    /** CLI reconnect backfill — excludes every scheduled row so the mature scan
     *  remains the sole scheduled delivery path. */
    getDeliverableMessagesAfter(sessionId: string, options: { afterSeq: number; limit: number; now: number }): DecryptedMessage[] {
        const stored = this.store.messages.getDeliverableMessagesAfter(
            sessionId,
            options.afterSeq,
            options.now,
            options.limit
        )
        return stored.map((message) => ({
            id: message.id,
            seq: message.seq,
            localId: message.localId,
            content: contentForDeferredDelivery(message.content),
            createdAt: message.createdAt,
            invokedAt: message.invokedAt,
            scheduledAt: message.scheduledAt,
            ...(message.deliveryState ? { deliveryState: message.deliveryState } : {})
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

        // Phase 2: row is still queued. Ask the CLI whether it already shifted the item
        // (race window between collectBatch() shift and messages-consumed ack).
        const { localId, resolvedId, scheduledAt } = lookup
        const message = this.store.messages.getMessageById(sessionId, resolvedId)
        if (!message) throw new Error('Queued message disappeared after lookup')
        const isDispatching = lookup.status === 'dispatching'
        const isIndeterminate = lookup.status === 'indeterminate'

        if (!localId) {
            // No localId — row exists but has no cancel path; treat as cancelled.
            const deleted = this.store.messages.deleteQueuedMessageById(sessionId, resolvedId)
            if (deleted) await this.releaseCancelledScheduledAttachment(sessionId, message)
            this.publisher.emit({ type: 'message-cancelled', sessionId, messageId })
            return { status: 'cancelled', localId: null }
        }

        // A live dispatch is not cancellable by timeout. Convert it to the
        // durable unknown state and require a second explicit resolution.
        if (isDispatching) {
            const ackResult = await this.requestCliCancelAck(sessionId, localId, messageId, 500)
            if (ackResult === 'consumed') {
                return this.recordConsumedAcknowledgement(sessionId, localId)
            }
            // The native request may have reached the agent while the cancel
            // round-trip was pending. Never delete a live dispatch; hold it as
            // unknown and let the user explicitly retry or discard afterwards.
            const changed = this.store.messages.setMessagesDeliveryState(sessionId, [localId], 'indeterminate')
            if (changed === 0) {
                const settled = this.store.messages.lookupQueuedMessage(sessionId, resolvedId)
                if (settled.status === 'invoked') return settled
                if (settled.status === 'absent') return { status: 'cancelled', localId }
            } else {
                this.publisher.emit({ type: 'messages-indeterminate', sessionId, localIds: [localId] })
            }
            return { status: 'busy', localId }
        }

        // An indeterminate steer is never converted to invoked by a cancel
        // timeout. Explicit cancel resolves it by discarding the durable row;
        // an online CLI still gets a chance to remove its held reservation.
        if (isIndeterminate) {
            const roomName = `session:${sessionId}`
            const cliCount = this.io.of('/cli').adapter.rooms.get(roomName)?.size ?? 0
            const ackResult = cliCount > 0
                ? await this.requestCliCancelAck(sessionId, localId, messageId, 500)
                : 'timeout' as const
            if (ackResult === 'consumed') {
                return this.recordConsumedAcknowledgement(sessionId, localId)
            }
            if (ackResult === 'in-flight' || ackResult === 'indeterminate' || (ackResult === 'timeout' && cliCount > 0)) {
                return { status: 'busy', localId }
            }
            this.store.messages.deleteQueuedMessageById(sessionId, resolvedId)
            const recheck = this.store.messages.lookupQueuedMessage(sessionId, resolvedId)
            if (recheck.status === 'invoked') {
                // The steer won the race while the cancel ACK was in flight;
                // never broadcast cancellation over a delivered row.
                return recheck
            }
            if (recheck.status !== 'absent') {
                return { status: 'busy', localId }
            }
            this.publisher.emit({ type: 'message-cancelled', sessionId, messageId, localId })
            return { status: 'cancelled', localId }
        }

        // Phase 2b: future-scheduled messages were never emitted to the CLI, so they
        // are not in the CLI's in-memory queue.  Asking the CLI whether it can remove
        // the item would always return 'not-found', which the normal ack path
        // misinterprets as "CLI already consumed it" and stamps invoked_at.
        // Short-circuit: delete the row directly without a CLI ack round-trip.
        //
        // Single event loop turn: the scheduledAt > now check and the
        // deleteQueuedMessageById call execute atomically with no await between
        // them, so the offline-CLI path's re-check pattern is unnecessary here.
        // The offline path needs the re-check because it awaits the
        // markInvoked between the lookup and the delete.
        const now = Date.now()
        if (scheduledAt !== null && scheduledAt > now) {
            const deleted = this.store.messages.deleteQueuedMessageById(sessionId, resolvedId)
            if (deleted) await this.releaseCancelledScheduledAttachment(sessionId, message)
            this.forgetScheduledMatureNotified([localId])
            this.publisher.emit({
                type: 'message-cancelled',
                sessionId,
                messageId,
                localId,
            })
            return { status: 'cancelled', localId }
        }

        // A mature attachment may currently be waiting for the Hub -> CLI
        // upload RPC. It has not reached the CLI queue yet, so a not-found
        // response from the CLI must not turn the row into an invoked message.
        // Delete it directly and let the materializer's post-await state check
        // suppress its stale snapshot when the RPC eventually resolves.
        const materializingKey = `${sessionId}:${resolvedId}`
        if (this.materializingScheduledMessageKeys.has(materializingKey)) {
            const deleted = this.store.messages.deleteQueuedMessageById(sessionId, resolvedId)
            if (deleted) {
                await this.releaseCancelledScheduledAttachment(sessionId, message)
                this.forgetScheduledMatureNotified([localId])
                this.publisher.emit({
                    type: 'message-cancelled',
                    sessionId,
                    messageId,
                    localId,
                })
                return { status: 'cancelled', localId }
            }
            const recheck = this.store.messages.lookupQueuedMessage(sessionId, resolvedId)
            if (recheck.status === 'invoked') {
                await this.releaseInvokedScheduledAttachment(sessionId, message)
                return recheck
            }
            if (recheck.status === 'absent') return { status: 'cancelled', localId }
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
                await this.releaseInvokedScheduledAttachment(sessionId, message)
                this.forgetScheduledMatureNotified([localId])
                this.publisher.emit({
                    type: 'messages-consumed',
                    sessionId,
                    localIds: [localId],
                    invokedAt: recheck.message.invokedAt!,
                })
                return recheck
            }
            // Row is gone (absent) — clean cancel.
            await this.releaseCancelledScheduledAttachment(sessionId, message)
            this.forgetScheduledMatureNotified([localId])
            this.publisher.emit({
                type: 'message-cancelled',
                sessionId,
                messageId,
                localId,
            })
            return { status: 'cancelled', localId }
        }

        const ackResult = await this.requestCliCancelAck(sessionId, localId, messageId, 500)

        if (ackResult === 'consumed') {
            return this.recordConsumedAcknowledgement(sessionId, localId)
        }
        if (ackResult === 'in-flight') {
            // The row is inside an async steer (mid-turn delivery): it can
            // neither be removed nor stamped invoked — the steer's eventual
            // accept/reject decides. Report busy so the caller keeps the row.
            return { status: 'busy', localId }
        }

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
            // The messages-consumed event below is local to this Hub process and
            // does not pass through SyncEngine's normal consumed-message cleanup.
            // Release only the now-unreferenced Hub attachment. The CLI may
            // already be consuming the staged upload after an ambiguous ack.
            await this.releaseInvokedScheduledAttachment(sessionId, message)
            this.forgetScheduledMatureNotified([localId])
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
        const deleted = this.store.messages.deleteQueuedMessageById(sessionId, resolvedId)
        if (deleted) await this.releaseCancelledScheduledAttachment(sessionId, message)
        this.forgetScheduledMatureNotified([localId])
        this.publisher.emit({
            type: 'message-cancelled',
            sessionId,
            messageId
        })

        return { status: 'cancelled', localId }
    }

    async retryIndeterminateMessage(
        sessionId: string,
        messageId: string
    ): Promise<RetryIndeterminateMessageResult> {
        const lookup = this.store.messages.lookupQueuedMessage(sessionId, messageId)
        if (lookup.status === 'absent') return { status: 'not-found' }
        if (lookup.status === 'invoked') {
            return {
                status: 'invoked',
                message: toDecryptedMessage(lookup.message)
            }
        }
        if (lookup.status === 'queued') {
            return { status: 'already-queued', localId: lookup.localId }
        }
        if (!lookup.localId) return { status: 'not-found' }
        const retryKey = `${sessionId}:${lookup.localId}`
        if (this.activeIndeterminateRetries.has(retryKey)) {
            return { status: 'retry-unavailable', localId: lookup.localId }
        }
        this.activeIndeterminateRetries.add(retryKey)

        try {
        const roomName = `session:${sessionId}`
        const cliCount = this.io.of('/cli').adapter.rooms.get(roomName)?.size ?? 0
        if (this.store.isOpenCodeClearDeliveryGated(sessionId) || cliCount !== 1) {
            return { status: 'retry-unavailable', localId: lookup.localId }
        }

        const cancelResult = await this.requestCliCancelAck(sessionId, lookup.localId, messageId, 500)
        if (cancelResult === 'consumed') {
            const settled = this.recordConsumedAcknowledgement(sessionId, lookup.localId)
            return settled.status === 'invoked'
                ? { status: 'invoked', message: toDecryptedMessage(settled.message) }
                : { status: 'not-found' }
        }
        if (cancelResult === 'in-flight' || cancelResult === 'timeout') {
            return { status: 'retry-unavailable', localId: lookup.localId }
        }
        const refreshed = this.store.messages.lookupQueuedMessage(sessionId, messageId)
        if (refreshed.status === 'invoked') {
            return { status: 'invoked', message: toDecryptedMessage(refreshed.message) }
        }
        if (refreshed.status === 'absent') return { status: 'not-found' }
        if (refreshed.status === 'dispatching') {
            const changed = this.store.messages.setMessagesDeliveryState(sessionId, [lookup.localId], 'indeterminate')
            if (changed === 0) return { status: 'retry-unavailable', localId: lookup.localId }
        }

        const message = this.store.messages.claimIndeterminateMessage(sessionId, messageId)
        if (!message || !message.localId) return { status: 'not-found' }

        const update = {
            id: message.id,
            seq: message.seq,
            createdAt: message.createdAt,
            body: {
                t: 'retry-queued-message' as const,
                sid: sessionId,
                messageId: message.id,
                localId: message.localId,
                message: {
                    id: message.id,
                    seq: message.seq,
                    createdAt: message.createdAt,
                    localId: message.localId,
                    content: contentForDeferredDelivery(message.content)
                }
            }
        }
        const room = this.io.of('/cli').to(roomName)
        const accepted = await new Promise<boolean>((resolve) => {
            room.timeout(500).emit(
                'update',
                update,
                (_err: Error | null, responses: Array<{ accepted?: boolean }>) => {
                    resolve(responses?.some((response) => response.accepted === true) ?? false)
                }
            )
        })
        if (!accepted) {
            this.store.messages.setMessagesDeliveryState(sessionId, [message.localId], 'indeterminate')
            this.publisher.emit({ type: 'messages-indeterminate', sessionId, localIds: [message.localId] })
            return { status: 'retry-unavailable', localId: message.localId }
        }
        const requeued = this.store.messages.setMessagesDeliveryState(sessionId, [message.localId], 'queued')
        if (requeued === 0) {
            const settled = this.store.messages.lookupQueuedMessage(sessionId, message.id)
            if (settled.status === 'invoked') return { status: 'invoked', message: toDecryptedMessage(settled.message) }
            return { status: 'retry-unavailable', localId: message.localId }
        }
        this.publisher.emit({ type: 'messages-requeued', sessionId, localIds: [message.localId] })
        return { status: 'retried', localId: message.localId }
        } finally {
            this.activeIndeterminateRetries.delete(retryKey)
        }
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
    ): Promise<'removed' | 'in-flight' | 'indeterminate' | 'consumed' | 'not-found' | 'timeout'> {
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
                (err: Error | null, responses: Array<{ removed: boolean; inFlight?: boolean; indeterminate?: boolean; consumed?: boolean }>) => {
                    // Check responses before err: in a reconnect overlap or any room with
                    // multiple CLI sockets, Socket.IO may set err (one socket timed out)
                    // while still delivering successful responses from the sockets that did
                    // ack. An explicit in-flight report dominates: one socket may be
                    // dispatching the steer while a stale duplicate socket reports
                    // removed — deleting the row then would orphan the executing message.
                    if (responses?.some((r) => r.consumed === true)) {
                        resolve('consumed')
                        return
                    }
                    if (responses?.some((r) => r.indeterminate === true)) {
                        resolve('indeterminate')
                        return
                    }
                    if (responses?.some((r) => r.inFlight === true)) {
                        resolve('in-flight')
                        return
                    }
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
            scheduledAt?: number | null
            deliveryMode?: MessageDeliveryMode
        }
    ): Promise<{ actualSessionId: string; createdAt: number }> {
        // Normal CLI upload paths are deleted when a session ends, so a future
        // scheduled message can only safely carry durable hub scratchlist
        // paths.  Those files are copied to the CLI upload directory at
        // maturity, immediately before the message is emitted.
        const attachments = payload.attachments ?? []
        if (
            payload.scheduledAt != null
            && attachments.length > 0
            && !attachments.every((attachment) => isHubScratchlistAttachmentPath(attachment.path))
        ) {
            throw new Error('sendMessage: scheduled messages with attachments must use scratchlist attachments')
        }
        const sentFrom = payload.sentFrom ?? 'webapp'
        const deliveryMode = getNormalizedDeliveryMode(
            this.store.sessions.getSession(sessionId)?.metadata,
            payload.deliveryMode,
            payload.scheduledAt
        )

        const content = {
            role: 'user',
            content: {
                type: 'text',
                text: payload.text,
                attachments: payload.attachments
            },
            meta: {
                sentFrom,
                deliveryMode
            }
        }

        const insertMessage = async () => {
            const duplicate = payload.localId
                ? this.store.getMessageForCurrentSession(sessionId, payload.localId)
                : null
            if (!duplicate && payload.scheduledAt != null && attachments.length > 0) {
                await this.options.validateScheduledAttachments?.(sessionId, attachments)
            }
            const inserted = this.store.addMessageForCurrentSession(
                sessionId,
                content,
                payload.localId ?? undefined,
                payload.scheduledAt ?? null
            )
            const actualSessionId = inserted.sessionId
            let msg = inserted.message
            if (
                actualSessionId !== sessionId
                && msg.scheduledAt !== null
                && getUserMessageAttachments(msg.content).length > 0
            ) {
                msg = await this.options.rehomeScheduledMessageAttachments?.(
                    sessionId,
                    actualSessionId,
                    msg,
                ) ?? msg
            }
            return { inserted, msg }
        }
        const insertedWithMessage = payload.scheduledAt != null && attachments.length > 0
            ? await this.withScheduledAttachmentLocks(
                this.resolveScheduledAttachmentLockSessionIds(sessionId),
                insertMessage,
            )
            : await insertMessage()
        const inserted = insertedWithMessage.inserted
        const actualSessionId = inserted.sessionId
        const msg = insertedWithMessage.msg
        // A duplicate localId is an idempotent retry, not proof that the
        // original Pi turn still exists. Its stored row may retain steer
        // provenance from a POST whose response was lost, so deliver the
        // duplicate through the same turn-safe deferred view as reconnect.
        const cliContent = inserted.inserted
            ? msg.content
            : contentForDeferredDelivery(msg.content)
        const shouldEmitToCli = msg.deliveryState !== 'indeterminate'
        this.onSessionActivity?.(actualSessionId, msg.createdAt)

        // Only emit to CLI if the message is not scheduled for the future.
        // Mature or non-scheduled messages go through immediately; future scheduled
        // messages wait for the 5-second tick in releaseMatureScheduledMessages.
        // Re-measure Date.now() after addMessage to avoid a TOCTOU window where
        // the pre-insert `now` capture could misclassify a borderline scheduledAt
        // as future when it has already become past by the time we check.
        const isFutureScheduled = msg.scheduledAt !== null && msg.scheduledAt > Date.now()
        const hasScheduledAttachments = msg.scheduledAt !== null
            && getUserMessageAttachments(msg.content).length > 0
        if (
            shouldEmitToCli
            && !isFutureScheduled
            && !hasScheduledAttachments
            && !this.store.isOpenCodeClearDeliveryGated(actualSessionId)
        ) {
            const update = {
                id: msg.id,
                seq: msg.seq,
                createdAt: msg.createdAt,
                body: {
                    t: 'new-message' as const,
                    sid: actualSessionId,
                    message: {
                        id: msg.id,
                        seq: msg.seq,
                        createdAt: msg.createdAt,
                        localId: msg.localId,
                        content: cliContent
                    }
                }
            }
            this.io.of('/cli').to(`session:${actualSessionId}`).emit('update', update)
        }

        // Always emit message-received to Web SSE so the floating bar renders.
        this.publisher.emit({
            type: 'message-received',
            sessionId: actualSessionId,
            message: {
                id: msg.id,
                seq: msg.seq,
                localId: msg.localId,
                content: msg.content,
                createdAt: msg.createdAt,
                invokedAt: msg.invokedAt,
                scheduledAt: msg.scheduledAt,
                ...(msg.deliveryState ? { deliveryState: msg.deliveryState } : {})
            }
        })
        return { actualSessionId, createdAt: msg.createdAt }
    }

    /**
     * Force-invoke all immediate-queued messages for a session at session end.
     *
     * Called by sessionHandlers when the CLI sends 'session-end', so that
     * the floating bar is cleared without leaving queued rows pinned forever.
     *
     * **All scheduled rows are intentionally skipped** (mature or future).  The
     * mature-scan path (releaseMatureScheduledMessages) is the sole emit channel
     * for scheduled rows and relies on the CLI ack to write invoked_at; if this
     * sweep stamped a mature scheduled row, a subsequent re-attach would never
     * see the row in the next mature-scan tick and the user's prompt would be
     * silently dropped.  See HAPI Bot R4 finding.
     *
     * Returns the list of localIds that were stamped and the invokedAt timestamp,
     * or null if no messages needed sweeping.
     */
    sweepImmediateQueuedOnSessionEnd(
        sessionId: string,
        invokedAt: number
    ): { localIds: string[]; invokedAt: number } | null {
        const queued = this.store.messages.getImmediateQueuedLocalMessages(sessionId)
        const localIds = queued
            .map((m) => m.localId)
            .filter((id): id is string => typeof id === 'string')
        if (localIds.length === 0) return null
        this.store.messages.markMessagesInvoked(sessionId, localIds, invokedAt)
        this.forgetScheduledMatureNotified(localIds)
        this.publisher.emit({ type: 'messages-consumed', sessionId, localIds, invokedAt })
        return { localIds, invokedAt }
    }

    /** Replay durable immediate prompts whenever their CLI session attaches. */
    replayImmediateQueuedMessages(sessionId: string): number {
        if (this.store.isOpenCodeClearDeliveryGated(sessionId)) return 0
        const queued = this.store.messages.getImmediateQueuedLocalMessages(sessionId)
        for (const msg of queued) {
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
                        content: contentForDeferredDelivery(msg.content)
                    }
                }
            }
            this.io.of('/cli').to(`session:${sessionId}`).emit('update', update)
        }
        return queued.length
    }

    /** Release a completed clear handoff in finalized seq order. */
    async releaseDeliverableQueuedMessages(sessionId: string, now: number = Date.now()): Promise<number> {
        if (this.store.isOpenCodeClearDeliveryGated(sessionId)) return 0
        const queued = this.store.messages.getUninvokedLocalMessages(sessionId, { deliverableOnly: true })
            .filter((msg) => msg.scheduledAt === null || msg.scheduledAt <= now)
        let released = 0
        for (const msg of queued) {
            let deliveryContent: unknown = contentForDeferredDelivery(msg.content)
            const attachments = getUserMessageAttachments(msg.content)
            if (msg.scheduledAt !== null && attachments.length > 0) {
                const materializingKey = `${sessionId}:${msg.id}`
                this.materializingScheduledMessageKeys.add(materializingKey)
                try {
                    try {
                        deliveryContent = await this.getScheduledDeliveryContent(msg)
                    } catch {
                        // Leave the row queued for the mature scan to retry
                        // after the replacement CLI has finished connecting.
                        break
                    }
                    if (deliveryContent === null) break

                    const current = this.store.messages.lookupQueuedMessage(sessionId, msg.id)
                    if (current.status !== 'queued') {
                        const staged = this.scheduledAttachmentDeliveryCache.get(materializingKey)
                        this.scheduledAttachmentDeliveryCache.delete(materializingKey)
                        if (staged) await this.cleanupMaterializedScheduledAttachments(sessionId, staged)
                        continue
                    }
                } finally {
                    this.materializingScheduledMessageKeys.delete(materializingKey)
                }
            }
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
                        content: deliveryContent
                    }
                }
            }
            this.io.of('/cli').to(`session:${sessionId}`).emit('update', update)
            released += 1
        }
        return released
    }

    private hasCliSessionConnection(sessionId: string): boolean {
        const namespace = this.io.of('/cli') as unknown as {
            adapter?: { rooms?: { get?: (room: string) => Set<unknown> | undefined } }
        }
        // Test doubles may not expose a Socket.IO adapter.  Keep the old
        // emit behavior there; real namespaces always have one.
        if (!namespace.adapter?.rooms?.get) return true
        return (namespace.adapter.rooms.get(`session:${sessionId}`)?.size ?? 0) > 0
    }

    private async getScheduledDeliveryContent(msg: StoredMessageForDelivery): Promise<unknown | null> {
        const attachments = getUserMessageAttachments(msg.content)
        if (attachments.length === 0) return contentForDeferredDelivery(msg.content)

        const cacheKey = `${msg.sessionId}:${msg.id}`
        let deliveryAttachments = this.scheduledAttachmentDeliveryCache.get(cacheKey)
        if (!deliveryAttachments) {
            if (!this.options.materializeScheduledAttachments) return null
            const generation = this.scheduledAttachmentDeliveryGenerations.get(msg.sessionId) ?? 0
            const materialized = await this.options.materializeScheduledAttachments(msg.sessionId, attachments)
            if ((this.scheduledAttachmentDeliveryGenerations.get(msg.sessionId) ?? 0) !== generation) {
                await this.cleanupMaterializedScheduledAttachments(msg.sessionId, materialized)
                return null
            }
            deliveryAttachments = materialized
            this.scheduledAttachmentDeliveryCache.set(cacheKey, deliveryAttachments)
        }
        return contentForDeferredDelivery(
            replaceUserMessageAttachments(msg.content, deliveryAttachments)
        )
    }

    /** Called by the hub 5-second tick (syncEngine.expireInactive).
     *
     * Finds all scheduled messages whose scheduled_at <= now and emits them to
     * the CLI via socket.io.  Does NOT call markMessagesInvoked — the CLI ack
     * (messages-consumed) handles that.  This means a message is re-emitted on
     * each tick until the CLI acks it, which is the correct behaviour for hub
     * restart scenarios (pitfall #2 guard).
     *
     * For rows already emitted, a cancel that arrives after the CLI has
     * shift()-ed the row gets 'not-found' from the CLI ack and stamps
     * invoked_at (PR #568 contract preserved).  A row still in attachment
     * materialization has not reached the CLI queue and is deleted directly.
     * See messageService.test.ts "cancel × mature race" for the documented
     * expected behaviour. */
    async releaseMatureScheduledMessages(now: number, skipSessionIds?: ReadonlySet<string>): Promise<void> {
        const mature = this.store.messages.getMatureScheduledMessages(now)
        const bySession = new Map<string, StoredMessageForDelivery[]>()
        for (const message of mature) {
            const messages = bySession.get(message.sessionId) ?? []
            messages.push(message)
            bySession.set(message.sessionId, messages)
        }

        await Promise.all([...bySession].map(async ([sessionId, messages]) => {
            if (skipSessionIds?.has(sessionId)) {
                return
            }
            // A text-only session has no asynchronous materialization work.
            // Run it without holding the in-flight marker so two synchronous
            // ticks retain the historical re-emit behavior.
            const hasAttachments = messages.some((message) => getUserMessageAttachments(message.content).length > 0)
            if (!hasAttachments) {
                await this.releaseMatureScheduledMessagesForSession(messages)
                return
            }
            if (this.matureReleaseInFlightSessions.has(sessionId)) return
            this.matureReleaseInFlightSessions.add(sessionId)
            try {
                await this.releaseMatureScheduledMessagesForSession(messages)
            } finally {
                this.matureReleaseInFlightSessions.delete(sessionId)
            }
        }))
    }

    private async releaseMatureScheduledMessagesForSession(
        messages: StoredMessageForDelivery[],
    ): Promise<void> {
        const sessionId = messages[0]?.sessionId
        if (!sessionId || this.store.isOpenCodeClearDeliveryGated(sessionId)) return
        if (messages.some((message) => getUserMessageAttachments(message.content).length > 0)
            && !this.hasCliSessionConnection(sessionId)) {
            return
        }

        let emitted = false
        for (const msg of messages) {
            // A hub-resident attachment must be transferred to the CLI host
            // before emitting. Keep the materializing key until the await
            // completes so cancellation can delete the still-unemitted row.
            const attachments = getUserMessageAttachments(msg.content)
            const hasAttachments = attachments.length > 0
            if (hasAttachments && !this.hasCliSessionConnection(sessionId)) continue

            let deliveryContent: unknown = contentForDeferredDelivery(msg.content)
            if (hasAttachments) {
                const materializingKey = `${sessionId}:${msg.id}`
                this.materializingScheduledMessageKeys.add(materializingKey)
                try {
                    try {
                        deliveryContent = await this.getScheduledDeliveryContent(msg)
                    } catch {
                        // Keep the row uninvoked. The next tick retries after
                        // the file or CLI connection becomes available. Do not
                        // overtake this row with a later scheduled message in
                        // the same session; mature delivery is FIFO.
                        break
                    }
                    if (deliveryContent === null) break

                    // Cancellation or an acknowledgement may have won while
                    // the attachment was being uploaded. Never emit the stale
                    // snapshot after the row leaves the queued state.
                    const current = this.store.messages.lookupQueuedMessage(sessionId, msg.id)
                    if (current.status !== 'queued') {
                        const staged = this.scheduledAttachmentDeliveryCache.get(materializingKey)
                        this.scheduledAttachmentDeliveryCache.delete(materializingKey)
                        if (staged) await this.cleanupMaterializedScheduledAttachments(sessionId, staged)
                        continue
                    }
                } finally {
                    this.materializingScheduledMessageKeys.delete(materializingKey)
                }
            }

            const localId = msg.localId
            if (typeof localId === 'string' && !this.scheduledMatureNotifiedLocalIds.has(localId)) {
                this.scheduledMatureNotifiedLocalIds.add(localId)
                emitted = true
            }
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
                        content: deliveryContent
                    }
                }
            }
            this.io.of('/cli').to(`session:${sessionId}`).emit('update', update)
            // NOTE: do NOT call markMessagesInvoked here (pitfall #2).
            // CLI ack (messages-consumed) will handle invoked_at stamping.
        }
        if (emitted) {
            this.publisher.emit({ type: 'scheduled-matured', sessionId })
        }
    }
}

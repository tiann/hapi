import type { AttachmentMetadata } from '@hapi/protocol/types'
import type { Store, StoredMessage } from '../store'
import {
    getHapiHomeDir,
    isScratchlistAttachmentPathForSession,
    moveScratchlistAttachmentFilesForSession,
} from '../scratchlistAttachments/storage'

function getUserMessageAttachments(content: unknown): AttachmentMetadata[] {
    if (content === null || typeof content !== 'object' || Array.isArray(content)) return []
    const record = content as { role?: unknown; content?: unknown }
    if (record.role !== 'user' || record.content === null
        || typeof record.content !== 'object' || Array.isArray(record.content)) {
        return []
    }
    const attachments = (record.content as { attachments?: unknown }).attachments
    return Array.isArray(attachments) ? attachments as AttachmentMetadata[] : []
}

/**
 * Re-key Hub-resident attachments after message rows move between session ids.
 * The Hub path embeds the owning session id, so moving only the SQLite row
 * would make a scheduled attachment fail validation or resolve against the
 * wrong directory.
 */
export async function rehomeMessageAttachments(
    store: Store,
    namespace: string,
    oldSessionId: string,
    newSessionId: string,
    sourceMessages: StoredMessage[] = [],
): Promise<void> {
    if (oldSessionId === newSessionId) return

    const targetMessages = store.messages.getAllMessages(newSessionId)
    const targetById = new Map(targetMessages.map((message) => [message.id, message]))
    const candidates = new Map<string, StoredMessage>()
    for (const message of sourceMessages) candidates.set(message.id, message)
    for (const message of targetMessages) {
        if (!candidates.has(message.id)) candidates.set(message.id, message)
    }

    const hapiHome = getHapiHomeDir()
    const sourceDraftPaths = new Set(
        store.scratchlist
            .list(oldSessionId)
            .flatMap((entry) => entry.attachments.map((attachment) => attachment.path))
    )
    for (const messageId of candidates.keys()) {
        const persisted = targetById.get(messageId)
        // Consumed scheduled messages may still carry the original Hub path in
        // their history, but releaseConsumedScheduledAttachments deliberately
        // removes that source file once no pending row references it. Only
        // re-home attachments that can still be delivered or cancelled.
        if (!persisted || persisted.invokedAt !== null || persisted.scheduledAt === null) continue
        const attachments = getUserMessageAttachments(persisted.content)
        if (!attachments.some((attachment) => isScratchlistAttachmentPathForSession(
            attachment.path,
            namespace,
            oldSessionId,
        ))) {
            continue
        }

        const moved = await moveScratchlistAttachmentFilesForSession(
            hapiHome,
            namespace,
            oldSessionId,
            newSessionId,
            attachments,
            {
                throwOnFailure: true,
                preserveSourcePaths: new Set(
                    attachments
                        .filter((attachment) => sourceDraftPaths.has(attachment.path))
                        .map((attachment) => attachment.path)
                ),
            },
        )
        if (moved.some((attachment, index) => attachment.path !== attachments[index]?.path)) {
            // Persist each successful message re-home immediately. If a later
            // message fails to move, earlier filesystem moves and their DB
            // paths remain consistent and can be retried independently.
            store.messages.rewriteMessageAttachments(newSessionId, [{ messageId, attachments: moved }])
        }
    }
}

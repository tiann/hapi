package app.hapi.companion.feature.chat.composer

import app.hapi.companion.feature.chat.attachments.ComposerDraftAttachment

/**
 * Per-session attachment-draft persistence (drafts v2), the tray-reference
 * twin of [ChatDrafts]. Production backing is a Preferences DataStore
 * ([app.hapi.companion.di.DataStoreAttachmentDrafts], keys scoped by hub,
 * max-50 recency ring); tests use an in-memory map.
 */
interface AttachmentDrafts {
    /** The saved references, or empty when none (corrupt rows degrade to empty). */
    suspend fun load(sessionId: String): List<ComposerDraftAttachment>

    /** Persist [attachments]; an empty list clears the key. */
    suspend fun save(sessionId: String, attachments: List<ComposerDraftAttachment>)

    suspend fun clear(sessionId: String)

    /** Resume/reopen returned a different id: carry the draft across. */
    suspend fun move(fromSessionId: String, toSessionId: String)
}

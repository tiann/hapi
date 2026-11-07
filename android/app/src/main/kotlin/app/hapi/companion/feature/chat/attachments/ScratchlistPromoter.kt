package app.hapi.companion.feature.chat.attachments

import app.hapi.data.api.ScratchlistAttachmentFile
import app.hapi.protocol.wire.AttachmentMetadata
import app.hapi.protocol.wire.ScratchlistAttachment
import java.util.Base64
import kotlin.coroutines.cancellation.CancellationException

/**
 * Scratchlist promote plumbing (web `scratchlistAttachmentFlow.ts` twin):
 * entry attachments live in hub scratchlist storage, whose paths are NOT
 * valid send-message or composer-train paths — both promote directions must
 * fetch the blob and move the bytes across storage domains.
 *
 * Every I/O seam is an injected interface, so the whole flow (including the
 * rollback discipline) is pure JVM-testable; ChatViewModel supplies the
 * production seams (hub fetch via [app.hapi.data.api.HapiApi], chat uploads
 * via [app.hapi.data.api.AttachmentUploadApi], Android pick preparation via
 * [AttachmentPreparer]).
 */
object ScratchlistPromoter {

    /** Hub scratchlist blob fetch — `GET …/scratchlist/attachments/:id`. */
    fun interface AttachmentFetcher {
        /** Returns null on any failure (caller decides skip/abort). */
        suspend fun fetch(sessionId: String, attachmentId: String): ScratchlistAttachmentFile?
    }

    /** Chat upload seam (`POST /sessions/:id/upload`) — returns the new path, null on failure. */
    fun interface ChatUploader {
        suspend fun upload(
            sessionId: String,
            filename: String,
            bytes: ByteArray,
            mimeType: String,
        ): String?
    }

    /** Best-effort chat upload delete (staging rollback cleanup). */
    fun interface ChatUploadDeleter {
        suspend fun delete(sessionId: String, path: String)
    }

    /** Rebuilds fetched blob bytes as a composer pick (Android policy/thumbnail pipeline). */
    fun interface PickPreparer {
        /** Returns null when the bytes fail policy (over cap / undecodable). */
        suspend fun prepare(
            attachment: ScratchlistAttachment,
            bytes: ByteArray,
            mimeType: String,
        ): PreparedAttachment?
    }

    /** Web `stageScratchlistAttachmentsForComposeSend` preview gate. */
    const val PREVIEW_DATA_URL_MAX_BYTES: Long = 5L * 1024 * 1024

    /**
     * Promote-to-queue staging (web `stageScratchlistAttachmentsForComposeSend`):
     * fetch each hub blob and re-upload it through the chat upload endpoint
     * so the send body carries real chat paths. Any failure rolls back the
     * already-staged uploads (best-effort deletes) and returns null — the
     * entry is then retained, retryable.
     */
    suspend fun stageForQueueSend(
        sessionId: String,
        attachments: List<ScratchlistAttachment>,
        fetcher: AttachmentFetcher,
        uploader: ChatUploader,
        deleter: ChatUploadDeleter,
    ): List<AttachmentMetadata>? {
        if (attachments.isEmpty()) return emptyList()
        val staged = mutableListOf<AttachmentMetadata>()
        try {
            for (attachment in attachments) {
                val blob = fetcher.fetch(sessionId, attachment.id)
                    ?: return rollbackStaged(sessionId, staged, deleter)
                val path = uploader.upload(sessionId, attachment.filename, blob.bytes, attachment.mimeType)
                    ?: return rollbackStaged(sessionId, staged, deleter)
                staged += AttachmentMetadata(
                    id = attachment.id,
                    filename = attachment.filename,
                    mimeType = attachment.mimeType,
                    size = attachment.size,
                    path = path,
                    previewUrl = previewDataUrlOrNull(attachment, blob.bytes),
                )
            }
            return staged
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Exception) {
            return rollbackStaged(sessionId, staged, deleter)
        }
    }

    /**
     * Promote-to-composer rehydration (web
     * `rehydrateScratchlistAttachmentsToComposer`): fetch each blob and hand
     * it to [preparer], whose result enters the composer tray and re-uploads
     * through the normal chat pipeline. A failed fetch or a policy rejection
     * skips just that attachment (the entry itself is never removed by this
     * flow — copy, not move); the caller compares counts to surface a notice.
     */
    suspend fun rehydrateToComposer(
        sessionId: String,
        attachments: List<ScratchlistAttachment>,
        fetcher: AttachmentFetcher,
        preparer: PickPreparer,
    ): List<PreparedAttachment> {
        val picks = mutableListOf<PreparedAttachment>()
        for (attachment in attachments) {
            try {
                val blob = fetcher.fetch(sessionId, attachment.id) ?: continue
                val mimeType = blob.mimeType?.takeIf { it.isNotBlank() } ?: attachment.mimeType
                preparer.prepare(attachment, blob.bytes, mimeType)?.let { picks += it }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (_: Exception) {
                // One bad attachment must not block the rest of the copy.
            }
        }
        return picks
    }

    /**
     * Web preview parity: images within the size gate embed the payload as a
     * data URL (web sends the original there; the entry side already holds
     * compressed-enough bytes, ≤ 10 MB per hub limits).
     */
    private fun previewDataUrlOrNull(attachment: ScratchlistAttachment, bytes: ByteArray): String? =
        if (AttachmentPolicy.isImageMime(attachment.mimeType) && attachment.size <= PREVIEW_DATA_URL_MAX_BYTES) {
            AttachmentPolicy.dataUrl(attachment.mimeType, bytes)
        } else {
            null
        }

    /** Delete the staged chat uploads (web: `deleteUploadFile` per staged path) and fail. */
    private suspend fun rollbackStaged(
        sessionId: String,
        staged: List<AttachmentMetadata>,
        deleter: ChatUploadDeleter,
    ): List<AttachmentMetadata>? {
        staged.forEach { metadata ->
            try {
                deleter.delete(sessionId, metadata.path)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (_: Exception) {
                // Best-effort by contract.
            }
        }
        return null
    }
}

/** Base64 of [bytes] — the chat upload wire encoding (kept next to its only caller shape). */
internal fun chatUploadBase64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)

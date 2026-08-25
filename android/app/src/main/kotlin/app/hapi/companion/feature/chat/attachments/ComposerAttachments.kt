package app.hapi.companion.feature.chat.attachments

import app.hapi.data.api.AttachmentUploadApi
import app.hapi.protocol.wire.AttachmentMetadata
import java.util.Base64
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.DelicateCoroutinesApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * A picked file after platform preparation (ContentResolver read + optional
 * image downscale): everything the upload flow needs, no Android types —
 * JVM tests feed these directly.
 */
class PreparedAttachment(
    val id: String,
    /** Display/upload filename (extension rewritten to `.jpg` when compressed). */
    val filename: String,
    val mimeType: String,
    /** The exact bytes that will upload (post-compression when applicable). */
    val bytes: ByteArray,
    /** Small JPEG thumbnail for the chip + wire `previewUrl`; null for non-images. */
    val previewBytes: ByteArray? = null,
) {
    val sizeBytes: Long get() = bytes.size.toLong()
}

/** Chip lifecycle: uploading → ready (or failed → retry/remove). */
enum class ComposerAttachmentStatus { Uploading, Ready, Failed }

/** One composer attachment chip. */
@Suppress("ArrayInDataClass")
data class ComposerAttachmentUi(
    val id: String,
    val filename: String,
    val mimeType: String,
    val sizeBytes: Long,
    /** JPEG thumbnail bytes for image picks; null renders a file glyph. */
    val previewBytes: ByteArray?,
    val status: ComposerAttachmentStatus,
)

/**
 * Composer attachment tray (B-M3f): upload-on-pick state machine feeding
 * `SendMessageRequest.attachments`.
 *
 * Mirrors the web `attachmentAdapter.ts` flow with mobile adjustments:
 *
 * - [add] uploads immediately (`POST upload`, JSON + base64) and tracks the
 *   chip through [ComposerAttachmentStatus]; failures keep the payload bytes
 *   for [retry], successes drop them (only the small preview stays resident).
 * - [remove] deletes the uploaded file best-effort (`POST upload/delete`);
 *   removing a chip whose upload is still in flight lets the upload finish
 *   and then deletes the orphan (web `cancelledAttachmentIds` semantics).
 * - [consume] converts every Ready chip into [AttachmentMetadata] for the
 *   send body — `previewUrl` is a small JPEG data URL
 *   ([AttachmentPolicy.PREVIEW_MAX_DIMENSION]) so user bubbles render
 *   thumbnails on every client.
 * - **Drafts (v1 simplification)**: unlike the web (IndexedDB attachment
 *   drafts), attachments never persist. Leaving the chat for good discards
 *   un-sent chips via [discardAllDetached] after best-effort hub deletes;
 *   text drafts alone survive.
 * - **Inactive sessions (v1 simplification)**: the hub's upload route
 *   requires an active session, and unlike the web this tray does not
 *   resume-then-upload — a pick on an inactive session settles Failed;
 *   sending any text auto-resumes (B-M3ab), after which the chip's retry
 *   succeeds. Uploaded paths are absolute on the agent machine, so they
 *   stay readable across a resume (even one that supersedes the id).
 */
class ComposerAttachments(
    private val api: AttachmentUploadApi,
    private val sessionId: String,
    private val scope: CoroutineScope,
    /** Base64 of up to 50 MB happens off the main thread. */
    private val encodeDispatcher: CoroutineDispatcher = Dispatchers.Default,
    /** [discardAllDetached] launch target; null ⇒ GlobalScope (production). */
    private val detachedCleanupScope: CoroutineScope? = null,
) {
    private class Entry(
        val ui: ComposerAttachmentUi,
        /** Hub upload path once Ready. */
        val path: String? = null,
        /** Upload payload, retained only until the upload succeeds (retry source). */
        val bytes: ByteArray? = null,
    )

    private val entries = MutableStateFlow<List<Entry>>(emptyList())

    /** Chip states for the composer row. */
    val items: StateFlow<List<ComposerAttachmentUi>> = entries
        .map { list -> list.map { it.ui } }
        .stateIn(scope, SharingStarted.Eagerly, emptyList())

    /** Convenience for send gating: chips exist and every one settled Ready. */
    fun allReady(): Boolean =
        entries.value.let { list -> list.isNotEmpty() && list.all { it.ui.status == ComposerAttachmentStatus.Ready } }

    /** True while any chip is Uploading or Failed — send must wait or resolve. */
    fun hasUnsettled(): Boolean =
        entries.value.any { it.ui.status != ComposerAttachmentStatus.Ready }

    /** Add a prepared pick to the tray and start its upload. */
    fun add(prepared: PreparedAttachment) {
        val ui = ComposerAttachmentUi(
            id = prepared.id,
            filename = prepared.filename,
            mimeType = prepared.mimeType,
            sizeBytes = prepared.sizeBytes,
            previewBytes = prepared.previewBytes,
            status = ComposerAttachmentStatus.Uploading,
        )
        entries.update { it + Entry(ui, bytes = prepared.bytes) }
        upload(prepared.id, prepared.filename, prepared.mimeType, prepared.bytes)
    }

    /** Failed chip tap: re-fire the upload with the retained bytes. */
    fun retry(id: String) {
        var payload: Entry? = null
        entries.update { list ->
            val entry = list.firstOrNull {
                it.ui.id == id && it.ui.status == ComposerAttachmentStatus.Failed && it.bytes != null
            } ?: return@update list
            payload = entry
            list.map {
                if (it.ui.id == id) Entry(it.ui.copy(status = ComposerAttachmentStatus.Uploading), bytes = it.bytes)
                else it
            }
        }
        val entry = payload ?: return
        upload(id, entry.ui.filename, entry.ui.mimeType, entry.bytes!!)
    }

    /**
     * Drop a chip. An already-uploaded file is deleted best-effort; an
     * in-flight upload deletes its result on completion (see [upload]).
     */
    fun remove(id: String) {
        var removed: Entry? = null
        entries.update { list ->
            removed = list.firstOrNull { it.ui.id == id }
            list.filterNot { it.ui.id == id }
        }
        removed?.path?.let { path ->
            scope.launch { runCatching { api.deleteUpload(sessionId, path) } }
        }
    }

    /**
     * Take every Ready chip as send metadata, clearing them from the tray
     * (unsettled chips stay put — the ViewModel guards against calling with
     * any pending, but a race can settle one to Failed in between).
     *
     * @return the metadata list, or null when nothing was ready.
     */
    fun consume(): List<AttachmentMetadata>? {
        var taken: List<Entry> = emptyList()
        entries.update { list ->
            taken = list.filter { it.ui.status == ComposerAttachmentStatus.Ready && it.path != null }
            list - taken.toSet()
        }
        if (taken.isEmpty()) return null
        return taken.map { entry ->
            AttachmentMetadata(
                id = entry.ui.id,
                filename = entry.ui.filename,
                mimeType = entry.ui.mimeType,
                size = entry.ui.sizeBytes,
                path = entry.path!!,
                previewUrl = entry.ui.previewBytes?.let { AttachmentPolicy.dataUrl("image/jpeg", it) },
            )
        }
    }

    /**
     * Leaving the chat for good (ViewModel holder `onCleared`): un-sent
     * uploads are orphans on the hub — delete them best-effort on a detached
     * scope, because the owning scope is being cancelled right after (same
     * pattern as the draft flush). Attachments are NOT part of drafts v1.
     */
    @OptIn(DelicateCoroutinesApi::class)
    fun discardAllDetached() {
        var dropped: List<Entry> = emptyList()
        entries.update { list ->
            dropped = list
            emptyList()
        }
        val paths = dropped.mapNotNull { it.path }
        if (paths.isEmpty()) return
        (detachedCleanupScope ?: GlobalScope).launch(Dispatchers.IO) {
            paths.forEach { path -> runCatching { api.deleteUpload(sessionId, path) } }
        }
    }

    private fun upload(id: String, filename: String, mimeType: String, bytes: ByteArray) {
        scope.launch {
            val base64 = withContext(encodeDispatcher) { Base64.getEncoder().encodeToString(bytes) }
            val path = try {
                val response = api.uploadFile(sessionId, filename, base64, mimeType)
                if (response.success) response.path else null
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (_: Exception) {
                null
            }

            var applied = false
            entries.update { list ->
                applied = list.any { it.ui.id == id }
                if (!applied) list
                else list.map { entry ->
                    when {
                        entry.ui.id != id -> entry
                        // Success: drop the payload bytes — only the preview stays.
                        path != null -> Entry(entry.ui.copy(status = ComposerAttachmentStatus.Ready), path = path)
                        else -> Entry(entry.ui.copy(status = ComposerAttachmentStatus.Failed), bytes = entry.bytes)
                    }
                }
            }
            // Removed while uploading: the hub file just became an orphan.
            if (!applied && path != null) {
                runCatching { api.deleteUpload(sessionId, path) }
            }
        }
    }
}

package app.hapi.companion.feature.scratchlist

import android.net.Uri
import app.hapi.data.store.ScratchlistAttachmentDeleteResult
import app.hapi.data.store.ScratchlistCreateResult
import app.hapi.data.store.ScratchlistUploadResult
import app.hapi.data.store.SessionScratchlist
import app.hapi.protocol.wire.ScratchlistAttachment
import app.hapi.protocol.wire.ScratchlistAttachmentLimits
import app.hapi.protocol.wire.ScratchlistEntry
import app.hapi.protocol.wire.ScratchlistErrorCodes
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/** What [ScratchlistScreen] renders as the entry list. */
data class ScratchlistUiState(
    val entries: List<ScratchlistEntry> = emptyList(),
    /** First fetch still running, nothing cached yet. */
    val isLoading: Boolean = true,
    /** First fetch failed with nothing to show → error state. */
    val loadFailed: Boolean = false,
    /** 200-entry cap reached — FAB/park surfaces a friendly message instead. */
    val atCap: Boolean = false,
    val uploadsInFlight: List<String> = emptyList(),
)

/** Edit-sheet model; [entryId] `null` = drafting a brand-new entry. */
data class ScratchlistEditorState(
    val entryId: String? = null,
    val text: String = "",
    val attachments: List<ScratchlistAttachment> = emptyList(),
    /** A picked file is importing/uploading — spinner chip in the strip. */
    val isUploading: Boolean = false,
)

sealed interface ScratchlistEvent {
    /** Transient failure/notice for a snackbar (resolved to a string at the UI layer). */
    data class Notice(val notice: ScratchlistNotice) : ScratchlistEvent
}

/** Semantic scratchlist notices (B-M5a) — localized by the screen. */
sealed interface ScratchlistNotice {
    data object AtCapDeleteFirst : ScratchlistNotice
    data object AtCap : ScratchlistNotice
    data object NeedsContent : ScratchlistNotice
    data object SaveFailed : ScratchlistNotice
    data object DeleteFailed : ScratchlistNotice
    data object AttachFailed : ScratchlistNotice
    data object RemoveAttachmentFailed : ScratchlistNotice
    data object UploadTooLarge : ScratchlistNotice
    data object UploadFailed : ScratchlistNotice
    data class ImportRejected(val reason: ScratchlistImportRejection) : ScratchlistNotice
}

/** Why an attachment pick was rejected before upload (localized by the screen). */
sealed interface ScratchlistImportRejection {
    data object Unreadable : ScratchlistImportRejection
    data object ImageTooLarge : ScratchlistImportRejection
    data class TooManyAttachments(val max: Int) : ScratchlistImportRejection
    data object FileTypeNotAllowed : ScratchlistImportRejection
    data class FileTooLarge(val maxMb: Long) : ScratchlistImportRejection
    data object BudgetExhausted : ScratchlistImportRejection
}

/** Prepared upload payload produced by a [ScratchlistAttachmentImporter]. */
class PreparedScratchlistAttachment(
    val filename: String,
    val bytes: ByteArray,
    val mimeType: String,
)

sealed interface ScratchlistImportOutcome {
    data class Ready(val attachment: PreparedScratchlistAttachment) : ScratchlistImportOutcome
    data class Rejected(val reason: ScratchlistImportRejection) : ScratchlistImportOutcome
}

/**
 * Reads a picked content [Uri] and enforces the attachment budgets
 * (`ScratchlistAttachmentGuard`), downscaling oversized raster images.
 * Production: [ContentResolverAttachmentImporter]; tests fake it.
 */
fun interface ScratchlistAttachmentImporter {
    suspend fun import(
        uri: Uri,
        limits: ScratchlistAttachmentLimits,
        existing: List<ScratchlistAttachment>,
    ): ScratchlistImportOutcome
}

/**
 * Per-session scratchlist workbench (B-M4d): the entries list rides
 * [SessionScratchlist]'s per-session cache (optimistic CRUD + SSE-triggered
 * refetch handled there); this ViewModel owns the edit-sheet draft state and
 * the attachment import→upload flow.
 *
 * Attachment writes: on an **existing** entry every strip change persists
 * immediately (upload → `PUT {attachments}` / remove → PUT minus the file,
 * then a best-effort attachment delete to free session bytes). On a **new**
 * entry uploads accumulate locally and travel with the create; dismissing the
 * draft best-effort deletes the now-orphaned uploads.
 */
class ScratchlistViewModel(
    val sessionId: String,
    private val store: SessionScratchlist,
    private val scope: CoroutineScope,
    private val importer: ScratchlistAttachmentImporter? = null,
) {
    val uiState: StateFlow<ScratchlistUiState> = store.state(sessionId)
        .map { st ->
            ScratchlistUiState(
                entries = st.entries,
                isLoading = !st.loaded && !st.loadFailed,
                loadFailed = st.loadFailed,
                atCap = st.atCap,
                uploadsInFlight = st.uploadsInFlight,
            )
        }
        .stateIn(scope, SharingStarted.Eagerly, ScratchlistUiState())

    private val _editor = MutableStateFlow<ScratchlistEditorState?>(null)

    /** Non-null while the edit sheet is open. */
    val editor: StateFlow<ScratchlistEditorState?> = _editor.asStateFlow()

    private val _events = MutableSharedFlow<ScratchlistEvent>(extraBufferCapacity = 16)
    val events: SharedFlow<ScratchlistEvent> = _events.asSharedFlow()

    private var opened = false

    /** Idempotent; call from the screen's composition, paired with [stop]. */
    fun start() {
        if (opened) return
        opened = true
        store.open(sessionId)
    }

    fun stop() {
        if (!opened) return
        opened = false
        store.release(sessionId)
    }

    /** Error-state retry. */
    fun retry() {
        scope.launch { runCatching { store.refresh(sessionId) } }
    }

    // -------------------------------------------------------------- editor --

    /** Card tap (existing) or FAB (`entry = null`, new draft). */
    fun openEditor(entry: ScratchlistEntry?) {
        if (entry == null && uiState.value.atCap) {
            notice(ScratchlistNotice.AtCapDeleteFirst)
            return
        }
        _editor.value = if (entry == null) {
            ScratchlistEditorState()
        } else {
            ScratchlistEditorState(
                entryId = entry.entryId,
                text = entry.text,
                attachments = entry.attachments,
            )
        }
    }

    /** Sheet dismissed without saving; orphaned new-draft uploads are freed. */
    fun dismissEditor() {
        val editor = _editor.value ?: return
        _editor.value = null
        if (editor.entryId == null && editor.attachments.isNotEmpty()) {
            scope.launch {
                editor.attachments.forEach { attachment ->
                    runCatching { store.deleteAttachment(sessionId, attachment.id) }
                }
            }
        }
    }

    fun setEditorText(text: String) {
        _editor.value = _editor.value?.copy(text = text)
    }

    /**
     * Save closes the sheet immediately (mutations are store-optimistic and
     * roll back with a snackbar on failure — web parity).
     */
    fun saveEditor() {
        val editor = _editor.value ?: return
        val text = editor.text.trim()
        if (text.isEmpty() && editor.attachments.isEmpty()) {
            // Nothing to keep: a new draft just closes; an existing entry
            // must keep text or attachments (hub 400s empty updates).
            if (editor.entryId == null) {
                _editor.value = null
            } else {
                notice(ScratchlistNotice.NeedsContent)
            }
            return
        }
        _editor.value = null
        scope.launch {
            if (editor.entryId == null) {
                when (store.createEntry(sessionId, text, editor.attachments)) {
                    is ScratchlistCreateResult.Created -> Unit
                    ScratchlistCreateResult.AtCap -> notice(ScratchlistNotice.AtCap)
                    is ScratchlistCreateResult.Failed -> notice(ScratchlistNotice.SaveFailed)
                }
            } else {
                if (!store.updateEntry(sessionId, editor.entryId, text = text)) {
                    notice(ScratchlistNotice.SaveFailed)
                }
            }
        }
    }

    /** Sheet delete (or a per-card affordance); optimistic with store rollback. */
    fun deleteEntry(entryId: String) {
        if (_editor.value?.entryId == entryId) _editor.value = null
        scope.launch {
            if (!store.deleteEntry(sessionId, entryId)) {
                notice(ScratchlistNotice.DeleteFailed)
            }
        }
    }

    // --------------------------------------------------------- attachments --

    /** Photo-picker result → guard/downscale → upload → strip (and PUT for existing entries). */
    fun addAttachment(uri: Uri) {
        val importer = importer ?: return
        val editor = _editor.value ?: return
        if (editor.isUploading) return
        _editor.value = editor.copy(isUploading = true)
        scope.launch {
            try {
                val limits = store.limits(sessionId)
                val current = _editor.value ?: return@launch
                val outcome = importer.import(uri, limits, current.attachments)
                val prepared = when (outcome) {
                    is ScratchlistImportOutcome.Rejected -> {
                        notice(ScratchlistNotice.ImportRejected(outcome.reason))
                        return@launch
                    }
                    is ScratchlistImportOutcome.Ready -> outcome.attachment
                }
                val uploaded = store.uploadAttachment(
                    sessionId,
                    filename = prepared.filename,
                    bytes = prepared.bytes,
                    mimeType = prepared.mimeType,
                )
                when (uploaded) {
                    is ScratchlistUploadResult.Failed -> notice(uploadFailureNotice(uploaded))
                    is ScratchlistUploadResult.Uploaded -> attachToEditor(uploaded.attachment)
                }
            } finally {
                _editor.value = _editor.value?.copy(isUploading = false)
            }
        }
    }

    private suspend fun attachToEditor(attachment: ScratchlistAttachment) {
        val editor = _editor.value ?: run {
            // Sheet closed mid-upload: don't leak the stored file.
            store.deleteAttachment(sessionId, attachment.id)
            return
        }
        val next = editor.attachments + attachment
        _editor.value = editor.copy(attachments = next)
        if (editor.entryId != null) {
            if (!store.updateEntry(sessionId, editor.entryId, attachments = next)) {
                rollbackEditorAttachments(editor.entryId, editor.attachments)
                runCatching { store.deleteAttachment(sessionId, attachment.id) }
                notice(ScratchlistNotice.AttachFailed)
            }
        }
    }

    /** Restore the strip to [attachments] if the sheet still edits [entryId]. */
    private fun rollbackEditorAttachments(entryId: String, attachments: List<ScratchlistAttachment>) {
        val current = _editor.value ?: return
        if (current.entryId == entryId) {
            _editor.value = current.copy(attachments = attachments)
        }
    }

    /** Strip ✕: detach (existing entries PUT immediately) and free the stored file. */
    fun removeAttachment(attachment: ScratchlistAttachment) {
        val editor = _editor.value ?: return
        val next = editor.attachments.filter { it.id != attachment.id }
        if (next.size == editor.attachments.size) return
        _editor.value = editor.copy(attachments = next)
        scope.launch {
            if (editor.entryId != null) {
                if (!store.updateEntry(sessionId, editor.entryId, attachments = next)) {
                    rollbackEditorAttachments(editor.entryId, editor.attachments)
                    notice(ScratchlistNotice.RemoveAttachmentFailed)
                    return@launch
                }
            }
            // Best-effort byte-budget cleanup; InUse just means another entry
            // still references the file (fine to leave).
            when (store.deleteAttachment(sessionId, attachment.id)) {
                ScratchlistAttachmentDeleteResult.Removed,
                ScratchlistAttachmentDeleteResult.InUse,
                -> Unit
                is ScratchlistAttachmentDeleteResult.Failed -> Unit
            }
        }
    }

    private fun uploadFailureNotice(failed: ScratchlistUploadResult.Failed): ScratchlistNotice =
        when (failed.code) {
            ScratchlistErrorCodes.ATTACHMENT_TOO_LARGE -> ScratchlistNotice.UploadTooLarge
            else -> ScratchlistNotice.UploadFailed
        }

    private fun notice(notice: ScratchlistNotice) {
        _events.tryEmit(ScratchlistEvent.Notice(notice))
    }
}

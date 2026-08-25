package app.hapi.companion.feature.files

import app.hapi.protocol.git.DiffFile
import app.hapi.protocol.git.UnifiedDiffParser
import app.hapi.protocol.wire.FileReadResponse
import java.util.Base64
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

// ------------------------------------------------------------- UI models --

enum class ViewerMode { DIFF, FILE }

/**
 * Fallback strings the viewer ViewModel needs (B-M5a Strings seam): defaults
 * are the pre-i18n English (JVM tests construct without arguments); production
 * passes resource-resolved values from the Navigation holder.
 */
class FileViewerStrings(
    val loadDiffFailed: String = "Failed to load diff",
    val readFileFailed: String = "Failed to read file",
)

sealed interface DiffUiState {
    data object Loading : DiffUiState

    /** Diff succeeded but printed nothing (no changes on this side). */
    data object Empty : DiffUiState
    data class Failed(val message: String) : DiffUiState
    data class Ready(val files: List<DiffFile>) : DiffUiState
}

sealed interface FileContentUiState {
    data object Loading : FileContentUiState
    data class Failed(val message: String) : FileContentUiState
    data object Empty : FileContentUiState

    /** Undecodable or heuristically binary (web `isBinaryContent`). */
    data object Binary : FileContentUiState

    data class Text(
        val text: String,
        /** Lowercased extension, fed to the `CodeBlock` highlighter. */
        val language: String?,
        val isMarkdown: Boolean,
    ) : FileContentUiState

    /** Raw image bytes for `BitmapFactory` (identity equality is fine here). */
    class Image(val bytes: ByteArray, val mimeType: String) : FileContentUiState
}

data class FileViewerUiState(
    val path: String,
    val fileName: String,
    val mode: ViewerMode,
    /** Which diff side is showing (the staged/unstaged toggle). */
    val staged: Boolean,
    val diff: DiffUiState = DiffUiState.Loading,
    val content: FileContentUiState = FileContentUiState.Loading,
    /** Markdown files: render preview instead of source (web default: preview). */
    val markdownPreview: Boolean = true,
    val sizeBytes: Long? = null,
    val modifiedAt: Long? = null,
    /** Requested line from a chat citation; shown as a hint chip (no per-line highlight — see screen note). */
    val focusLine: Int? = null,
)

/**
 * One file, two modes (web `file.tsx`): **diff** — `git-diff-file` stdout
 * through `UnifiedDiffParser` into `DiffView`, with a staged/unstaged toggle —
 * and **full** — `file` read, base64-decoded into highlighted text, markdown
 * preview, or an image. Both loads run in parallel; like the web page, the
 * viewer auto-falls to full mode when the diff is empty/failed or the file is
 * an image, until the user picks a mode explicitly.
 */
class FileViewerViewModel(
    private val sessionId: String,
    private val path: String,
    initialStaged: Boolean?,
    initialMode: ViewerMode?,
    focusLine: Int?,
    private val gateway: FilesGateway,
    private val scope: CoroutineScope,
    private val strings: FileViewerStrings = FileViewerStrings(),
) {
    private val stateFlow = MutableStateFlow(
        FileViewerUiState(
            path = path,
            fileName = path.substringAfterLast('/').ifEmpty { path },
            mode = initialMode ?: ViewerMode.DIFF,
            staged = initialStaged ?: false,
            focusLine = focusLine,
        ),
    )
    val state: StateFlow<FileViewerUiState> = stateFlow.asStateFlow()

    /** Explicit mode choice (initial `mode` arg or a chip tap) disables auto-fallback. */
    private var modeChosen = initialMode != null
    private var started = false
    private var diffJob: Job? = null

    fun start() {
        if (started) return
        started = true
        loadDiff()
        loadContent()
    }

    fun refresh() {
        loadDiff()
        loadContent()
    }

    fun setMode(mode: ViewerMode) {
        modeChosen = true
        stateFlow.update { it.copy(mode = mode) }
    }

    /** Staged/unstaged toggle: reloads the diff for the other side. */
    fun setStaged(staged: Boolean) {
        if (stateFlow.value.staged == staged) return
        stateFlow.update { it.copy(staged = staged) }
        loadDiff()
    }

    fun setMarkdownPreview(preview: Boolean) {
        stateFlow.update { it.copy(markdownPreview = preview) }
    }

    // ---------------------------------------------------------------- diff --

    private fun loadDiff() {
        diffJob?.cancel()
        stateFlow.update { it.copy(diff = DiffUiState.Loading) }
        diffJob = scope.launch {
            val staged = stateFlow.value.staged
            val diff = try {
                val response = gateway.gitDiffFile(sessionId, path, staged)
                when {
                    !response.success ->
                        DiffUiState.Failed(response.error ?: response.stderr ?: strings.loadDiffFailed)
                    response.stdout.isNullOrEmpty() -> DiffUiState.Empty
                    else -> {
                        val files = UnifiedDiffParser.parse(response.stdout.orEmpty())
                        if (files.isEmpty()) DiffUiState.Empty else DiffUiState.Ready(files)
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                DiffUiState.Failed(e.message ?: strings.loadDiffFailed)
            }
            stateFlow.update { it.copy(diff = diff) }
            autoSelectMode()
        }
    }

    // ------------------------------------------------------------- content --

    private fun loadContent() {
        scope.launch {
            val content = try {
                decodeContent(gateway.readFile(sessionId, path))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                stateFlow.update { it.copy(content = FileContentUiState.Failed(e.message ?: strings.readFileFailed)) }
                return@launch
            }
            stateFlow.update {
                it.copy(
                    content = content.state,
                    sizeBytes = content.size,
                    modifiedAt = content.modified,
                )
            }
            autoSelectMode()
        }
    }

    private class DecodedContent(val state: FileContentUiState, val size: Long?, val modified: Long?)

    private fun decodeContent(response: FileReadResponse): DecodedContent {
        if (!response.success) {
            return DecodedContent(
                FileContentUiState.Failed(response.error ?: strings.readFileFailed),
                response.size,
                response.modified,
            )
        }
        val base64 = response.content
        if (base64.isNullOrEmpty()) {
            return DecodedContent(FileContentUiState.Empty, response.size, response.modified)
        }

        val bytes = try {
            Base64.getMimeDecoder().decode(base64)
        } catch (_: IllegalArgumentException) {
            // Undecodable payload — treat like the web's failed decode: binary.
            return DecodedContent(FileContentUiState.Binary, response.size, response.modified)
        }

        val mime = imageMimeType(path)
        if (mime != null) {
            return DecodedContent(FileContentUiState.Image(bytes, mime), response.size, response.modified)
        }

        val text = String(bytes, Charsets.UTF_8)
        if (isBinaryContent(text)) {
            return DecodedContent(FileContentUiState.Binary, response.size, response.modified)
        }
        if (text.isEmpty()) {
            return DecodedContent(FileContentUiState.Empty, response.size, response.modified)
        }
        return DecodedContent(
            FileContentUiState.Text(
                text = text,
                language = fileExtension(path),
                isMarkdown = isMarkdownFile(path),
            ),
            response.size,
            response.modified,
        )
    }

    // ---------------------------------------------------------------- mode --

    /**
     * Web `file.tsx` effect: images always open full; an empty or failed diff
     * falls back to full. Skipped once the user (or the route) chose a mode.
     */
    private fun autoSelectMode() {
        if (modeChosen) {
            // Images have no text diff worth showing even when explicitly
            // requested via mode=diff from a stale link.
            return
        }
        val current = stateFlow.value
        val shouldShowFile = current.content is FileContentUiState.Image ||
            current.diff is DiffUiState.Empty ||
            current.diff is DiffUiState.Failed
        if (shouldShowFile && current.mode == ViewerMode.DIFF) {
            stateFlow.update { it.copy(mode = ViewerMode.FILE) }
        }
    }

    companion object {
        /** Web `IMAGE_MIME_BY_EXTENSION` (`file.tsx`). */
        private val IMAGE_MIME_BY_EXTENSION = mapOf(
            "apng" to "image/apng",
            "avif" to "image/avif",
            "bmp" to "image/bmp",
            "gif" to "image/gif",
            "ico" to "image/x-icon",
            "jpeg" to "image/jpeg",
            "jpg" to "image/jpeg",
            "png" to "image/png",
            "svg" to "image/svg+xml",
            "tif" to "image/tiff",
            "tiff" to "image/tiff",
            "webp" to "image/webp",
        )

        fun fileExtension(path: String): String? {
            val parts = path.split(".")
            if (parts.size <= 1) return null
            return parts.last().lowercase().ifEmpty { null }
        }

        fun imageMimeType(path: String): String? =
            fileExtension(path)?.let { IMAGE_MIME_BY_EXTENSION[it] }

        /** Web `isMarkdownFile` (`file-markdown-preview.ts`): md / mdx only. */
        fun isMarkdownFile(path: String): Boolean {
            val ext = fileExtension(path)
            return ext == "md" || ext == "mdx"
        }

        /** Web `isBinaryContent`: NUL, or > 10% control chars (excluding \t \n \r). */
        fun isBinaryContent(content: String): Boolean {
            if (content.isEmpty()) return false
            if ('\u0000' in content) return true
            val nonPrintable = content.count { it.code < 32 && it.code != 9 && it.code != 10 && it.code != 13 }
            return nonPrintable.toDouble() / content.length > 0.1
        }
    }
}

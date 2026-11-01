package app.hapi.companion.feature.sessions

import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.listSaver
import app.hapi.protocol.chat.SessionExportArtifact
import java.io.File
import java.io.OutputStream
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Destination seam over `ContentResolver.openOutputStream` — plain strings so
 * the pending-save machinery stays JVM-testable; the dialog supplies the real
 * resolver (`Uri.parse` + open).
 */
fun interface SessionExportDocumentSink {
    /** Opens the picked document for writing; null when the provider refuses. */
    fun open(uri: String): OutputStream?
}

/** Outcome of delivering a picker result to an armed save. */
sealed class SessionExportSaveOutcome {
    /** The artifact bytes landed in the picked document. */
    data object Saved : SessionExportSaveOutcome()

    /** Nothing was written — the stream was never opened empty-handed. */
    data object Failed : SessionExportSaveOutcome()
}

/**
 * A SAF save armed while the system picker is open (review r4367883584): the
 * artifact bytes are staged in the same cache directory the share outlet
 * uses, and only this small record (path + filename + size) travels through
 * `rememberSaveable`. The system picker routinely rotates or kills the
 * activity behind it — the armed operation survives that recreation without
 * shipping megabytes through the saved-instance bundle, so a completed picker
 * can never silently leave an empty document.
 */
class SessionExportPendingSave(
    /** Cache file holding the staged artifact bytes. */
    val path: String,
    /** The suggested filename that armed the picker (snackbar feedback). */
    val filename: String,
    /** Staged byte count (the web twin's `blob.size`). */
    val byteCount: Long,
) {

    /**
     * The picker answered with a document: copy the staged bytes into it and
     * consume the cache file. A missing cache file fails *before* any stream
     * opens, so the picked document is either written in full or untouched —
     * never created empty.
     */
    suspend fun complete(
        uri: String,
        sink: SessionExportDocumentSink,
        io: CoroutineDispatcher = Dispatchers.IO,
    ): SessionExportSaveOutcome {
        val outcome = withContext(io) {
            val staged = File(path)
            if (!staged.isFile) {
                return@withContext SessionExportSaveOutcome.Failed
            }
            try {
                val bytes = staged.readBytes()
                val stream = sink.open(uri)
                if (stream == null) {
                    SessionExportSaveOutcome.Failed
                } else {
                    stream.use { it.write(bytes) }
                    SessionExportSaveOutcome.Saved
                }
            } catch (cancel: CancellationException) {
                throw cancel
            } catch (_: Exception) {
                SessionExportSaveOutcome.Failed
            }
        }
        // Consumed either way: there is no retry-on-this-arming path — a
        // failed write surfaces the error box and a fresh Save re-arms.
        discard(io)
        return outcome
    }

    /** The picker was cancelled or the write finished: drop the staged file. */
    suspend fun discard(io: CoroutineDispatcher = Dispatchers.IO) {
        withContext(io) { File(path).delete() }
    }

    companion object {
        /**
         * Stages the artifact bytes the way the share outlet does (cache
         * `text-exports` directory with the 24 h sweep) and returns the
         * recreation-proof record.
         */
        suspend fun arm(
            artifact: SessionExportArtifact,
            cacheDir: File,
            io: CoroutineDispatcher = Dispatchers.IO,
        ): SessionExportPendingSave = withContext(io) {
            val directory = File(cacheDir, "text-exports").apply { mkdirs() }
            directory.listFiles()
                ?.filter { System.currentTimeMillis() - it.lastModified() > 86_400_000 }
                ?.forEach { it.delete() }
            val staged = File.createTempFile(
                "hapi-export-",
                ".${artifact.format.extension}",
                directory,
            ).apply { writeText(artifact.text, Charsets.UTF_8) }
            SessionExportPendingSave(
                path = staged.absolutePath,
                filename = artifact.filename,
                byteCount = staged.length(),
            )
        }
    }
}

/**
 * `rememberSaveable` payload for the armed save (the `CameraCaptureSaver`
 * shape): `[path, filename, byteCount]`, empty when no save is pending.
 * Plain functions so the recreation round trip is directly testable — the
 * saver below is a thin delegation onto them.
 */
internal fun pendingSessionExportToSavedState(pending: SessionExportPendingSave?): List<String> =
    if (pending == null) {
        emptyList()
    } else {
        listOf(pending.path, pending.filename, pending.byteCount.toString())
    }

/** Inverse of [pendingSessionExportToSavedState]; null when nothing usable. */
internal fun pendingSessionExportFromSavedState(saved: List<String>): SessionExportPendingSave? =
    if (saved.size < 3 || saved[0].isBlank()) {
        null
    } else {
        SessionExportPendingSave(saved[0], saved[1], saved[2].toLong())
    }

val SessionExportPendingSaveSaver: Saver<SessionExportPendingSave?, Any> = listSaver(
    save = { pending -> pendingSessionExportToSavedState(pending) },
    restore = { saved -> pendingSessionExportFromSavedState(saved) },
)

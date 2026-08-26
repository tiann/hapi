package app.hapi.data.store

import app.hapi.protocol.window.PersistedMessageWindow
import app.hapi.protocol.wire.HapiJson
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json

/**
 * Per-session message-window snapshots on disk: one JSON file per session in
 * [dir], written atomically (temp file + fsync + rename — the same guarantee
 * `android.util.AtomicFile` provides, hand-rolled here so plain JVM unit
 * tests can exercise it), pruned LRU to [maxSessions] files.
 *
 * Mirrors the web's `sessionStorage` persistence of
 * `PersistedMessageWindowState` (key `hapi:message-window:v2:`): messages +
 * cursors + epoch for instant cold-start rendering; `hydrate` in
 * `MessageWindowLogic` restores interrupted send states and flags stale
 * snapshots for a latest reset.
 *
 * TODO(B-M2b dedup): fold into the shared `JsonSnapshotStore` once that
 * lands — this class predates it in a parallel work package.
 */
class WindowSnapshots(
    private val dir: File,
    private val maxSessions: Int = DEFAULT_MAX_SESSIONS,
    private val json: Json = HapiJson,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {

    suspend fun save(sessionId: String, snapshot: PersistedMessageWindow): Unit = withContext(io) {
        dir.mkdirs()
        val target = fileFor(sessionId)
        val temp = File(dir, target.name + ".tmp")
        FileOutputStream(temp).use { stream ->
            stream.write(json.encodeToString(PersistedMessageWindow.serializer(), snapshot).toByteArray())
            stream.fd.sync()
        }
        if (!temp.renameTo(target)) {
            // Windows-style rename-over-existing failure; best effort swap.
            target.delete()
            temp.renameTo(target)
        }
        prune()
    }

    suspend fun load(sessionId: String): PersistedMessageWindow? = withContext(io) {
        val file = fileFor(sessionId)
        if (!file.isFile) return@withContext null
        try {
            val snapshot = json.decodeFromString(PersistedMessageWindow.serializer(), file.readText())
            // Touch for LRU recency: reading a snapshot marks the session live.
            file.setLastModified(System.currentTimeMillis())
            snapshot
        } catch (_: Exception) {
            file.delete()
            null
        }
    }

    suspend fun delete(sessionId: String): Unit = withContext(io) {
        fileFor(sessionId).delete()
        Unit
    }

    /** Drop the least-recently-written files beyond [maxSessions]. */
    private fun prune() {
        val files = dir.listFiles { file -> file.isFile && file.name.endsWith(SUFFIX) } ?: return
        if (files.size <= maxSessions) return
        files.sortedByDescending { it.lastModified() }
            .drop(maxSessions)
            .forEach { it.delete() }
    }

    /** Session ids are arbitrary strings — file names come from a digest. */
    private fun fileFor(sessionId: String): File {
        val digest = MessageDigest.getInstance("SHA-256").digest(sessionId.toByteArray())
        val name = digest.joinToString("") { "%02x".format(it) }.take(32)
        return File(dir, name + SUFFIX)
    }

    private companion object {
        const val DEFAULT_MAX_SESSIONS = 10
        const val SUFFIX = ".window.json"
    }
}

package app.hapi.data.store

import app.hapi.protocol.wire.HapiJson
import java.io.File
import java.io.FileOutputStream
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json

/**
 * Generic debounced JSON snapshot: one value ↔ one file. Backs the stores'
 * cold-start cache (no database, per the plan) — load synchronously at
 * construction, [scheduleWrite] on every state change, and the debounce
 * collapses SSE bursts into one atomic write.
 *
 * Atomicity is write-to-temp + fsync + rename (same guarantee as androidx
 * `AtomicFile`, without the Android dependency so JVM tests run as-is). A
 * torn/corrupt snapshot degrades to `null` on load — the stores then start
 * empty and REST refetch repopulates.
 */
class JsonSnapshotStore<T : Any>(
    private val file: File,
    private val serializer: KSerializer<T>,
    private val scope: CoroutineScope,
    private val debounceMs: Long = DEFAULT_DEBOUNCE_MS,
    private val json: Json = HapiJson,
) {
    private val lock = Any()
    private var pending: T? = null
    private var writeJob: Job? = null

    /** Synchronous load for cold start; `null` when absent or undecodable. */
    fun load(): T? {
        val text = try {
            if (!file.isFile) return null
            file.readText()
        } catch (_: Exception) {
            return null
        }
        return try {
            json.decodeFromString(serializer, text)
        } catch (_: Exception) {
            null
        }
    }

    /** Records [value] as the latest state and (re)starts the debounce window. */
    fun scheduleWrite(value: T) {
        synchronized(lock) {
            pending = value
            writeJob?.cancel()
            writeJob = scope.launch {
                delay(debounceMs)
                flushPending()
            }
        }
    }

    /** Writes any pending value immediately (app background / tests). */
    suspend fun flush() {
        synchronized(lock) { writeJob?.also { writeJob = null } }?.cancel()
        flushPending()
    }

    private suspend fun flushPending() {
        // Cleared only after the write completed — a cancellation between the
        // read and the write leaves the value pending for the next flush.
        val value = synchronized(lock) { pending } ?: return
        withContext(Dispatchers.IO) {
            try {
                writeAtomically(value)
            } catch (_: Exception) {
                // A failed snapshot write only costs the next cold start.
            }
        }
        synchronized(lock) { if (pending === value) pending = null }
    }

    private fun writeAtomically(value: T) {
        file.parentFile?.mkdirs()
        val tmp = File(file.parentFile, file.name + ".tmp")
        FileOutputStream(tmp).use { out ->
            out.write(json.encodeToString(serializer, value).toByteArray(Charsets.UTF_8))
            out.fd.sync()
        }
        if (!tmp.renameTo(file)) {
            // Windows-style rename-over-existing failure; not expected on
            // Android/Linux but keep the fallback total.
            file.delete()
            tmp.renameTo(file)
        }
    }

    companion object {
        const val DEFAULT_DEBOUNCE_MS: Long = 500
    }
}

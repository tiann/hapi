package app.hapi.companion.feature.share

import app.hapi.companion.feature.chat.attachments.AttachmentPolicy
import app.hapi.protocol.wire.HapiJson
import java.io.File
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.UUID
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer

data class SharedInput(val text: String, val uris: List<String>, val mimeType: String? = null) {
    val isEmpty: Boolean get() = text.isBlank() && uris.isEmpty()
}

data class ShareFileDetails(val filename: String, val mimeType: String, val size: Long? = null)

/** Platform boundary. The inbox itself is testable with ordinary JVM streams. */
interface ShareFileReader {
    fun details(uri: String, mimeTypeHint: String? = null): ShareFileDetails
    fun open(uri: String): InputStream?
}

@Serializable
enum class SharedFileStatus { Copying, Ready, Unreadable, TooLarge, Interrupted }

@Serializable
data class SharedFile(
    val id: String,
    val sourceUri: String,
    val filename: String,
    val mimeType: String = "application/octet-stream",
    val size: Long = 0,
    val status: SharedFileStatus = SharedFileStatus.Copying,
)

@Serializable
data class ShareTarget(val hubUrl: String, val sessionId: String)

@Serializable
data class PendingShare(
    val id: String,
    val createdAt: Long,
    val text: String,
    val files: List<SharedFile>,
    val target: ShareTarget? = null,
) {
    val canImport: Boolean get() = (text.isNotBlank() || files.isNotEmpty()) &&
        files.all { it.status == SharedFileStatus.Ready }
}

/**
 * Durable handoff, not an attachment draft store. Payloads live in no-backup
 * storage until the chat accepts them. Only generated IDs form disk paths;
 * provider filenames are display metadata, never filesystem components.
 */
class ShareInbox(
    private val root: File,
    private val reader: ShareFileReader,
    private val scope: CoroutineScope,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
    private val now: () -> Long = System::currentTimeMillis,
    private val onFailure: () -> Unit = {},
) {
    private val mutex = Mutex()
    private var loaded = false
    private val mutableBatches = MutableStateFlow<List<PendingShare>>(emptyList())
    val batches = mutableBatches.asStateFlow()
    private val copies = mutableMapOf<String, Job>()
    private val serializer = ListSerializer(PendingShare.serializer())

    suspend fun load() = withContext(ioDispatcher) {
        mutex.withLock { loadLocked() }
    }

    private fun loadLocked() {
        if (loaded) return
        root.mkdirs()
        val manifest = File(root, "inbox.json")
        val restored = if (manifest.exists()) {
            try {
                HapiJson.decodeFromString(serializer, manifest.readText())
            } catch (error: Exception) {
                // A damaged journal must not permanently prevent new shares.
                onFailure()
                if (!manifest.renameTo(File(root, "inbox.invalid"))) throw error
                emptyList()
            }
        } else emptyList()
        val cutoff = now() - RETENTION_MS
        val batches = restored.filter { batch ->
            validId(batch.id) && batch.createdAt > cutoff && batch.files.all { validId(it.id) }
        }.map { batch ->
            val files = batch.files.map { file ->
                when {
                    file.status == SharedFileStatus.Copying -> file.copy(status = SharedFileStatus.Interrupted)
                    file.status == SharedFileStatus.Ready && !payload(batch.id, file.id).isFile ->
                        file.copy(status = SharedFileStatus.Unreadable)
                    else -> file
                }
            }
            batch.copy(files = files, target = batch.target.takeIf { files.all { it.status == SharedFileStatus.Ready } })
        }
        writeLocked(batches)
        // Includes abandoned .part files and records expired while the app was closed.
        root.listFiles()?.filter { it.isDirectory && it.lastModified() <= cutoff && batches.none { batch -> batch.id == it.name } }
            ?.forEach { it.deleteRecursively() }
        loaded = true
    }

    suspend fun receive(input: SharedInput): String = withContext(ioDispatcher) {
        require(!input.isEmpty)
        val batch = PendingShare(
            id = UUID.randomUUID().toString(),
            createdAt = now(),
            text = input.text,
            files = input.uris.distinct().mapIndexed { index, uri ->
                SharedFile(UUID.randomUUID().toString(), uri, "attachment-${index + 1}",
                    mimeType = input.mimeType ?: "application/octet-stream")
            },
        )
        mutex.withLock {
            loadLocked()
            // Never expire a batch currently being handed to a chat.
            val expired = batches.value.filter { it.target == null && it.createdAt <= now() - RETENTION_MS }
            writeLocked(batches.value - expired.toSet() + batch)
            expired.forEach { cancelCopies(it); File(root, it.id).deleteRecursively() }
            batch.files.forEach { startCopyLocked(batch.id, it.id) }
        }
        batch.id
    }

    suspend fun retry(batchId: String, fileId: String) = withContext(ioDispatcher) {
        mutex.withLock {
            val batch = batches.value.find { it.id == batchId } ?: return@withLock
            val file = batch.files.find { it.id == fileId } ?: return@withLock
            if (file.status == SharedFileStatus.Copying || file.status == SharedFileStatus.Ready) return@withLock
            updateLocked(batch.copy(target = null, files = batch.files.map {
                if (it.id == fileId) it.copy(status = SharedFileStatus.Copying) else it
            }))
            startCopyLocked(batchId, fileId)
        }
    }

    suspend fun removeFile(batchId: String, fileId: String) = withContext(ioDispatcher) {
        mutex.withLock {
            val batch = batches.value.find { it.id == batchId } ?: return@withLock
            updateLocked(batch.copy(files = batch.files.filterNot { it.id == fileId }))
            copies.remove(fileId)?.cancel()
            payload(batchId, fileId).delete()
            File(root, "$batchId/$fileId.part").delete()
        }
    }

    suspend fun setTarget(batchId: String, target: ShareTarget) = withContext(ioDispatcher) {
        mutex.withLock {
            val batch = batches.value.find { it.id == batchId } ?: return@withLock
            check(batch.canImport)
            updateLocked(batch.copy(target = target))
        }
    }

    suspend fun clearTarget(batchId: String) = withContext(ioDispatcher) {
        mutex.withLock {
            batches.value.find { it.id == batchId }?.let { updateLocked(it.copy(target = null)) }
        }
    }

    suspend fun importFailed(batchId: String, fileId: String, status: SharedFileStatus) = withContext(ioDispatcher) {
        mutex.withLock {
            val batch = batches.value.find { it.id == batchId } ?: return@withLock
            updateLocked(batch.copy(target = null, files = batch.files.map {
                if (it.id == fileId) it.copy(status = status) else it
            }))
        }
    }

    /** Explicit discard and successful handoff have the same local cleanup. */
    suspend fun discard(batchId: String) = withContext(ioDispatcher) {
        mutex.withLock {
            val batch = batches.value.find { it.id == batchId } ?: return@withLock
            writeLocked(batches.value.filterNot { it.id == batchId })
            cancelCopies(batch)
            File(root, batchId).deleteRecursively()
        }
    }

    /** Resolves the replacement dialog; unselected batches are explicitly discarded. */
    suspend fun keepOnly(batchId: String) = withContext(ioDispatcher) {
        mutex.withLock {
            val kept = batches.value.find { it.id == batchId } ?: return@withLock
            val removed = batches.value.filterNot { it.id == batchId }
            writeLocked(listOf(kept))
            removed.forEach { cancelCopies(it); File(root, it.id).deleteRecursively() }
        }
    }

    fun file(batchId: String, fileId: String): File {
        require(validId(batchId) && validId(fileId))
        return payload(batchId, fileId)
    }

    private fun cancelCopies(batch: PendingShare) {
        batch.files.forEach { copies.remove(it.id)?.cancel() }
    }

    private fun startCopyLocked(batchId: String, fileId: String) {
        val job = scope.launch(ioDispatcher, start = CoroutineStart.LAZY) { copy(batchId, fileId) }
        copies[fileId] = job
        job.start()
    }

    private suspend fun copy(batchId: String, fileId: String) {
        val initial = batches.value.find { it.id == batchId }?.files?.find { it.id == fileId } ?: return
        val temporary = File(root, "$batchId/$fileId.part")
        var updated = initial
        try {
            val details = reader.details(initial.sourceUri, initial.mimeType)
            updated = initial.copy(filename = details.filename, mimeType = details.mimeType)
            val cap = AttachmentPolicy.readCapFor(details.mimeType)
            if (details.size != null && details.size > cap) throw Oversize()
            temporary.parentFile?.mkdirs()
            var size = 0L
            val input = reader.open(initial.sourceUri) ?: error("Unreadable content")
            input.use { stream ->
                temporary.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        currentCoroutineContext().ensureActive()
                        val count = stream.read(buffer)
                        if (count < 0) break
                        size += count
                        if (size > cap) throw Oversize()
                        output.write(buffer, 0, count)
                    }
                }
            }
            updated = updated.copy(size = size, status = SharedFileStatus.Ready)
            mutex.withLock {
                val batch = batches.value.find { it.id == batchId } ?: return@withLock
                if (batch.files.none { it.id == fileId }) return@withLock
                Files.move(temporary.toPath(), payload(batchId, fileId).toPath(), StandardCopyOption.REPLACE_EXISTING)
                updateLocked(batch.copy(files = batch.files.map { if (it.id == fileId) updated else it }))
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            updated = updated.copy(status = if (error is Oversize) SharedFileStatus.TooLarge else SharedFileStatus.Unreadable)
            mutex.withLock {
                batches.value.find { it.id == batchId }?.let { batch ->
                    val failedBatch = batch.copy(files = batch.files.map { if (it.id == fileId) updated else it })
                    try {
                        updateLocked(failedBatch)
                    } catch (_: Exception) {
                        // For example, a full disk. Keep an actionable error in
                        // memory; the last journal restores as Interrupted.
                        mutableBatches.value = batches.value.map { if (it.id == batchId) failedBatch else it }
                        onFailure()
                    }
                }
            }
        } finally {
            temporary.delete()
        }
    }

    private fun updateLocked(batch: PendingShare) = writeLocked(batches.value.map { if (it.id == batch.id) batch else it })

    private fun writeLocked(value: List<PendingShare>) {
        root.mkdirs()
        val temporary = File(root, "inbox.json.tmp")
        temporary.writeText(HapiJson.encodeToString(serializer, value))
        Files.move(temporary.toPath(), File(root, "inbox.json").toPath(),
            StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        mutableBatches.value = value
    }

    private fun payload(batchId: String, fileId: String) = File(root, "$batchId/$fileId")
    private class Oversize : Exception()

    companion object {
        const val RETENTION_MS = 24L * 60 * 60 * 1000
        private val ID_PATTERN = Regex("[a-f0-9-]{36}")
        private fun validId(id: String): Boolean = ID_PATTERN.matches(id)
    }
}

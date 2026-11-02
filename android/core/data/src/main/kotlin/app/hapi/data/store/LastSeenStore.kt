package app.hapi.data.store

import app.hapi.data.api.ApiError
import app.hapi.protocol.wire.HapiJson
import app.hapi.protocol.wire.SessionReadState
import app.hapi.protocol.wire.SessionReadStateRequest
import app.hapi.protocol.wire.SessionReadStateResponse
import app.hapi.protocol.wire.SessionSummary
import java.io.File
import java.io.FileOutputStream
import java.net.URLEncoder
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.isActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable

@Serializable
data class PendingRead(val id: String, val request: SessionReadStateRequest)

/** Revisions and the durable outbox share one atomic file, scoped by hub/namespace. */
@Serializable
data class LastSeenState(
    val lastSeen: Map<String, Long> = emptyMap(),
    val server: Map<String, SessionReadState> = emptyMap(),
    val pending: Map<String, PendingRead> = emptyMap(),
)

class LastSeenStore(
    private val scope: CoroutineScope,
    private val snapshotDir: File? = null,
    namespace: String? = "default",
) {
    @Volatile private var namespace: String? = namespace
    private val mutex = Mutex()
    private val syncLock = Any()
    @Volatile private var send: (suspend (String, SessionReadStateRequest) -> SessionReadState)? = null
    private var syncJob: Job? = null
    @Volatile private var foreground = true
    @Volatile private var closed = false
    private val _state = MutableStateFlow(load(namespace))
    val state: StateFlow<LastSeenState> = _state.asStateFlow()

    private fun file(namespace: String?): File? = namespace?.let { ns -> snapshotDir?.let {
        File(it, "read-state-${URLEncoder.encode(ns, "UTF-8")}.json")
    } }

    private fun load(namespace: String?): LastSeenState = runCatching {
        file(namespace)?.takeIf { it.isFile }?.readText()?.let { HapiJson.decodeFromString(LastSeenState.serializer(), it) }
    }.getOrNull() ?: LastSeenState()

    suspend fun configure(namespace: String, sender: suspend (String, SessionReadStateRequest) -> SessionReadState) {
        if (closed) return
        mutex.withLock {
            if (this.namespace != namespace) {
                synchronized(syncLock) {
                    val previous = syncJob
                    syncJob = null
                    this.namespace = namespace
                    previous?.cancel()
                }
                _state.value = withContext(Dispatchers.IO) { load(namespace) }
            }
            send = sender
        }
        sync()
    }

    fun setForeground(value: Boolean) {
        foreground = value
        if (value) sync()
    }

    fun lastSeenAt(sessionId: String): Long = _state.value.lastSeen[sessionId] ?: 0

    fun shutdown() = synchronized(syncLock) {
        closed = true
        foreground = false
        syncJob?.cancel()
        syncJob = null
    }

    /** A successful mark is already durable; background/close waits for active writes. */
    suspend fun flushPersistence() { mutex.withLock { } }

    private suspend fun commit(identity: String? = namespace, transform: (LastSeenState) -> LastSeenState) {
        mutex.withLock {
            if (namespace != identity) return
            val next = transform(_state.value)
            if (next == _state.value) return
            val target = file(namespace)
            // Cancellation on hub switch cannot tear a write or publish an unpersisted mark.
            withContext(NonCancellable + Dispatchers.IO) {
                if (target != null) {
                    target.parentFile?.mkdirs()
                    val temporary = File(target.parentFile, target.name + ".tmp")
                    FileOutputStream(temporary).use { output ->
                        output.write(HapiJson.encodeToString(LastSeenState.serializer(), next).toByteArray(Charsets.UTF_8))
                        output.fd.sync()
                    }
                    check(temporary.renameTo(target)) { "Cannot persist read state" }
                }
                _state.value = next
            }
        }
    }

    suspend fun markSeen(sessionId: String, revision: Long, serverState: SessionReadState? = null) {
        if (closed || namespace == null || sessionId.isEmpty() || revision < 0) return
        commit { current ->
            val server = SessionReadState.merge(current.server[sessionId], serverState) ?: SessionReadState()
            val seen = maxOf(current.lastSeen[sessionId] ?: 0, server.readRevision)
            val pending = current.pending[sessionId]
            val manualUnread = server.manualUnread && pending?.request?.expectedVersion != server.version
            if (seen >= revision && !manualUnread) return@commit current
            val request = SessionReadStateRequest(type = "read", readRevision = maxOf(seen, revision), expectedVersion = serverState?.version ?: server.version)
            current.copy(
                lastSeen = current.lastSeen + (sessionId to maxOf(seen, revision)),
                server = current.server + (sessionId to server),
                pending = current.pending + (sessionId to PendingRead(UUID.randomUUID().toString(), request)),
            )
        }
        sync()
    }

    private fun sync(): Unit = synchronized(syncLock) {
        if (closed || !scope.isActive || !foreground || send == null || syncJob != null || state.value.pending.isEmpty()) return
        val sender = send ?: return
        val identity = namespace
        val job = scope.launch(start = CoroutineStart.LAZY) {
            while (isActive && foreground && namespace == identity) {
                val (id, pending) = state.value.pending.entries.firstOrNull()?.let { it.key to it.value } ?: break
                try {
                    val response = sender(id, pending.request)
                    commit(identity) { current ->
                        current.copy(
                            server = current.server + (id to (SessionReadState.merge(current.server[id], response) ?: response)),
                            pending = if (current.pending[id]?.id == pending.id) current.pending - id else current.pending,
                        )
                    }
                } catch (cancelled: CancellationException) { throw cancelled
                } catch (error: Exception) {
                    if (error is ApiError && error.status in setOf(400, 403, 404, 409)) {
                        val authoritative = runCatching { HapiJson.decodeFromString(SessionReadStateResponse.serializer(), error.body ?: "").readState }.getOrNull()
                        try { commit(identity) { current -> current.copy(
                            server = if (authoritative == null) current.server else current.server + (id to (SessionReadState.merge(current.server[id], authoritative) ?: authoritative)),
                            lastSeen = if (current.pending[id]?.id == pending.id) current.lastSeen + (id to (authoritative?.readRevision ?: current.server[id]?.readRevision ?: 0)) else current.lastSeen,
                            pending = if (current.pending[id]?.id == pending.id) current.pending - id else current.pending,
                        ) } } catch (cancelled: CancellationException) { throw cancelled
                        } catch (_: Exception) { delay(5_000) }
                    } else delay(5_000)
                }
            }
        }
        syncJob = job
        job.invokeOnCompletion {
            synchronized(syncLock) {
                if (syncJob === job) { syncJob = null; sync() }
            }
        }
        job.start()
    }

    companion object {
        fun isUnread(summary: SessionSummary, state: LastSeenState): Boolean {
            val server = SessionReadState.merge(state.server[summary.id], summary.readState) ?: SessionReadState()
            val pending = state.pending[summary.id]
            val manual = server.manualUnread && pending?.request?.expectedVersion != server.version
            return manual || (summary.contentRevision ?: 0) > maxOf(server.readRevision, state.lastSeen[summary.id] ?: 0)
        }
    }
}

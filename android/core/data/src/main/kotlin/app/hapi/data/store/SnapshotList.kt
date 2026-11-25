package app.hapi.data.store

import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer

/** A live list whose disk location may only be known after authentication. */
internal class SnapshotList<T>(
    initialDir: File?,
    private val fileName: String,
    serializer: KSerializer<T>,
    private val scope: CoroutineScope,
    private val normalize: (List<T>) -> List<T> = { it },
) {
    private val lock = Any()
    private val listSerializer = ListSerializer(serializer)
    private fun snapshotIn(dir: File) = JsonSnapshotStore(File(dir, fileName), listSerializer, scope)

    private var snapshot = initialDir?.let(::snapshotIn)
    private var receivedUpdate = false
    private val mutableValues = MutableStateFlow(snapshot?.load()?.let(normalize).orEmpty())
    val values = mutableValues.asStateFlow()

    fun update(transform: (List<T>) -> List<T>) = synchronized(lock) {
        receivedUpdate = true
        val previous = mutableValues.value
        val next = transform(previous)
        if (next !== previous) {
            snapshot?.scheduleWrite(next)
            mutableValues.value = next
        }
    }

    /** Never put a disk snapshot over a live list, including an authoritative empty list. */
    fun enableSnapshots(dir: File) {
        val store = snapshotIn(dir)
        val cached = store.load()?.let(normalize)
        synchronized(lock) {
            if (snapshot != null) return
            snapshot = store
            if (receivedUpdate) store.scheduleWrite(mutableValues.value)
            else if (cached != null) mutableValues.value = cached
        }
    }

    suspend fun flush() {
        synchronized(lock) { snapshot }?.flush()
    }
}

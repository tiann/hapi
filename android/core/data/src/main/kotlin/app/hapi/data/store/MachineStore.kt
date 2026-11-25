package app.hapi.data.store

import app.hapi.data.api.HapiApi
import app.hapi.protocol.wire.HapiJson
import app.hapi.protocol.wire.Machine
import app.hapi.protocol.wire.MachinePatches
import app.hapi.protocol.wire.OptionalField
import app.hapi.protocol.wire.SyncEvent
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonNull

/** Machine-list store surface (production impl [MachineStore]; tests fake it). */
interface MachineListStore {
    /** API order preserved (the reference never re-sorts machines). */
    val machines: StateFlow<List<Machine>>

    /** `GET /api/machines`. Throws on failure. */
    suspend fun refresh()

    /** Coalesced fire-and-forget [refresh]. */
    fun scheduleRefresh()

    /** Routes the `machine-updated` SSE event. */
    fun applyMachineEvent(event: SyncEvent.MachineUpdated)
}

/**
 * Online machines for one hub. `machine-updated` handling is the exact web
 * decision tree (`web/src/hooks/useSSE.ts` + `sse.md#syncevent-union-13-types`):
 *
 * 1. full `Machine` → upsert — except `active: false`, which removes;
 * 2. explicit `null` data → machine removed;
 * 3. strict `MachinePatch` with `active: false` → remove; any other patch
 *    carries too little to upsert → refetch;
 * 4. absent / unparseable data → refetch.
 */
class MachineStore(
    private val api: HapiApi,
    private val scope: CoroutineScope,
    snapshotDir: File? = null,
    private val refreshBatchMs: Long = REFRESH_BATCH_MS,
) : MachineListStore {

    private val list = SnapshotList(snapshotDir, "machines.json", Machine.serializer(), scope)
    override val machines: StateFlow<List<Machine>> = list.values

    /** Enables the namespace-specific snapshot after identity is learned. */
    fun enableSnapshots(dir: File) = list.enableSnapshots(dir)

    private val refreshMutex = Mutex()
    private val refreshQueued = AtomicBoolean(false)

    /** Forces the debounced snapshot to disk (app background / tests). */
    suspend fun flushPersistence() {
        list.flush()
    }

    override suspend fun refresh() {
        refreshMutex.withLock {
            val response = api.getMachines()
            updateMachines { response.machines }
        }
    }

    override fun scheduleRefresh() {
        if (!refreshQueued.compareAndSet(false, true)) return
        scope.launch {
            delay(refreshBatchMs)
            refreshQueued.set(false)
            try {
                refresh()
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (_: Exception) {
                // Retried by the next event or manual refresh.
            }
        }
    }

    override fun applyMachineEvent(event: SyncEvent.MachineUpdated) {
        when (val data = event.data) {
            OptionalField.Absent -> scheduleRefresh()
            is OptionalField.Present -> {
                val element = data.value
                val machine = if (element is JsonNull) null else runCatching {
                    HapiJson.decodeFromJsonElement(Machine.serializer(), element)
                }.getOrNull()
                when {
                    machine != null -> upsert(machine)
                    element is JsonNull -> remove(event.machineId)
                    else -> {
                        val patch = MachinePatches.parse(element)
                        if (patch?.active == false) remove(event.machineId) else scheduleRefresh()
                    }
                }
            }
        }
    }

    /** Web `upsertMachine`: inactive rows are dropped, order preserved. */
    private fun upsert(machine: Machine) {
        updateMachines { list ->
            val index = list.indexOfFirst { it.id == machine.id }
            if (!machine.active) {
                if (index >= 0) list.toMutableList().also { it.removeAt(index) } else list
            } else {
                val next = list.toMutableList()
                if (index >= 0) next[index] = machine else next.add(machine)
                next
            }
        }
    }

    private fun remove(machineId: String) {
        updateMachines { list ->
            val next = list.filter { it.id != machineId }
            if (next.size == list.size) list else next
        }
    }

    private fun updateMachines(transform: (List<Machine>) -> List<Machine>) = list.update(transform)

    private companion object {
        const val REFRESH_BATCH_MS: Long = 16
    }
}

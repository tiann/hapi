package app.hapi.companion.feature.settings

import app.hapi.data.store.MachineListStore
import app.hapi.protocol.wire.Machine
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope

/** Transport seam over `PATCH /api/machines/:id` (fake in JVM tests). */
fun interface RenameMachineGateway {
    /**
     * An empty [displayName] clears the custom name back to the hostname
     * (hence no min-length). Throws on transport/hub failure.
     */
    suspend fun rename(machineId: String, displayName: String)
}

/** Row-level presentation helpers (web `useMachineLabels` + `machines.tsx`). */
object MachinesUi {

    /** Web `getMachineTitle`: displayName → host → id prefix (blank = skip). */
    fun title(machine: Machine): String =
        machine.metadata?.displayName?.takeIf { it.isNotEmpty() }
            ?: machine.metadata?.host?.takeIf { it.isNotEmpty() }
            ?: machine.id.take(8)

    /** Web subtitle: `[host, platform].filter(Boolean).join(' · ')`. */
    fun subtitle(machine: Machine): String? {
        val parts = listOfNotNull(
            machine.metadata?.host?.takeIf { it.isNotEmpty() },
            machine.metadata?.platform?.takeIf { it.isNotEmpty() },
        )
        return if (parts.isEmpty()) null else parts.joinToString(" · ")
    }
}

/** What a save attempt did (drives the row's edit/error state). */
sealed interface RenameOutcome {
    /** Renamed on the hub; the store was refreshed. */
    data object Saved : RenameOutcome

    /** Draft matched the stored name — no request was sent (web `save`). */
    data object Unchanged : RenameOutcome

    /** Rename failed; the row stays in edit mode with the error shown. */
    data object Failed : RenameOutcome
}

/**
 * Machines settings screen state (web `/settings/machines` twin): the live
 * machine list (in-memory [MachineListStore] — the hub only returns online
 * runners, and offline machines are dropped from the store on SSE) plus inline
 * rename. An unchanged draft short-circuits without a request; an empty name
 * clears the custom name back to the hostname; success refreshes the store
 * (web `invalidateQueries(queryKeys.machines)`).
 */
class MachinesViewModel(
    private val machineStore: MachineListStore,
    private val renameGateway: RenameMachineGateway,
    private val scope: CoroutineScope,
) {

    val machines = machineStore.machines

    init {
        // Fresh list on entry (web `useMachines` refetch); coalesced + silent.
        machineStore.scheduleRefresh()
    }

    /**
     * Saves [draft] for [machineId]. The comparison baseline is the stored
     * display name (not the title fallback), exactly like the web row.
     */
    suspend fun rename(machineId: String, draft: String): RenameOutcome {
        val machine = machines.value.firstOrNull { it.id == machineId }
        val next = draft.trim()
        if (machine != null && next == (machine.metadata?.displayName ?: "")) {
            return RenameOutcome.Unchanged
        }
        return try {
            renameGateway.rename(machineId, next)
            // The hub also pushes a machine-updated SSE; a direct refresh makes
            // the new name land immediately even when the event races or is
            // dropped. Best-effort: the rename itself already succeeded.
            runCatching { machineStore.refresh() }
            RenameOutcome.Saved
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Exception) {
            RenameOutcome.Failed
        }
    }
}

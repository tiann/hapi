package app.hapi.companion.feature.settings

import app.hapi.data.store.MachineListStore
import app.hapi.protocol.wire.Machine
import app.hapi.protocol.wire.MachineMetadata
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import app.hapi.protocol.wire.SyncEvent

// ------------------------------------------------------------------ fakes --

private class FakeMachineStore(initial: List<Machine> = emptyList()) : MachineListStore {
    val backing = MutableStateFlow(initial)
    override val machines: StateFlow<List<Machine>> = backing
    var refreshCalls = 0
    var scheduleRefreshCalls = 0
    var refreshFailure: Exception? = null

    override suspend fun refresh() {
        refreshCalls += 1
        refreshFailure?.let { throw it }
    }

    override fun scheduleRefresh() {
        scheduleRefreshCalls += 1
    }

    override fun applyMachineEvent(event: SyncEvent.MachineUpdated) {}
}

private class FakeRenameGateway : RenameMachineGateway {
    val calls = mutableListOf<Pair<String, String>>()
    var failure: Exception? = null

    override suspend fun rename(machineId: String, displayName: String) {
        calls += machineId to displayName
        failure?.let { throw it }
    }
}

private class MachinesHarness(testScope: TestScope) {
    val store = FakeMachineStore(
        listOf(
            machine(
                id = "m1",
                host = "devbox.local",
                platform = "darwin",
                displayName = "My laptop",
            ),
            machine(id = "m2", host = "server", platform = "linux"),
            machine(id = "m3"), // no metadata at all
        ),
    )
    val gateway = FakeRenameGateway()
    val viewModel = MachinesViewModel(
        machineStore = store,
        renameGateway = gateway,
        scope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScope.testScheduler)),
    )
}

private fun machine(
    id: String,
    host: String = "devbox",
    platform: String = "linux",
    displayName: String? = null,
    metadata: MachineMetadata? = MachineMetadata(
        host = host,
        platform = platform,
        happyCliVersion = "1.0.0",
        displayName = displayName,
    ),
): Machine = Machine(
    id = id,
    namespace = "default",
    seq = 1,
    createdAt = 1,
    updatedAt = 1,
    active = true,
    activeAt = 1,
    metadata = metadata,
    metadataVersion = 1,
    runnerState = null,
    runnerStateVersion = 1,
)

// ----------------------------------------------------------------- tests --

class MachinesViewModelTest {

    @Test
    fun `entry schedules a silent store refresh`() = runTest {
        val harness = MachinesHarness(this)
        assertEquals(1, harness.store.scheduleRefreshCalls)
    }

    @Test
    fun `rename sends the trimmed draft and refreshes the store`() = runTest {
        val harness = MachinesHarness(this)
        // Whitespace mirrors the web draft.trim() before compare/send.
        val outcome = harness.viewModel.rename("m1", "  Studio Mac  ")

        assertEquals(RenameOutcome.Saved, outcome)
        assertEquals(listOf("m1" to "Studio Mac"), harness.gateway.calls)
        assertEquals(1, harness.store.refreshCalls)
    }

    @Test
    fun `empty draft clears the custom name back to the hostname`() = runTest {
        val harness = MachinesHarness(this)

        assertEquals(RenameOutcome.Saved, harness.viewModel.rename("m1", ""))

        assertEquals(listOf("m1" to ""), harness.gateway.calls)
    }

    @Test
    fun `unchanged draft skips the request entirely`() = runTest {
        val harness = MachinesHarness(this)

        // Same as the stored display name → no request, editing just exits.
        assertEquals(RenameOutcome.Unchanged, harness.viewModel.rename("m1", "My laptop"))
        // A machine without a display name: empty draft = no change either.
        assertEquals(RenameOutcome.Unchanged, harness.viewModel.rename("m2", "  "))

        assertTrue(harness.gateway.calls.isEmpty())
        assertEquals(0, harness.store.refreshCalls)
    }

    @Test
    fun `draft matching the host but not the stored name still sends`() = runTest {
        val harness = MachinesHarness(this)
        // Web compares against displayName ("" here), never the host fallback.
        assertEquals(RenameOutcome.Saved, harness.viewModel.rename("m2", "server"))
        assertEquals(listOf("m2" to "server"), harness.gateway.calls)
    }

    @Test
    fun `gateway failure reports Failed without refreshing`() = runTest {
        val harness = MachinesHarness(this)
        harness.gateway.failure = RuntimeException("hub down")

        assertEquals(RenameOutcome.Failed, harness.viewModel.rename("m1", "new name"))

        assertEquals(0, harness.store.refreshCalls)
    }

    @Test
    fun `refresh failure after a successful rename still counts as Saved`() = runTest {
        val harness = MachinesHarness(this)
        harness.store.refreshFailure = RuntimeException("flaky")

        assertEquals(RenameOutcome.Saved, harness.viewModel.rename("m1", "new name"))
        assertEquals(listOf("m1" to "new name"), harness.gateway.calls)
    }

    @Test
    fun `unknown machine id still sends the request`() = runTest {
        val harness = MachinesHarness(this)
        // No baseline to compare against — the web row always has its machine,
        // but a vanished entry must not silently swallow an explicit save.
        assertEquals(RenameOutcome.Saved, harness.viewModel.rename("gone", "name"))
        assertEquals(listOf("gone" to "name"), harness.gateway.calls)
    }
}

class MachinesUiTest {

    @Test
    fun `title prefers display name then host then id prefix`() {
        assertEquals(
            "My laptop",
            MachinesUi.title(machine("m1", host = "devbox", displayName = "My laptop")),
        )
        assertEquals("devbox", MachinesUi.title(machine("m1", host = "devbox")))
        // Default host is "devbox" — drop it to reach the id-prefix fallback.
        assertEquals("abcdefgh", MachinesUi.title(machine("abcdefghijk", host = "")))
        // Blank strings fall through like the web's JS ||-chain.
        assertEquals("devbox", MachinesUi.title(machine("m1", host = "devbox", displayName = "")))
        assertEquals("abcdefgh", MachinesUi.title(machine("abcdefghijk", metadata = null)))
    }

    @Test
    fun `subtitle joins host and platform and drops blanks`() {
        assertEquals("devbox.local · darwin", MachinesUi.subtitle(machine("m1", host = "devbox.local", platform = "darwin")))
        assertEquals("devbox", MachinesUi.subtitle(machine("m1", host = "devbox", platform = "")))
        assertEquals(null, MachinesUi.subtitle(machine("m1", host = "", platform = "")))
        assertEquals(null, MachinesUi.subtitle(machine("m1", metadata = null)))
    }
}

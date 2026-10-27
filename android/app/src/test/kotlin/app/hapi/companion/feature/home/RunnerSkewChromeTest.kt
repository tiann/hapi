@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package app.hapi.companion.feature.home

import app.hapi.protocol.wire.Machine
import app.hapi.protocol.wire.MachineMetadata
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest

/** Runner version-skew banner state (slice C-②). */
class RunnerSkewChromeTest {

    private fun TestScope.chromeFor(machines: MutableStateFlow<List<Machine>>, restart: suspend (String) -> Unit = {}) =
        RunnerSkewChrome(
            machines = machines,
            restartRunner = restart,
            scope = backgroundScope,
            nowMs = { testScheduler.currentTime },
        )

    private fun machine(
        id: String,
        capabilities: List<String>?,
        host: String = "$id.local",
        displayName: String? = null,
        cliVersion: String = "0.30.7",
        startedCliMtimeMs: Long? = 100,
        installedCliMtimeMs: Long? = 100,
        supervisedRestart: Boolean? = false,
    ) = Machine(
        id = id,
        namespace = "ns",
        seq = 1,
        createdAt = 0,
        updatedAt = 0,
        active = true,
        activeAt = 0,
        metadata = MachineMetadata(
            host = host,
            platform = "darwin",
            happyCliVersion = cliVersion,
            displayName = displayName,
            capabilities = capabilities,
            startedCliMtimeMs = startedCliMtimeMs,
            installedCliMtimeMs = installedCliMtimeMs,
            supervisedRestart = supervisedRestart,
        ),
        metadataVersion = 1,
        runnerStateVersion = 1,
    )

    private val healthyCaps = listOf("agent-availability", "cursor-chat-store-status")

    @Test
    fun `friendlyRestartError surfaces the hub error field from embedded bodies`() {
        assertEquals(
            "runner restart is not available",
            friendlyRestartError("HTTP 503: {\"error\":\"runner restart is not available\",\"code\":\"UNAVAILABLE\"}"),
        )
        assertEquals("HTTP 500: not json", friendlyRestartError("HTTP 500: not json"))
        assertEquals("", friendlyRestartError(null))
    }

    @Test
    fun `rows list only skewed machines with host fallback and restart gating`() = runTest {
        val machines = MutableStateFlow(
            listOf(
                machine(
                    "old",
                    capabilities = null, // pre-capabilities runner: fully skewed
                    displayName = "Beefy Box",
                    startedCliMtimeMs = 100,
                    installedCliMtimeMs = 200,
                    supervisedRestart = true,
                ),
                machine("fine", capabilities = healthyCaps),
                machine(
                    "old-unsupervised",
                    capabilities = listOf("agent-availability"),
                    startedCliMtimeMs = 100,
                    installedCliMtimeMs = 100, // no newer binary yet
                    supervisedRestart = false,
                ),
            )
        )
        val chrome = chromeFor(machines)
        runCurrent()

        val state = chrome.state.value
        assertTrue(state.visible)
        assertEquals(
            listOf("Beefy Box", "old-unsupervised.local"),
            state.rows.map { it.host },
        )
        val first = state.rows[0]
        assertEquals("old", first.machineId)
        assertEquals("0.30.7", first.cliVersion)
        assertTrue(first.newerBinaryOnDisk)
        assertTrue(first.canRestart)
        val second = state.rows[1]
        assertFalse(second.newerBinaryOnDisk)
        assertFalse(second.canRestart, "restart needs newer-on-disk AND supervised")
    }

    @Test
    fun `nothing skewed hides the banner`() = runTest {
        val machines = MutableStateFlow(listOf(machine("fine", capabilities = healthyCaps)))
        val chrome = chromeFor(machines)
        runCurrent()
        assertFalse(chrome.state.value.visible)
    }

    @Test
    fun `minimize collapses to the chip and expand restores the card`() = runTest {
        val machines = MutableStateFlow(listOf(machine("old", capabilities = null)))
        val chrome = chromeFor(machines)
        runCurrent()
        assertFalse(chrome.state.value.minimized)
        chrome.minimize()
        runCurrent()
        assertTrue(chrome.state.value.minimized)
        assertTrue(chrome.state.value.visible, "minimized ≠ hidden: the chip stays")
        chrome.expand()
        runCurrent()
        assertFalse(chrome.state.value.minimized)
    }

    @Test
    fun `snooze hides for one hour then self-un-dismisses`() = runTest {
        val machines = MutableStateFlow(listOf(machine("old", capabilities = null)))
        val chrome = chromeFor(machines)
        runCurrent()
        assertTrue(chrome.state.value.visible)

        chrome.snooze()
        runCurrent()
        assertFalse(chrome.state.value.visible)

        advanceTimeBy(60 * 60_000)
        runCurrent()
        assertTrue(chrome.state.value.visible, "the snooze un-dismisses itself after the hour")
    }

    @Test
    fun `restart success clears busy and failure`() = runTest {
        val machines = MutableStateFlow(listOf(machine("old", capabilities = null)))
        val restarted = mutableListOf<String>()
        val chrome = chromeFor(machines) { id ->
            restarted += id
        }
        runCurrent()

        chrome.restart("old")
        runCurrent()
        assertEquals(listOf("old"), restarted)
        assertNull(chrome.state.value.restartError)
        assertFalse(chrome.state.value.rows.single().restarting)
    }

    @Test
    fun `restart failure surfaces the message and a busy restart ignores new calls`() = runTest {
        val machines = MutableStateFlow(listOf(machine("old", capabilities = null)))
        val release = CompletableDeferred<Unit>()
        val calls = mutableListOf<String>()
        val chrome = chromeFor(machines) { id ->
            calls += id
            release.await()
            throw IllegalStateException("runner not supervised")
        }
        runCurrent()

        chrome.restart("old")
        runCurrent()
        assertTrue(chrome.state.value.rows.single().restarting)

        chrome.restart("old") // busy: ignored
        runCurrent()
        assertEquals(listOf("old"), calls)

        release.complete(Unit)
        runCurrent()
        assertEquals("runner not supervised", chrome.state.value.restartError)
        assertFalse(chrome.state.value.rows.single().restarting)
    }
}

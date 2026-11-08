package app.hapi.protocol.wire

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Mirrors `shared/src/runnerCapabilities.test.ts`. */
class RunnerSkewTest {

    @Test
    fun `required capabilities are the two machine RPCs session creation depends on`() {
        assertEquals(
            listOf(RunnerSkew.CAPABILITY_AGENT_AVAILABILITY, RunnerSkew.CAPABILITY_CURSOR_CHAT_STORE_STATUS),
            RunnerSkew.REQUIRED_MACHINE_CAPABILITIES,
        )
    }

    @Test
    fun `missing or empty advertised capabilities are fully skewed`() {
        assertTrue(RunnerSkew.isMachineCapabilitySkewed(null))
        assertTrue(RunnerSkew.isMachineCapabilitySkewed(emptyList()))
        assertEquals(
            listOf("agent-availability", "cursor-chat-store-status"),
            RunnerSkew.missingRequiredCapabilities(emptyList()),
        )
    }

    @Test
    fun `advertising the required capabilities is not skewed even with extras`() {
        val advertised = listOf("agent-availability", "cursor-chat-store-status", "stop-runner")
        assertFalse(RunnerSkew.isMachineCapabilitySkewed(advertised))
        assertEquals(emptyList(), RunnerSkew.missingRequiredCapabilities(advertised))
    }

    @Test
    fun `a single missing capability is reported deterministically`() {
        assertEquals(
            listOf("cursor-chat-store-status"),
            RunnerSkew.missingRequiredCapabilities(listOf("agent-availability")),
        )
    }

    @Test
    fun `mtime drift detects a newer on-disk binary`() {
        assertTrue(RunnerSkew.cliBinaryUpdatedOnDisk(metadata(startedCliMtimeMs = 100, installedCliMtimeMs = 200)))
        assertFalse(RunnerSkew.cliBinaryUpdatedOnDisk(metadata(startedCliMtimeMs = 100, installedCliMtimeMs = 100)))
        assertFalse(RunnerSkew.cliBinaryUpdatedOnDisk(metadata(startedCliMtimeMs = 100, installedCliMtimeMs = null)))
        assertFalse(RunnerSkew.cliBinaryUpdatedOnDisk(metadata(startedCliMtimeMs = null, installedCliMtimeMs = 200)))
        assertFalse(RunnerSkew.cliBinaryUpdatedOnDisk(null))
    }

    private fun metadata(
        startedCliMtimeMs: Long?,
        installedCliMtimeMs: Long?,
    ) = MachineMetadata(
        host = "beefy-box",
        platform = "darwin",
        happyCliVersion = "0.30.7",
        startedCliMtimeMs = startedCliMtimeMs,
        installedCliMtimeMs = installedCliMtimeMs,
    )
}

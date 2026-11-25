package app.hapi.protocol.wire

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

/**
 * tiann/hapi#1404 on the list row: wire decoding, the strict `>` version gate
 * of web `patchSessionSummary`, render relevance and the row helpers.
 */
class AttachedJobTest {
    private val jobJson = """{"key":"import","label":"Import","status":"running","done":12,"total":30,""" +
        """"unit":"files","runId":"r1","wakeOnTerminal":true,"heartbeatAt":5000,"startedAt":1000,"updatedAt":5000}"""

    private fun element(json: String): JsonElement = Json.parseToJsonElement(json)

    private fun patch(json: String): SessionPatch = assertNotNull(SessionPatches.parse(element(json)))

    @Test
    fun `list rows decode jobs leniently`() {
        val row = """{"id":"s1","active":false,"attachedJob":$jobJson,"attachedJobUpdatedAt":7}"""
        val decoded = HapiJson.decodeFromString(SessionSummary.serializer(), row)
        assertEquals("Import", decoded.attachedJob?.label)
        assertEquals(true, decoded.attachedJob?.isRunning)
        assertEquals(7L, decoded.attachedJobUpdatedAt)

        val paused = HapiJson.decodeFromString(SessionSummary.serializer(), row.replace("\"running\"", "\"paused\""))
        assertEquals(false, paused.attachedJob?.isRunning, "A new status must not fail the list")

        val legacy = HapiJson.decodeFromString(SessionSummary.serializer(), """{"id":"s1","active":false}""")
        assertNull(legacy.attachedJob)
        assertEquals(0L, legacy.attachedJobUpdatedAt)
    }

    @Test
    fun `job patches parse instead of forcing a refetch`() {
        val parsed = patch("""{"attachedJob":{"version":5,"value":$jobJson}}""")
        assertEquals(5L, parsed.attachedJob?.version)
        assertEquals(12.0, parsed.attachedJob?.value?.done)
        assertNull(patch("""{"attachedJob":{"version":6,"value":null}}""").attachedJob?.value)
        assertNull(SessionPatches.parse(element("""{"attachedJob":{"version":6}}""")), "value key is required")
    }

    @Test
    fun `patches apply only when strictly newer`() {
        val empty = SessionSummary(id = "s1", active = false)
        val start = patch("""{"attachedJob":{"version":5,"value":$jobJson}}""")
        val running = SummaryPatching.applySessionSummaryPatch(empty, start)
        assertEquals(12.0, running.attachedJob?.done)
        assertEquals(5L, running.attachedJobUpdatedAt)
        assertFalse(SummaryPatching.isRenderIrrelevantPatch(empty, running))

        val cleared = SummaryPatching.applySessionSummaryPatch(running, patch("""{"attachedJob":{"version":6,"value":null}}"""))
        assertNull(cleared.attachedJob)
        assertEquals(6L, cleared.attachedJobUpdatedAt)

        // Dual SSE: a lagged heartbeat cannot resurrect the clear; an equal
        // version is a replay.
        assertNull(SummaryPatching.applySessionSummaryPatch(cleared, start).attachedJob)
        val heartbeat = running.attachedJob!!.copy(heartbeatAt = 9_000)
        val replay = SummaryPatching.applySessionSummaryPatch(running, SessionPatch(attachedJob = VersionedValue(5, heartbeat)))
        assertEquals(running, replay)
        val beat = SummaryPatching.applySessionSummaryPatch(running, SessionPatch(attachedJob = VersionedValue(7, heartbeat)))
        assertFalse(SummaryPatching.isRenderIrrelevantPatch(running, beat), "Heartbeats drive staleness")
        assertTrue(SummaryPatching.isRenderIrrelevantPatch(running, running.copy(activeAt = 99)))
    }

    @Test
    fun `row helpers match the web labels`() {
        val job = AttachedJob(key = "k", label = "Import", done = 12.0, total = 30.0, heartbeatAt = 0, startedAt = 0, updatedAt = 0)
        assertEquals(40, job.percent)
        assertEquals(0.4f, job.fraction)
        assertEquals(100, job.copy(done = 45.0).percent, "Capped")
        assertEquals(0.6f, job.copy(remaining = 12.0).fraction, "Remaining wins, as on web")
        assertNull(job.copy(total = null).percent)
        assertNull(job.copy(total = null).fraction, "No honest fraction: indeterminate bar")
        assertFalse(job.isStale(AttachedJob.STALE_AFTER_MS))
        assertTrue(job.isStale(AttachedJob.STALE_AFTER_MS + 1))

        assertEquals("<1m", formatCompactElapsed(59_999))
        assertEquals("5m", formatCompactElapsed(5 * 60_000L))
        assertEquals("3h 5m", formatCompactElapsed(3 * 3_600_000L + 5 * 60_000L))
        assertEquals("2h", formatCompactElapsed(2 * 3_600_000L))
        assertEquals("1d 2h", formatCompactElapsed(26 * 3_600_000L))
        assertEquals("12", formatJobQuantity(12.0))
        assertEquals("1.5", formatJobQuantity(1.5))
    }
}

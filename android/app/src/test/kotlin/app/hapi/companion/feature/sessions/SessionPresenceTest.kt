package app.hapi.companion.feature.sessions

import app.hapi.protocol.wire.AttachedJob
import app.hapi.protocol.wire.SessionSummary
import kotlin.test.Test
import kotlin.test.assertEquals

/** Web #2296 presence marks and the #1404 attached-job row line. */
class SessionPresenceTest {
    private val job = AttachedJob(key = "k", label = "Import", heartbeatAt = 0, startedAt = 0, updatedAt = 0)

    @Test
    fun `every state has its own mark and a running job is work`() {
        val idle = SessionSummary(id = "s", active = true)
        assertEquals(SessionPresence.Waiting, SessionPresence.of(idle))
        assertEquals(SessionPresence.Background, SessionPresence.of(idle.copy(backgroundTaskCount = 2)))
        assertEquals(SessionPresence.Working, SessionPresence.of(idle.copy(backgroundTaskCount = 2, thinking = true)), "A turn outranks background tasks")
        assertEquals(SessionPresence.Stopped, SessionPresence.of(idle.copy(active = false, thinking = true)), "Stale thinking is not work")
        assertEquals(SessionPresence.Stopped, SessionPresence.of(idle.copy(active = false, backgroundTaskCount = 1)))

        assertEquals(SessionPresence.Working, SessionPresence.of(idle.copy(active = false, attachedJob = job)), "Work that outlives the agent")
        assertEquals(SessionPresence.Background, SessionPresence.of(idle.copy(backgroundTaskCount = 1, attachedJob = job)), "Same precedence as web")
        assertEquals(SessionPresence.Stopped, SessionPresence.of(idle.copy(active = false, attachedJob = job.copy(status = "completed"))))
        assertEquals(listOf(true, true, false, false), SessionPresence.entries.map { it.pulses })
    }

    @Test
    fun `job line says progress and elapsed and admits staleness`() {
        val minute = 60_000L
        fun text(job: AttachedJob, now: Long) = attachedJobText(job, now, left = { "$it left" }, noHeartbeat = { "no heartbeat $it" })
        val counted = job.copy(done = 12.0, total = 30.0, unit = "files", heartbeatAt = 184 * minute)
        assertEquals("Import · 40% · 12/30 files · 3h 5m", text(counted, 185 * minute))
        assertEquals("Import · 18 files left · 5m", text(counted.copy(remaining = 18.0, heartbeatAt = 5 * minute), 5 * minute), "Remaining wins, as on web")
        assertEquals("Import · <1m", text(job, 0))
        assertEquals("Import · no heartbeat 20m", text(job, 20 * minute), "A frozen job is not passed off as live")
    }
}

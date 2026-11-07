package app.hapi.companion.feature.sessions

import app.hapi.protocol.wire.MachineHealth
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class MachineHealthUiTest {

    private fun health(cpu: Double? = null, mem: Double? = null) = MachineHealth(
        collectedAt = 1,
        cpuCount = 8,
        load1m = 1.0,
        cpuPercent = cpu,
        memoryPercent = mem,
        uptimeSeconds = 100.0,
    )

    @Test
    fun `formats cpu and memory percents with worst tone winning`() {
        // Thresholds mirror the web's percentTone: ≥ 90 critical, ≥ 75 warn.
        val warn = MachineHealthUi.present(health(cpu = 72.0, mem = 81.0))!!
        assertEquals("CPU 72% · Mem 81%", warn.label)
        assertEquals(MachineHealthUi.Tone.WARN, warn.tone)

        val critical = MachineHealthUi.present(health(cpu = 5.0, mem = 93.0))!!
        assertEquals("CPU 5% · Mem 93%", critical.label)
        assertEquals(MachineHealthUi.Tone.CRITICAL, critical.tone)

        val ok = MachineHealthUi.present(health(cpu = 12.0, mem = 45.0))!!
        assertEquals("CPU 12% · Mem 45%", ok.label)
        assertEquals(MachineHealthUi.Tone.OK, ok.tone)
    }

    @Test
    fun `cpu alone still presents and rounds toward zero`() {
        val cpuOnly = MachineHealthUi.present(health(cpu = 12.9))!!
        assertEquals("CPU 12%", cpuOnly.label)
        assertEquals(MachineHealthUi.Tone.OK, cpuOnly.tone)
        val memOnly = MachineHealthUi.present(health(mem = 75.4))!!
        assertEquals("Mem 75%", memOnly.label)
        assertEquals(MachineHealthUi.Tone.WARN, memOnly.tone)
    }

    @Test
    fun `boundary percents land on the web thresholds`() {
        assertEquals(MachineHealthUi.Tone.OK, MachineHealthUi.present(health(cpu = 74.9))!!.tone)
        assertEquals(MachineHealthUi.Tone.WARN, MachineHealthUi.present(health(cpu = 75.0))!!.tone)
        assertEquals(MachineHealthUi.Tone.WARN, MachineHealthUi.present(health(cpu = 89.9))!!.tone)
        assertEquals(MachineHealthUi.Tone.CRITICAL, MachineHealthUi.present(health(cpu = 90.0))!!.tone)
    }

    @Test
    fun `missing health or empty percents present nothing`() {
        assertNull(MachineHealthUi.present(null))
        assertNull(MachineHealthUi.present(health()))
        // Zero is a real reading (idle box), same as the web's
        // `cpuPercent !== undefined` check — it still presents.
        val idle = MachineHealthUi.present(health(cpu = 0.0))!!
        assertEquals("CPU 0%", idle.label)
        assertEquals(MachineHealthUi.Tone.OK, idle.tone)
    }
}

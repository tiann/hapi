package app.hapi.companion.feature.sessions

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.material3.MaterialTheme
import app.hapi.protocol.wire.MachineHealth

/**
 * Machine health for the filter sheet — the compact form of the web's
 * `presentMachineHealth` (`web/src/lib/machineHealth.ts`): the percent
 * metrics as one label with the reference's tone thresholds (≥ 75 warn,
 * ≥ 90 critical; worst tone wins). The desktop web shows this in a hover
 * tooltip and hides it on touch; the sheet row carries it as a secondary
 * line instead.
 */
object MachineHealthUi {

    enum class Tone { OK, WARN, CRITICAL }

    data class Presentation(
        /** `CPU 12% · Mem 45%`, matching the new-session picker's format. */
        val label: String,
        val tone: Tone,
    )

    fun present(health: MachineHealth?): Presentation? {
        if (health == null) return null
        val parts = mutableListOf<String>()
        var critical = false
        var warn = false
        for ((percent, prefix) in listOfNotNull(
            health.cpuPercent?.let { it to "CPU" },
            health.memoryPercent?.let { it to "Mem" },
        )) {
            parts += "$prefix ${percent.toInt()}%"
            when (tone(percent)) {
                Tone.CRITICAL -> critical = true
                Tone.WARN -> warn = true
                Tone.OK -> Unit
            }
        }
        if (parts.isEmpty()) return null
        val overall = when {
            critical -> Tone.CRITICAL
            warn -> Tone.WARN
            else -> Tone.OK
        }
        return Presentation(parts.joinToString(" · "), overall)
    }

    private fun tone(percent: Double): Tone = when {
        percent >= 90 -> Tone.CRITICAL
        percent >= 75 -> Tone.WARN
        else -> Tone.OK
    }
}

/** The web's `--app-badge-warning-text` slot: one amber across health chips. */
private val HealthWarn = Color(0xFFFF9F0A)

@Composable
internal fun healthToneColor(tone: MachineHealthUi.Tone): Color = when (tone) {
    MachineHealthUi.Tone.OK -> MaterialTheme.colorScheme.onSurfaceVariant
    MachineHealthUi.Tone.WARN -> HealthWarn
    MachineHealthUi.Tone.CRITICAL -> MaterialTheme.colorScheme.error
}

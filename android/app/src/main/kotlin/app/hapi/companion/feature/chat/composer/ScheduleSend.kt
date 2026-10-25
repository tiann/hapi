package app.hapi.companion.feature.chat.composer

import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.ResolverStyle
import java.util.Locale

/**
 * Scheduled-send domain (B-M16b) — the web `ScheduleTimePicker.tsx` /
 * `SessionChat.tsx` pending-schedule contract as pure functions, so the
 * preset set, send-time resolution, validation windows and edit restore are
 * unit-testable without Compose.
 *
 * web 同构/分歧:
 * - The preset set is exactly the web `PRESETS` — `+5m/+30m/+1h/+4h` (no
 *   `+15m`); the button labels are the raw preset strings, unlocalized,
 *   exactly like the web renders them.
 * - A preset stores only its key; the absolute time is computed at SEND time
 *   ([resolvePendingSchedule] with the send instant), so "+5m" means five
 *   minutes from the Send tap, not from the picker tap.
 * - Specific times validate with the web's 30 s past-grace (minute-resolution
 *   picks can go stale before Submit) and 7-day ceiling. The web's
 *   `datetime-local` min/max attributes are browser input affordances, not
 *   the gate — deliberately not mirrored; [validateSpecificDatetime] is the
 *   gate, like the web's real check.
 * - 分歧: the web blocks *file pastes* while a schedule is pending (the whole
 *   paste is dropped); the Android composer has no clipboard-file paste path,
 *   so nothing to block — the illegal combos are instead made unreachable via
 *   the tray gates (schedule button disabled with attachments, attach button
 *   disabled while pending), the same mutual exclusion the web enforces.
 */
sealed interface PendingSchedule {
    /** A relative preset key (`+5m`/`+30m`/`+1h`/`+4h`); resolved at send time. */
    data class Preset(val preset: String) : PendingSchedule

    /** A user-chosen instant, epoch ms; sent unchanged. */
    data class Absolute(val ms: Long) : PendingSchedule
}

/** Pure helpers around [PendingSchedule] (web `ScheduleTimePicker.tsx` twins). */
object ScheduleSend {
    /** The web `PRESETS` enumeration, order-stable. */
    val PRESETS: List<String> = listOf("+5m", "+30m", "+1h", "+4h")

    /** Past tolerance for specific picks (web `GRACE_MS`). */
    const val SPECIFIC_GRACE_MS: Long = 30_000

    /** Ceiling for any scheduled fire time (web: "must be within 7 days"). */
    const val MAX_SCHEDULE_MS: Long = 7L * 24 * 60 * 60 * 1000

    /** Web `parsePreset`: preset key → epoch ms against [now]. */
    fun parsePreset(preset: String, now: Long): Long = when (preset) {
        "+5m" -> now + 5 * 60_000L
        "+30m" -> now + 30 * 60_000L
        "+1h" -> now + 60 * 60_000L
        "+4h" -> now + 4 * 60 * 60_000L
        else -> throw IllegalArgumentException("Unknown preset: $preset")
    }

    /**
     * Web `resolvePendingSchedule`: pending → epoch ms at send time; null →
     * null. Presets resolve against [sendNow]; absolute picks pass through.
     */
    fun resolvePendingSchedule(pending: PendingSchedule?, sendNow: Long): Long? = when (pending) {
        null -> null
        is PendingSchedule.Preset -> parsePreset(pending.preset, sendNow)
        is PendingSchedule.Absolute -> pending.ms
    }

    /** Why a specific datetime was rejected (web `scheduleErrorPast`/`scheduleErrorTooFar`). */
    enum class SpecificError { Past, TooFar }

    /** Web `validateSpecificDatetime`: 30 s past-grace, 7-day ceiling, else null. */
    fun validateSpecificDatetime(value: Long, now: Long): SpecificError? {
        if (value < now - SPECIFIC_GRACE_MS) return SpecificError.Past
        if (value > now + MAX_SCHEDULE_MS) return SpecificError.TooFar
        return null
    }

    /**
     * Web `computeEditPendingSchedule` (queued-bar Edit): a future fire time
     * re-arms the composer as an absolute pick; past/null → null so the
     * re-send goes out immediately.
     */
    fun computeEditPendingSchedule(scheduledAt: Long?, now: Long): PendingSchedule? =
        if (scheduledAt == null || scheduledAt <= now) null else PendingSchedule.Absolute(scheduledAt)

    /** Web `shouldAutoClearPendingSchedule`: only absolute picks expire on the clock. */
    fun shouldAutoClearPendingSchedule(pending: PendingSchedule?): Boolean =
        pending is PendingSchedule.Absolute

    private val strictDate = DateTimeFormatter.ofPattern("uuuu-MM-dd").withResolverStyle(ResolverStyle.STRICT)
    private val clockTime = DateTimeFormatter.ofPattern("HH:mm")

    /**
     * Parse the two specific-tab fields (`YYYY-MM-DD` + `HH:mm`, the web's
     * `datetime-local` minute resolution split across two boxes) as local
     * wall time in [zone] → epoch ms. Strict date resolution (Feb 30 is
     * invalid, not adjusted); null on empty, malformed or impossible input
     * (web: `isNaN(parsed)` → ignore).
     */
    fun parseSpecificInput(dateText: String, timeText: String, zone: ZoneId): Long? {
        val date = runCatching { LocalDate.parse(dateText.trim(), strictDate) }.getOrNull() ?: return null
        val time = runCatching { LocalTime.parse(timeText.trim(), clockTime) }.getOrNull() ?: return null
        return date.atTime(time).atZone(zone).toInstant().toEpochMilli()
    }

    /**
     * Web `scheduledTime.ts#formatScheduledTime` twin: an absolute fire time
     * like "Oct 25, 2:30 PM"; the year appears only when it differs from the
     * current year in [zone]. Locale/zone/[now] injectable for tests.
     */
    fun formatScheduledTime(
        scheduledAt: Long,
        zone: ZoneId = ZoneId.systemDefault(),
        locale: Locale = Locale.getDefault(),
        now: () -> Long = System::currentTimeMillis,
    ): String {
        val fireTime = Instant.ofEpochMilli(scheduledAt).atZone(zone)
        val currentYear = Instant.ofEpochMilli(now()).atZone(zone).year
        val pattern = if (fireTime.year == currentYear) "MMM d, h:mm a" else "MMM d, yyyy, h:mm a"
        return fireTime.format(DateTimeFormatter.ofPattern(pattern, locale))
    }
}

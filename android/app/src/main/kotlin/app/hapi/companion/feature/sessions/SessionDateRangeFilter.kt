package app.hapi.companion.feature.sessions

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/**
 * Selected activity-date window: inclusive `[startEpochDay, endEpochDay]`
 * stored as ISO epoch days (zone-free). The filter window resolves against a
 * zone at match time (see [SessionDateRangeFilter]).
 */
data class SessionDateRange(
    /** First day of the window (inclusive). */
    val startEpochDay: Long,
    /** Last day of the window (inclusive; the millisecond window extends to the next local midnight). */
    val endEpochDay: Long,
)

/**
 * Web port of the session-list date-range filter (`SessionList.tsx`:
 * `parseLocalDate` / `getSessionTimeRange` / `sessionMatchesTimeRange` plus
 * the `sessionActivityDates` derivation).
 *
 * Window semantics: `[start local midnight, end local midnight + 1 day)` —
 * both endpoint days are fully included (the web picker's half-open
 * implementation of a closed `[start, end]` day range). All comparisons are
 * epoch-millisecond numeric; the zone only decides which instant is a day's
 * local midnight.
 *
 * Pure Kotlin so JVM tests cover the semantics without Compose.
 */
object SessionDateRangeFilter {
    private val DAY_PATTERN = Regex("^(\\d{4})-(\\d{2})-(\\d{2})$")

    /**
     * Strict `YYYY-MM-DD` parse. Returns null for anything off-pattern and —
     * mirroring the web's calendar round-trip check — for calendar-invalid
     * dates such as `2026-02-31` or `2025-02-29`. (Divergence: the web's
     * `Date` constructor remaps two-digit years to 19xx and thereby rejects
     * `00xx` years; ISO years 0-9999 are valid here.)
     */
    fun parseEpochDay(value: String): Long? {
        val match = DAY_PATTERN.find(value) ?: return null
        val (year, month, day) = match.destructured
        val localDate = runCatching {
            LocalDate.of(year.toInt(), month.toInt(), day.toInt())
        }.getOrNull() ?: return null
        return localDate.toEpochDay()
    }

    /** Machine-readable `YYYY-MM-DD` rendering (web `formatDateValue`). */
    fun formatEpochDay(epochDay: Long): String = LocalDate.ofEpochDay(epochDay).toString()

    /** Local-midnight epoch millis of [epochDay] in [zone]. */
    fun startMillis(epochDay: Long, zone: ZoneId): Long =
        LocalDate.ofEpochDay(epochDay).atStartOfDay(zone).toInstant().toEpochMilli()

    /**
     * Exclusive window end: the local midnight after the end day (web:
     * `endDate.setDate(endDate.getDate() + 1)` — a calendar-day jump, so DST
     * days resolve to 23/24/25-hour windows correctly).
     */
    fun endExclusiveMillis(epochDay: Long, zone: ZoneId): Long =
        LocalDate.ofEpochDay(epochDay).plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli()

    /**
     * `sessionMatchesTimeRange`: a null range keeps every session; otherwise
     * the session's `updatedAt` (hub-maintained last-activity timestamp) must
     * fall inside `[start midnight, end midnight + 1 day)`.
     */
    fun matches(
        updatedAtMillis: Long,
        range: SessionDateRange?,
        zone: ZoneId = ZoneId.systemDefault(),
    ): Boolean {
        if (range == null) return true
        val start = startMillis(range.startEpochDay, zone)
        val end = endExclusiveMillis(range.endEpochDay, zone)
        return updatedAtMillis >= start && updatedAtMillis < end
    }

    /**
     * Which local day an `updatedAt` timestamp falls on — the per-day key
     * behind the web's `sessionActivityDates` set. Zone defaults to the
     * device zone; tests pass a fixed zone.
     */
    fun activityEpochDay(
        updatedAtMillis: Long,
        zone: ZoneId = ZoneId.systemDefault(),
    ): Long = Instant.ofEpochMilli(updatedAtMillis).atZone(zone).toLocalDate().toEpochDay()
}

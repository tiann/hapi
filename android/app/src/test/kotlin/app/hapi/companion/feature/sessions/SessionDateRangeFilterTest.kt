package app.hapi.companion.feature.sessions

import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Web-parity fixtures — hand-derived from the epoch-day ladder:
 * - 1970-01-01 = epoch day 0
 * - 2024-01-01 = 19723 (1970..2023 = 54y · 365d + 13 leap days)
 * - 2024-02-29 = 19782 (19723 + 31 Jan + 28 into February)
 * - 2026-01-01 = 20454 (+ leap 2024's 366d + 2025's 365d)
 * - 2026-03-07 = 20519 (20454 + 31 + 28 + 6)
 * - 2026-03-08 = 20520 (US spring-forward Sunday, second of March 2026)
 * - 2026-10-05 = 20731 (20454 + 277: 31+28+31+30+31+30+31+31+30 + 4)
 * Milliseconds multiply an epoch day by 86_400_000.
 */
class SessionDateRangeFilterTest {
    private val utc = ZoneId.of("UTC")

    // ------------------------------------------------------------ parsing --

    @Test
    fun `parseEpochDay accepts strict padded calendar dates only`() {
        assertEquals(0L, SessionDateRangeFilter.parseEpochDay("1970-01-01"))
        assertEquals(20454L, SessionDateRangeFilter.parseEpochDay("2026-01-01"))
        assertEquals(20731L, SessionDateRangeFilter.parseEpochDay("2026-10-05"))
        // Leap day round trip (web validates by re-reading year/month/day).
        assertEquals(19782L, SessionDateRangeFilter.parseEpochDay("2024-02-29"))
        // Declared divergence: two-digit-millennium years are a JS Date remap
        // quirk on web (rejected there); ISO calendar truth accepts them here.
        assertEquals("0000-01-01", SessionDateRangeFilter.formatEpochDay(SessionDateRangeFilter.parseEpochDay("0000-01-01")!!))
    }

    @Test
    fun `parseEpochDay rejects pattern violations`() {
        for (value in listOf(
            "2026-1-05", "2026-10-5", "26-10-05", "2026/10/05", " 2026-10-05",
            "2026-10-05 ", "20261005", "", "2026-10-05T00:00", "x2026-10-05",
        )) {
            assertNull(SessionDateRangeFilter.parseEpochDay(value), "expected rejection: \"$value\"")
        }
    }

    @Test
    fun `parseEpochDay rejects calendar-invalid dates`() {
        for (value in listOf(
            "2026-13-01", "2026-00-15", // month bounds
            "2026-10-32", "2026-10-00", // day bounds
            "2026-02-30", "2026-02-31", // February overflow
            "2025-02-29", // non-leap year
        )) {
            assertNull(SessionDateRangeFilter.parseEpochDay(value), "expected rejection: \"$value\"")
        }
    }

    @Test
    fun `formatEpochDay mirrors web formatDateValue`() {
        assertEquals("2026-10-05", SessionDateRangeFilter.formatEpochDay(20731L))
        assertEquals("2024-02-29", SessionDateRangeFilter.formatEpochDay(19782L))
        assertEquals("1970-01-01", SessionDateRangeFilter.formatEpochDay(0L))
    }

    // -------------------------------------------------------------- match --

    @Test
    fun `matches treats the window as start-midnight inclusive to end-next-midnight exclusive`() {
        val range = SessionDateRange(startEpochDay = 20731L, endEpochDay = 20733L) // 2026-10-05..07
        val start = 20731L * 86_400_000L // 2026-10-05T00:00Z = 1_791_158_400_000
        val endExclusive = 20734L * 86_400_000L // 2026-10-08T00:00Z = 1_791_417_600_000
        assertTrue(SessionDateRangeFilter.matches(start, range, utc), "start-day midnight is included")
        assertFalse(SessionDateRangeFilter.matches(start - 1, range, utc), "before the window")
        assertTrue(SessionDateRangeFilter.matches(endExclusive - 1, range, utc), "last millisecond of the end day is included")
        assertFalse(SessionDateRangeFilter.matches(endExclusive, range, utc), "the midnight after the end day is excluded")
    }

    @Test
    fun `single-day range covers exactly one local day`() {
        val range = SessionDateRange(startEpochDay = 20731L, endEpochDay = 20731L)
        assertTrue(SessionDateRangeFilter.matches(20731L * 86_400_000L, range, utc))
        assertTrue(SessionDateRangeFilter.matches(20732L * 86_400_000L - 1, range, utc))
        assertFalse(SessionDateRangeFilter.matches(20731L * 86_400_000L - 1, range, utc))
        assertFalse(SessionDateRangeFilter.matches(20732L * 86_400_000L, range, utc))
    }

    @Test
    fun `null range keeps every session`() {
        assertTrue(SessionDateRangeFilter.matches(Long.MIN_VALUE, null, utc))
        assertTrue(SessionDateRangeFilter.matches(0L, null, utc))
        assertTrue(SessionDateRangeFilter.matches(Long.MAX_VALUE, null, utc))
    }

    @Test
    fun `inverted raw range matches nothing`() {
        // setDateRange normalizes picks, but the predicate stays total on raw data.
        val inverted = SessionDateRange(startEpochDay = 20733L, endEpochDay = 20731L)
        assertFalse(SessionDateRangeFilter.matches(20731L * 86_400_000L, inverted, utc))
        assertFalse(SessionDateRangeFilter.matches(20732L * 86_400_000L, inverted, utc))
        assertFalse(SessionDateRangeFilter.matches(20733L * 86_400_000L, inverted, utc))
    }

    @Test
    fun `matches anchors windows to the zone's own midnight`() {
        val shanghai = ZoneId.of("Asia/Shanghai") // UTC+8, no DST
        val range = SessionDateRange(startEpochDay = 20731L, endEpochDay = 20731L) // local day 2026-10-05
        // 2026-10-05T15:59:59.999Z = 23:59:59.999 +08 → inside the Shanghai day and the UTC day.
        assertTrue(SessionDateRangeFilter.matches(1_791_215_999_999L, range, shanghai))
        assertTrue(SessionDateRangeFilter.matches(1_791_215_999_999L, range, utc))
        // 2026-10-05T16:00:00Z = 2026-10-06T00:00 +08 → already past the Shanghai day…
        assertFalse(SessionDateRangeFilter.matches(1_791_216_000_000L, range, shanghai))
        // …while in UTC it is still midday of Oct 5 → the same instant, a different verdict.
        assertTrue(SessionDateRangeFilter.matches(1_791_216_000_000L, range, utc))
    }

    @Test
    fun `matches keeps the whole end day across a DST spring-forward`() {
        val newYork = ZoneId.of("America/New_York")
        // Range 2026-03-07..03-08; 03-08 springs forward at 02:00, so the
        // exclusive end is 2026-03-09T00:00-04:00 = 2026-03-09T04:00Z.
        val range = SessionDateRange(startEpochDay = 20519L, endEpochDay = 20520L)
        // Start edge: 2026-03-07T00:00-05:00 = 05:00Z on 03-07.
        assertTrue(SessionDateRangeFilter.matches(1_772_859_600_000L, range, newYork))
        // 2026-03-09T03:30Z = 23:30 EDT on 03-08 → inside.
        assertTrue(SessionDateRangeFilter.matches(1_773_027_000_000L, range, newYork))
        // Last millisecond before the end midnight → inside.
        assertTrue(SessionDateRangeFilter.matches(1_773_028_799_999L, range, newYork))
        // 2026-03-09T04:00:00Z = local midnight 03-09 → outside.
        assertFalse(SessionDateRangeFilter.matches(1_773_028_800_000L, range, newYork))
    }

    // ---------------------------------------------------- activity days --

    @Test
    fun `activityEpochDay maps a timestamp to its local day`() {
        val ts = 1_791_230_400_000L // 2026-10-05T20:00Z
        assertEquals(20731L, SessionDateRangeFilter.activityEpochDay(ts, utc)) // still Oct 5
        assertEquals(20732L, SessionDateRangeFilter.activityEpochDay(ts, ZoneId.of("Asia/Shanghai"))) // Oct 6, 04:00 +08
        assertEquals(20731L, SessionDateRangeFilter.activityEpochDay(ts, ZoneId.of("America/New_York"))) // Oct 5, 16:00 -04
    }

    @Test
    fun `epoch day helpers stay exact at day boundaries`() {
        assertNotNull(SessionDateRangeFilter.parseEpochDay("1970-01-01"))
        assertEquals(86_400_000L * 20731L, SessionDateRangeFilter.startMillis(20731L, utc))
        // +1 calendar day, not +86_400_000 of the start midnight (DST zones differ).
        assertEquals(
            SessionDateRangeFilter.startMillis(20520L + 1, ZoneId.of("America/New_York")),
            SessionDateRangeFilter.endExclusiveMillis(20520L, ZoneId.of("America/New_York")),
        )
    }
}

package app.hapi.companion.feature.chat.composer

import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import java.util.Locale
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Pure-logic tests for [ScheduleSend] (B-M16b). The preset set, send-time
 * resolution, validation windows, edit restore and formatter mirror the web
 * `ScheduleTimePicker.test.tsx` / `scheduledTime.test.ts` suites — including
 * the timezone boundaries where zone math (not local math) decides the answer.
 */
class ScheduleSendTest {

    // ------------------------------------------------------------ presets --

    @Test
    fun `the preset set is exactly the web four without plus 15m`() {
        assertEquals(listOf("+5m", "+30m", "+1h", "+4h"), ScheduleSend.PRESETS)
        assertFalse("+15m" in ScheduleSend.PRESETS)
    }

    @Test
    fun `parsePreset maps each key to its offset from now`() {
        val now = 1_000L
        assertEquals(now + 5 * 60_000L, ScheduleSend.parsePreset("+5m", now))
        assertEquals(now + 30 * 60_000L, ScheduleSend.parsePreset("+30m", now))
        assertEquals(now + 60 * 60_000L, ScheduleSend.parsePreset("+1h", now))
        assertEquals(now + 4 * 60 * 60_000L, ScheduleSend.parsePreset("+4h", now))
    }

    @Test
    fun `parsePreset rejects unknown keys loudly`() {
        assertFailsWith<IllegalArgumentException> { ScheduleSend.parsePreset("+15m", 0L) }
        assertFailsWith<IllegalArgumentException> { ScheduleSend.parsePreset("", 0L) }
    }

    // ---------------------------------------------------------- resolution --

    @Test
    fun `resolvePendingSchedule computes presets at the send instant not the pick instant`() {
        assertNull(ScheduleSend.resolvePendingSchedule(null, sendNow = 10_000L))
        // Picked at t=0, sent at t=10_000 → "+30m" anchors to the Send tap.
        assertEquals(
            10_000L + 30 * 60_000L,
            ScheduleSend.resolvePendingSchedule(PendingSchedule.Preset("+30m"), sendNow = 10_000L),
        )
    }

    @Test
    fun `resolvePendingSchedule passes absolute picks through unchanged`() {
        assertEquals(
            123_456L,
            ScheduleSend.resolvePendingSchedule(PendingSchedule.Absolute(123_456L), sendNow = 999L),
        )
    }

    // ----------------------------------------------------------- validation --

    @Test
    fun `specific datetimes tolerate exactly 30 seconds into the past`() {
        val now = 1_000_000L
        assertNull(ScheduleSend.validateSpecificDatetime(now, now))
        assertNull(ScheduleSend.validateSpecificDatetime(now - ScheduleSend.SPECIFIC_GRACE_MS, now))
        assertEquals(
            ScheduleSend.SpecificError.Past,
            ScheduleSend.validateSpecificDatetime(now - ScheduleSend.SPECIFIC_GRACE_MS - 1, now),
        )
    }

    @Test
    fun `specific datetimes cap at exactly 7 days out`() {
        val now = 1_000_000L
        assertNull(ScheduleSend.validateSpecificDatetime(now + ScheduleSend.MAX_SCHEDULE_MS, now))
        assertEquals(
            ScheduleSend.SpecificError.TooFar,
            ScheduleSend.validateSpecificDatetime(now + ScheduleSend.MAX_SCHEDULE_MS + 1, now),
        )
        assertEquals(7L * 24 * 60 * 60 * 1000, ScheduleSend.MAX_SCHEDULE_MS)
    }

    // ---------------------------------------------------------- edit restore --

    @Test
    fun `edit restore re-arms only strictly future fire times`() {
        assertEquals(
            PendingSchedule.Absolute(99_999L),
            ScheduleSend.computeEditPendingSchedule(99_999L, now = 1_000L),
        )
        // Boundary: exactly now is "past" (the web's `<= Date.now()` check).
        assertNull(ScheduleSend.computeEditPendingSchedule(1_000L, now = 1_000L))
        assertNull(ScheduleSend.computeEditPendingSchedule(999L, now = 1_000L))
        assertNull(ScheduleSend.computeEditPendingSchedule(null, now = 1_000L))
    }

    @Test
    fun `only absolute picks auto-clear on the clock`() {
        assertFalse(ScheduleSend.shouldAutoClearPendingSchedule(null))
        assertFalse(ScheduleSend.shouldAutoClearPendingSchedule(PendingSchedule.Preset("+5m")))
        assertTrue(ScheduleSend.shouldAutoClearPendingSchedule(PendingSchedule.Absolute(5L)))
    }

    // ------------------------------------------------------- specific parse --

    @Test
    fun `parseSpecificInput reads local wall time in the given zone`() {
        assertEquals(
            Instant.parse("2026-06-15T09:00:00Z").toEpochMilli(),
            ScheduleSend.parseSpecificInput("2026-06-15", "09:00", ZoneOffset.UTC),
        )
        // Same wall clock, different zone → a full 9-hour epoch shift.
        val utc = ScheduleSend.parseSpecificInput("2026-06-15", "09:00", ZoneOffset.UTC)
        val tokyo = ScheduleSend.parseSpecificInput("2026-06-15", "09:00", ZoneId.of("Asia/Tokyo"))
        assertEquals(9 * 60 * 60_000L, utc!! - tokyo!!)
    }

    @Test
    fun `parseSpecificInput is strict about calendars and shapes`() {
        // Feb 30 and non-leap Feb 29 are invalid dates, not adjusted.
        assertNull(ScheduleSend.parseSpecificInput("2026-02-30", "09:00", ZoneOffset.UTC))
        assertNull(ScheduleSend.parseSpecificInput("2027-02-29", "09:00", ZoneOffset.UTC))
        assertEquals(
            Instant.parse("2028-02-29T00:00:00Z").toEpochMilli(),
            ScheduleSend.parseSpecificInput("2028-02-29", "00:00", ZoneOffset.UTC),
        )
        // Malformed shapes and empties parse to null (web: isNaN → ignore).
        assertNull(ScheduleSend.parseSpecificInput("15/06/2026", "09:00", ZoneOffset.UTC))
        assertNull(ScheduleSend.parseSpecificInput("", "09:00", ZoneOffset.UTC))
        // "24:00" is java.time's ISO end-of-day alias for midnight — the
        // HTML time input can never type it, but a Number keyboard can; it
        // lands on the same date's 00:00, still behind the validation gate.
        assertEquals(
            Instant.parse("2026-06-15T00:00:00Z").toEpochMilli(),
            ScheduleSend.parseSpecificInput("2026-06-15", "24:00", ZoneOffset.UTC),
        )
        assertNull(ScheduleSend.parseSpecificInput("2026-06-15", "25:00", ZoneOffset.UTC))
        assertNull(ScheduleSend.parseSpecificInput("2026-06-15", "nine", ZoneOffset.UTC))
        assertNull(ScheduleSend.parseSpecificInput("2026-06-15", "", ZoneOffset.UTC))
        // Surrounding whitespace is tolerated like an input field's stragglers.
        assertEquals(
            Instant.parse("2026-06-15T09:00:00Z").toEpochMilli(),
            ScheduleSend.parseSpecificInput(" 2026-06-15 ", " 09:00 ", ZoneOffset.UTC),
        )
    }

    // ------------------------------------------------------------- format --

    @Test
    fun `formatScheduledTime matches the web label without the year in-year`() {
        val now = Instant.parse("2026-06-01T00:00:00Z").toEpochMilli()
        assertEquals(
            "Oct 25, 2:30 PM",
            ScheduleSend.formatScheduledTime(
                scheduledAt = Instant.parse("2026-10-25T14:30:00Z").toEpochMilli(),
                zone = ZoneOffset.UTC,
                locale = Locale.US,
                now = { now },
            ),
        )
    }

    @Test
    fun `formatScheduledTime appends the year only when it differs`() {
        val now = Instant.parse("2026-06-01T00:00:00Z").toEpochMilli()
        assertEquals(
            "Jan 5, 2027, 9:05 AM",
            ScheduleSend.formatScheduledTime(
                scheduledAt = Instant.parse("2027-01-05T09:05:00Z").toEpochMilli(),
                zone = ZoneOffset.UTC,
                locale = Locale.US,
                now = { now },
            ),
        )
    }

    @Test
    fun `formatScheduledTime year and wall time follow the zone`() {
        // 2026-12-31T23:30Z: still 2026 in UTC, already 2027 in Tokyo. The
        // current year is computed in the SAME zone, so only the Tokyo render
        // both shifts a day and needs the year.
        val now = Instant.parse("2026-01-01T00:00:00Z").toEpochMilli()
        val fire = Instant.parse("2026-12-31T23:30:00Z").toEpochMilli()
        assertEquals(
            "Dec 31, 11:30 PM",
            ScheduleSend.formatScheduledTime(fire, ZoneOffset.UTC, Locale.US, now = { now }),
        )
        assertEquals(
            "Jan 1, 2027, 8:30 AM",
            ScheduleSend.formatScheduledTime(fire, ZoneId.of("Asia/Tokyo"), Locale.US, now = { now }),
        )
    }
}

package app.hapi.data.sse

import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ReconnectPolicyTest {

    private object NoJitter : Random() {
        override fun nextBits(bitCount: Int): Int = 0
    }

    @Test
    fun `schedule follows the normative curve with the widened ceiling after 8 attempts`() {
        val delays = (0..11).map { ReconnectPolicy.delayForAttempt(it, NoJitter) }
        assertEquals(
            listOf(
                0L, 1_000L, 2_000L, 4_000L, 8_000L, 16_000L,
                30_000L, // attempt 6: 32s capped at 30s
                30_000L, // attempt 7: 64s capped at 30s
                128_000L, // attempt 8: cap widens to 300s, exponential takes over again
                256_000L,
                300_000L, // attempt 10: 512s capped at 300s
                300_000L,
            ),
            delays,
        )
    }

    @Test
    fun `jitter is uniform 0 to 500 inclusive and added to every delay`() {
        val seeded = Random(42)
        var sawNonZero = false
        repeat(500) { i ->
            val attempt = i % 12
            val base = ReconnectPolicy.delayForAttempt(attempt, NoJitter)
            val jittered = ReconnectPolicy.delayForAttempt(attempt, seeded)
            val jitter = jittered - base
            assertTrue(jitter in 0..500, "jitter $jitter out of range for attempt $attempt")
            if (jitter > 0) sawNonZero = true
        }
        assertTrue(sawNonZero, "seeded random never produced jitter — formula not applied")
    }

    @Test
    fun `huge attempt counts neither overflow nor exceed the slow ceiling`() {
        assertEquals(300_000L, ReconnectPolicy.delayForAttempt(64, NoJitter))
        assertEquals(300_000L, ReconnectPolicy.delayForAttempt(Int.MAX_VALUE, NoJitter))
    }

    @Test
    fun `constants pin the contract values`() {
        assertEquals(10_000L, ReconnectPolicy.CONNECT_TIMEOUT_MS)
        assertEquals(90_000L, ReconnectPolicy.STALE_MS)
        assertEquals(45_000L, ReconnectPolicy.RESUME_STALE_MS)
        assertEquals(10_000L, ReconnectPolicy.WATCHDOG_TICK_MS)
        assertEquals(1_000L, ReconnectPolicy.BASE_DELAY_MS)
        assertEquals(30_000L, ReconnectPolicy.MAX_DELAY_MS)
        assertEquals(500, ReconnectPolicy.JITTER_MS)
        assertEquals(8, ReconnectPolicy.SLOW_AFTER_ATTEMPTS)
        assertEquals(300_000L, ReconnectPolicy.SLOW_MAX_DELAY_MS)
    }
}

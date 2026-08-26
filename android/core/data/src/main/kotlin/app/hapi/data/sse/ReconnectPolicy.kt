package app.hapi.data.sse

import kotlin.random.Random

/**
 * The normative SSE reconnect constants and backoff schedule from
 * `docs/api/client-contract/sse.md` ("Reconnect policy") / the web reference
 * client (`web/src/hooks/useSSE.ts`). Pure — all randomness is injected so
 * tests can pin the exact schedule.
 */
object ReconnectPolicy {
    /** An attempt that has not completed the handshake in 10 s is hung — abandon it. */
    const val CONNECT_TIMEOUT_MS: Long = 10_000

    /** No frames of any kind (heartbeat included) for 90 s ⇒ tear down and reconnect. */
    const val STALE_MS: Long = 90_000

    /**
     * On app-foreground, a connection whose last frame is older than 45 s is
     * reconnected immediately: an OS suspend can kill the socket without any
     * error surfacing, and one missed 30 s heartbeat already means distrust.
     */
    const val RESUME_STALE_MS: Long = 45_000

    /** Staleness check interval. Checks are skipped while backgrounded. */
    const val WATCHDOG_TICK_MS: Long = 10_000

    const val BASE_DELAY_MS: Long = 1_000
    const val MAX_DELAY_MS: Long = 30_000
    /** Uniform 0..[JITTER_MS] (inclusive) added to every delay. */
    const val JITTER_MS: Int = 500
    /** After this many consecutive failures the ceiling widens to [SLOW_MAX_DELAY_MS]. */
    const val SLOW_AFTER_ATTEMPTS: Int = 8
    /** A hub unreachable for 8 straight attempts is usually down for hours. */
    const val SLOW_MAX_DELAY_MS: Long = 300_000

    /**
     * Delay before retry number `attempt` (0-based count of consecutive
     * failures so far, reset to 0 on every successful handshake):
     *
     * - attempt 0 → 0 ms exponential part (first retry is immediate, jitter only);
     * - attempt n ≥ 1 → `min(cap, 1000 · 2^(n-1))`, where the cap is 30 s and
     *   widens to 300 s once `n ≥ 8`;
     * - plus uniform jitter 0..500 ms on every delay.
     *
     * Schedule (jitter aside): 0, 1s, 2s, 4s, 8s, 16s, 30s, 30s, 128s, 256s,
     * 300s, 300s, …
     */
    fun delayForAttempt(attempt: Int, random: Random): Long {
        require(attempt >= 0) { "attempt must be >= 0, got $attempt" }
        val cap = if (attempt >= SLOW_AFTER_ATTEMPTS) SLOW_MAX_DELAY_MS else MAX_DELAY_MS
        val exponential = when {
            attempt == 0 -> 0L
            // 2^(n-1) would overflow / always exceed the cap long before n=63.
            attempt - 1 >= 20 -> cap
            else -> minOf(cap, BASE_DELAY_MS shl (attempt - 1))
        }
        return exponential + random.nextInt(JITTER_MS + 1)
    }
}

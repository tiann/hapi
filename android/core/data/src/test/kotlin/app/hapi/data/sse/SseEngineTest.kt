// advanceTimeBy / runCurrent are still marked experimental in coroutines-test.
@file:OptIn(ExperimentalCoroutinesApi::class)

package app.hapi.data.sse

import app.cash.turbine.test
import app.hapi.protocol.wire.SyncEvent
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest

private const val SESSION_REMOVED = """{"type":"session-removed","sessionId":"s-1"}"""

/** Deterministic jitter: `nextInt(501)` → 0, so delays equal the exponential part. */
private object ZeroRandom : Random() {
    override fun nextBits(bitCount: Int): Int = 0
}

private class Harness(
    testScope: TestScope,
    supplyToken: (forceRefresh: Boolean) -> String?,
    random: Random,
) {
    val transport = FakeSseTransport()
    val tokenCalls = mutableListOf<Boolean>()
    val engine = SseEngine(
        baseUrl = "https://hub.test",
        transport = transport,
        tokenProvider = { forceRefresh ->
            tokenCalls += forceRefresh
            supplyToken(forceRefresh)
        },
        scope = testScope.backgroundScope,
        nowMs = { testScope.testScheduler.currentTime },
        random = random,
    )

    /** Next connection attempt; suspending lets `runTest` auto-advance to it. */
    suspend fun awaitOpen(): FakeSseTransport.FakeConnection = transport.opened.receive()

    fun assertNoOpen() {
        assertTrue(transport.opened.tryReceive().isFailure, "expected no new connection attempt")
    }
}

private fun TestScope.harness(
    supplyToken: (forceRefresh: Boolean) -> String? = { "jwt-1" },
    random: Random = ZeroRandom,
): Harness = Harness(this, supplyToken, random)

class SseEngineTest {

    @Test
    fun `handshake emits resume verdict and subscription id after connection-changed`() = runTest {
        val h = harness()
        h.engine.events(SseSubscriptionKey.Global).test {
            h.engine.subscribe(SseSubscriptionKey.Global)
            val conn = h.awaitOpen()
            assertTrue(conn.url.startsWith("https://hub.test/api/events?"), conn.url)
            assertContains(conn.url, "token=jwt-1")
            assertContains(conn.url, "visibility=visible")
            assertContains(conn.url, "all=true")
            assertFalse(conn.url.contains("lastEventId"), "first connection carries no cursor")
            assertNull(conn.lastEventId)

            conn.handshake(resume = "ok", subscriptionId = "sub-42")
            val handshake = assertIs<EngineEvent.Handshake>(awaitItem())
            assertEquals("sub-42", handshake.subscriptionId)
            assertEquals(EngineEvent.Resume.Ok, handshake.resume)
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun `resume gap and absent resume field both read as Gap`() = runTest {
        val h = harness()
        h.engine.events(SseSubscriptionKey.Global).test {
            h.engine.subscribe(SseSubscriptionKey.Global)
            val conn1 = h.awaitOpen()
            conn1.handshake(resume = "gap")
            assertEquals(EngineEvent.Resume.Gap, assertIs<EngineEvent.Handshake>(awaitItem()).resume)
            conn1.fail(null)

            val conn2 = h.awaitOpen()
            conn2.handshake(resume = null) // older hubs omit the field entirely
            assertEquals(EngineEvent.Resume.Gap, assertIs<EngineEvent.Handshake>(awaitItem()).resume)
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun `nothing is processed before the handshake and dropped frames are not acknowledged`() = runTest {
        val h = harness()
        h.engine.events(SseSubscriptionKey.Global).test {
            h.engine.subscribe(SseSubscriptionKey.Global)
            val conn1 = h.awaitOpen()
            conn1.connect()
            // Contract-impossible (connection-changed is guaranteed first),
            // but a misbehaving hub must not leak events past the gate.
            conn1.event("pre-1", SESSION_REMOVED)
            runCurrent()
            expectNoEvents()

            conn1.handshake()
            assertIs<EngineEvent.Handshake>(awaitItem())
            conn1.fail(null)

            val conn2 = h.awaitOpen()
            assertNull(conn2.lastEventId, "a dropped frame must stay behind the cursor for redelivery")
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun `cursor is sent on reconnect and heartbeats leave it untouched`() = runTest {
        val h = harness()
        h.engine.events(SseSubscriptionKey.Global).test {
            h.engine.subscribe(SseSubscriptionKey.Global)
            val conn1 = h.awaitOpen()
            conn1.handshake()
            assertIs<EngineEvent.Handshake>(awaitItem())

            conn1.event("evt-1", SESSION_REMOVED)
            assertIs<SyncEvent.SessionRemoved>(assertIs<EngineEvent.Sync>(awaitItem()).event)
            conn1.heartbeat() // no id: sticky cursor, and no downstream emission
            runCurrent()
            expectNoEvents()
            conn1.fail(null)

            val conn2 = h.awaitOpen()
            assertEquals("evt-1", conn2.lastEventId)
            assertContains(conn2.url, "lastEventId=evt-1")
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun `an event still queued behind a busy downstream is never acknowledged`() = runTest {
        // The ack point is "emit returned": with the zero-buffer SharedFlow
        // that means every collector has taken the event into its collect
        // loop. A collector wedged processing evt-1 therefore blocks the
        // emit of evt-2, and the evt-2 cursor never advances — after the
        // watchdog kills the attempt, the hub replays from evt-1
        // (at-least-once; handlers must be idempotent per the contract).
        val h = harness()
        val gate = CompletableDeferred<Unit>()
        val seen = mutableListOf<EngineEvent>()
        backgroundScope.launch {
            h.engine.events(SseSubscriptionKey.Global).collect { event ->
                seen += event
                if (event is EngineEvent.Sync) {
                    gate.await() // wedge on the first sync event
                }
            }
        }
        runCurrent()
        h.engine.subscribe(SseSubscriptionKey.Global)
        val conn1 = h.awaitOpen()
        conn1.handshake()
        conn1.event("evt-1", SESSION_REMOVED) // handed off, wedges the collector
        runCurrent()
        conn1.event("evt-2", SESSION_REMOVED) // emit suspends behind the wedge
        runCurrent()

        advanceTimeBy(ReconnectPolicy.STALE_MS) // watchdog kills the wedged attempt
        runCurrent()
        val conn2 = h.awaitOpen()
        assertEquals("evt-1", conn2.lastEventId, "evt-2 was never handed off and must be redelivered")
        assertEquals(2, seen.size, "handshake + evt-1 only — evt-2 must not have reached downstream")
        gate.complete(Unit)
    }

    @Test
    fun `cursors are not shared across subscription keys`() = runTest {
        // No collectors on purpose: cursor bookkeeping must not depend on them.
        val h = harness()
        h.engine.subscribe(SseSubscriptionKey.Global)
        val globalConn = h.awaitOpen()
        h.engine.subscribe(SseSubscriptionKey.Session("s-7"))
        val sessionConn = h.awaitOpen()
        assertContains(globalConn.url, "all=true")
        assertContains(sessionConn.url, "sessionId=s-7")

        globalConn.handshake()
        sessionConn.handshake()
        globalConn.event("g-1", SESSION_REMOVED)
        sessionConn.event("s-1", SESSION_REMOVED)
        runCurrent()
        globalConn.fail(null)
        sessionConn.fail(null)

        val reopened = listOf(h.awaitOpen(), h.awaitOpen())
        val global2 = reopened.single { it.url.contains("all=true") }
        val session2 = reopened.single { it.url.contains("sessionId=s-7") }
        assertEquals("g-1", global2.lastEventId)
        assertEquals("s-1", session2.lastEventId)
    }

    @Test
    fun `heartbeats feed the watchdog and 90s of silence reconnects`() = runTest {
        val h = harness()
        h.engine.subscribe(SseSubscriptionKey.Global)
        val conn1 = h.awaitOpen()
        conn1.handshake()
        runCurrent()

        repeat(6) {
            advanceTimeBy(25_000)
            runCurrent()
            conn1.heartbeat()
            runCurrent()
        }
        h.assertNoOpen() // 150s elapsed, watchdog stayed fed

        advanceTimeBy(89_999)
        runCurrent()
        h.assertNoOpen() // silence, but still under the 90s threshold
        advanceTimeBy(1)
        runCurrent()
        val conn2 = h.awaitOpen()
        assertEquals(240_000L, testScheduler.currentTime) // last activity 150s + stale 90s
        assertTrue(conn1.closed)
        assertNull(conn2.lastEventId, "no id-bearing event was ever delivered")
    }

    @Test
    fun `connect timeout counts as a backoff failure`() = runTest {
        val h = harness()
        h.engine.subscribe(SseSubscriptionKey.Global)
        val conn1 = h.awaitOpen() // never reaches the handshake
        assertEquals(0L, testScheduler.currentTime)

        val conn2 = h.awaitOpen() // 10s connect deadline + attempt-0 delay (0)
        assertEquals(10_000L, testScheduler.currentTime)
        assertTrue(conn1.closed)

        h.awaitOpen() // second deadline + attempt-1 delay (1s)
        assertEquals(21_000L, testScheduler.currentTime)
        assertTrue(conn2.closed)
    }

    @Test
    fun `backoff schedule follows the normative curve including the widened ceiling`() = runTest {
        val h = harness()
        h.engine.subscribe(SseSubscriptionKey.Global)
        val openTimes = mutableListOf<Long>()
        repeat(13) {
            val conn = h.awaitOpen()
            openTimes += testScheduler.currentTime
            conn.fail(null)
        }
        val deltas = openTimes.zipWithNext { previous, next -> next - previous }
        assertEquals(
            listOf(
                0L, 1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 30_000L, 30_000L,
                128_000L, 256_000L, 300_000L, 300_000L,
            ),
            deltas,
        )
    }

    @Test
    fun `401 refreshes the token once per cycle without consuming a backoff attempt`() = runTest {
        val h = harness(supplyToken = { forceRefresh -> if (forceRefresh) "jwt-fresh" else "jwt-stale" })
        h.engine.subscribe(SseSubscriptionKey.Global)
        val conn1 = h.awaitOpen()
        assertContains(conn1.url, "token=jwt-stale")
        conn1.fail(401)

        val conn2 = h.awaitOpen() // immediate forced refresh, no backoff attempt spent
        assertEquals(0L, testScheduler.currentTime)
        assertContains(conn2.url, "token=jwt-fresh")
        conn2.fail(401) // second 401 in the same cycle: normal backoff path

        val conn3 = h.awaitOpen() // attempt 0 → immediate
        assertEquals(0L, testScheduler.currentTime)
        conn3.fail(401)

        h.awaitOpen() // attempt 1 → 1s (had the 401 consumed an attempt this would be 2s)
        assertEquals(1_000L, testScheduler.currentTime)
        assertEquals(listOf(false, true, false, false), h.tokenCalls)
    }

    @Test
    fun `background defers retries and foreground releases them immediately`() = runTest {
        val h = harness()
        h.engine.subscribe(SseSubscriptionKey.Global)
        val conn1 = h.awaitOpen()
        conn1.handshake()
        runCurrent()

        h.engine.setLifecycleForeground(false)
        conn1.fail(null)
        runCurrent()
        advanceTimeBy(600_000)
        runCurrent()
        h.assertNoOpen() // no retry is scheduled at all while backgrounded

        h.engine.setLifecycleForeground(true)
        runCurrent()
        h.awaitOpen()
        assertEquals(600_000L, testScheduler.currentTime) // released immediately, no backoff
    }

    @Test
    fun `foreground after 45s of silence forces a reconnect`() = runTest {
        val h = harness()
        h.engine.subscribe(SseSubscriptionKey.Global)
        val conn1 = h.awaitOpen()
        conn1.handshake()
        runCurrent()

        h.engine.setLifecycleForeground(false)
        runCurrent()
        advanceTimeBy(ReconnectPolicy.RESUME_STALE_MS)
        runCurrent()
        h.assertNoOpen() // stale checks are skipped while backgrounded

        h.engine.setLifecycleForeground(true)
        runCurrent()
        h.awaitOpen()
        assertEquals(45_000L, testScheduler.currentTime)
        assertTrue(conn1.closed)
    }

    @Test
    fun `foreground with fresh activity keeps the live connection open`() = runTest {
        val h = harness()
        h.engine.subscribe(SseSubscriptionKey.Global)
        val conn1 = h.awaitOpen()
        conn1.handshake()
        runCurrent()

        h.engine.setLifecycleForeground(false)
        runCurrent()
        advanceTimeBy(30_000) // under the 45s foreground-resume threshold
        runCurrent()
        h.engine.setLifecycleForeground(true)
        runCurrent()

        h.assertNoOpen()
        assertFalse(conn1.closed)
    }

    @Test
    fun `unknown event types are skipped without emission but acknowledged in the cursor`() = runTest {
        val h = harness()
        h.engine.events(SseSubscriptionKey.Global).test {
            h.engine.subscribe(SseSubscriptionKey.Global)
            val conn1 = h.awaitOpen()
            conn1.handshake()
            assertIs<EngineEvent.Handshake>(awaitItem())

            conn1.event("u-1", """{"type":"hologram-sync","sessionId":"s-1"}""")
            runCurrent()
            expectNoEvents() // no crash, no emission
            conn1.fail(null)

            val conn2 = h.awaitOpen()
            assertEquals("u-1", conn2.lastEventId, "redelivery cannot help an unknown type")
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun `undecodable frames are dropped without advancing the cursor`() = runTest {
        val h = harness()
        h.engine.events(SseSubscriptionKey.Global).test {
            h.engine.subscribe(SseSubscriptionKey.Global)
            val conn1 = h.awaitOpen()
            conn1.handshake()
            assertIs<EngineEvent.Handshake>(awaitItem())

            conn1.event("k-1", SESSION_REMOVED)
            assertIs<EngineEvent.Sync>(awaitItem())
            conn1.event("bad-1", """{not json at all""")
            runCurrent()
            expectNoEvents()
            conn1.fail(null)

            val conn2 = h.awaitOpen()
            assertEquals("k-1", conn2.lastEventId)
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun `subscribe is idempotent and unsubscribe tears down but keeps the cursor`() = runTest {
        val h = harness()
        h.engine.subscribe(SseSubscriptionKey.Global)
        h.engine.subscribe(SseSubscriptionKey.Global)
        val conn1 = h.awaitOpen()
        runCurrent()
        h.assertNoOpen() // at most one connection per key

        conn1.handshake()
        conn1.event("e-1", SESSION_REMOVED)
        runCurrent()

        h.engine.unsubscribe(SseSubscriptionKey.Global)
        runCurrent()
        assertTrue(conn1.closed)
        advanceTimeBy(600_000)
        runCurrent()
        h.assertNoOpen()

        h.engine.subscribe(SseSubscriptionKey.Global)
        val conn2 = h.awaitOpen()
        assertEquals("e-1", conn2.lastEventId, "per-key cursor survives unsubscribe/resubscribe")
    }

    @Test
    fun `null token is a failure that backs off until a token appears`() = runTest {
        var token: String? = null
        val h = harness(supplyToken = { token })
        h.engine.subscribe(SseSubscriptionKey.Global)
        runCurrent()
        h.assertNoOpen()
        // Attempt-0 retry is immediate, so two fetches happen at t=0; the
        // third waits for the attempt-1 backoff.
        assertEquals(listOf(false, false), h.tokenCalls)

        token = "jwt-late"
        advanceTimeBy(1_000)
        runCurrent()
        val conn = h.awaitOpen()
        assertEquals(1_000L, testScheduler.currentTime)
        assertContains(conn.url, "token=jwt-late")
    }
}

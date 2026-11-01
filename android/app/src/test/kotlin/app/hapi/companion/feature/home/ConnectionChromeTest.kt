@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package app.hapi.companion.feature.home

import app.cash.turbine.test
import app.hapi.data.sse.ConnectionFailure
import app.hapi.data.sse.DisconnectReason
import app.hapi.data.sse.OutageNotice
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest

/**
 * Banner state folding for the global connection chrome (slice C-①): the
 * engine-side grace/attribution is covered by `:core:data` tests — here the
 * outage flow is already post-grace, so these tests pin the chrome's own
 * contract: pass-through (with or without an attributed reason), syncing
 * debounce/cap, and syncing precedence.
 */
class ConnectionChromeTest {

    private fun TestScope.chromeFor(outage: MutableStateFlow<OutageNotice?>) = ConnectionChrome(
        globalOutageNotice = outage,
        scope = backgroundScope,
        nowMs = { currentTime },
    )

    @Test
    fun `attributed failures surface as the reconnecting notice and clear on recovery`() = runTest {
        val outage = MutableStateFlow<OutageNotice?>(null)
        val chrome = chromeFor(outage)
        chrome.notice.test {
            assertNull(awaitItem())
            val transport = ConnectionFailure(DisconnectReason.TransportError, 502)
            outage.value = OutageNotice(transport)
            assertEquals(GlobalConnectionNotice.Reconnecting(transport), awaitItem())
            outage.value = null
            assertNull(awaitItem())
        }
    }

    @Test
    fun `an outage without a reason still shows the reconnecting banner`() = runTest {
        val outage = MutableStateFlow<OutageNotice?>(null)
        val chrome = chromeFor(outage)
        chrome.notice.test {
            assertNull(awaitItem())
            // Auth-side outage: no transport attempt ever ran, so the engine
            // emits a visible outage with a null failure — the banner must
            // still show, reason-less (not collapse to no banner).
            outage.value = OutageNotice(null)
            assertEquals(GlobalConnectionNotice.Reconnecting(null), awaitItem())
        }
    }

    @Test
    fun `a sync shorter than the debounce never shows a banner`() = runTest {
        val outage = MutableStateFlow<OutageNotice?>(null)
        val chrome = chromeFor(outage)
        chrome.notice.test {
            assertNull(awaitItem())
            chrome.onResyncEvent(true)
            runCurrent()
            advanceTimeBy(299)
            runCurrent()
            expectNoEvents()
            chrome.onResyncEvent(false)
            advanceTimeBy(60_000)
            runCurrent()
            expectNoEvents()
        }
    }

    @Test
    fun `a long sync shows after the debounce and hides when it ends`() = runTest {
        val outage = MutableStateFlow<OutageNotice?>(null)
        val chrome = chromeFor(outage)
        chrome.notice.test {
            assertNull(awaitItem())
            chrome.onResyncEvent(true)
            advanceTimeBy(300)
            runCurrent()
            assertEquals(GlobalConnectionNotice.Syncing, awaitItem())
            chrome.onResyncEvent(false)
            runCurrent()
            assertNull(awaitItem())
        }
    }

    @Test
    fun `a stuck sync auto-clears after the cap`() = runTest {
        val outage = MutableStateFlow<OutageNotice?>(null)
        val chrome = chromeFor(outage)
        chrome.notice.test {
            assertNull(awaitItem())
            chrome.onResyncEvent(true)
            advanceTimeBy(300)
            runCurrent()
            assertEquals(GlobalConnectionNotice.Syncing, awaitItem())
            advanceTimeBy(10_000)
            runCurrent()
            assertNull(awaitItem(), "10 s safety cap: never a stuck spinner")
        }
    }

    @Test
    fun `syncing suppresses the reconnecting banner and it returns after the sync`() = runTest {
        val outage = MutableStateFlow<OutageNotice?>(null)
        val chrome = chromeFor(outage)
        chrome.notice.test {
            assertNull(awaitItem())
            val heartbeat = ConnectionFailure(DisconnectReason.HeartbeatTimeout)
            outage.value = OutageNotice(heartbeat)
            assertEquals(GlobalConnectionNotice.Reconnecting(heartbeat), awaitItem())

            chrome.onResyncEvent(true)
            advanceTimeBy(300)
            runCurrent()
            assertEquals(GlobalConnectionNotice.Syncing, awaitItem())

            chrome.onResyncEvent(false)
            runCurrent()
            assertEquals(
                GlobalConnectionNotice.Reconnecting(heartbeat),
                awaitItem(),
                "still disconnected: the reconnecting notice returns once the sync ends",
            )
            outage.value = null
            assertNull(awaitItem())
        }
    }

    @Test
    fun `a resync restart after the debounce keeps the banner up without blinking`() = runTest {
        val outage = MutableStateFlow<OutageNotice?>(null)
        val chrome = chromeFor(outage)
        chrome.notice.test {
            assertNull(awaitItem())
            chrome.onResyncEvent(true)
            advanceTimeBy(300)
            runCurrent()
            assertEquals(GlobalConnectionNotice.Syncing, awaitItem())
            // Second resync starts while the banner is already shown: the web
            // reshuffles timers with isSyncing staying true — no blink.
            chrome.onResyncEvent(true)
            advanceTimeBy(5_000)
            runCurrent()
            expectNoEvents()
            chrome.onResyncEvent(false)
            chrome.onResyncEvent(false)
            runCurrent()
            assertNull(awaitItem())
        }
    }

    @Test
    fun `overlapping syncs keep one episode and restart the debounce`() = runTest {
        val outage = MutableStateFlow<OutageNotice?>(null)
        val chrome = chromeFor(outage)
        chrome.notice.test {
            assertNull(awaitItem())
            chrome.onResyncEvent(true)
            advanceTimeBy(299)
            chrome.onResyncEvent(true) // second resync restarts the debounce
            runCurrent()
            advanceTimeBy(299)
            runCurrent()
            expectNoEvents() // 598 ms since the first start, 299 since the second
            advanceTimeBy(1)
            runCurrent()
            assertEquals(GlobalConnectionNotice.Syncing, awaitItem())

            chrome.onResyncEvent(false) // one of two ends: episode stays open
            runCurrent()
            advanceTimeBy(9_999)
            runCurrent()
            expectNoEvents() // banner still up: the episode is open, under the cap
            advanceTimeBy(1)
            runCurrent()
            assertNull(awaitItem()) // cap fires 10 s after the episode's last restart
            chrome.onResyncEvent(false) // the last resync ends: already cleared
            runCurrent()
            expectNoEvents()
        }
    }
}

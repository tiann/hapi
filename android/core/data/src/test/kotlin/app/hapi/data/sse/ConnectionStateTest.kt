@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package app.hapi.data.sse

import app.cash.turbine.test
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ConnectionStateTest {
    @Test fun `notice spans retry phases and clears only on recovery or lifecycle shutdown`() = runTest {
        val state = MutableStateFlow(ConnectionState())
        state.reconnectNotice { testScheduler.currentTime }.test {
            assertFalse(awaitItem())
            state.value = ConnectionState(ConnectionState.Phase.Backoff, 0)
            runCurrent()
            advanceTimeBy(2_000)
            state.value = ConnectionState(ConnectionState.Phase.Connecting, 0)
            runCurrent()
            advanceTimeBy(1_999)
            expectNoEvents()
            advanceTimeBy(1)
            runCurrent()
            assertTrue(awaitItem())
            state.value = ConnectionState(ConnectionState.Phase.Backoff, 0)
            runCurrent()
            expectNoEvents()
            state.value = ConnectionState(ConnectionState.Phase.Connected)
            assertFalse(awaitItem())
            state.value = ConnectionState(ConnectionState.Phase.Backoff, 4_000)
            advanceTimeBy(1_000)
            state.value = ConnectionState(ConnectionState.Phase.Suspended)
            advanceTimeBy(10_000)
            runCurrent()
            expectNoEvents()
        }
    }

    @Test fun `outage notice shares the grace window and carries the attributed failure`() = runTest {
        val state = MutableStateFlow(ConnectionState())
        state.reconnectOutageNotice { currentTime }.test {
            assertNull(awaitItem())
            val failure = ConnectionFailure(DisconnectReason.TransportError, 502)
            state.value = ConnectionState(ConnectionState.Phase.Backoff, 0, failure)
            runCurrent()
            advanceTimeBy(3_999)
            expectNoEvents()
            advanceTimeBy(1)
            runCurrent()
            assertEquals(OutageNotice(failure), awaitItem())

            // A same-start re-publish (Connecting) is not a new outage: the
            // already-emitted notice stands, no re-grace.
            state.value = ConnectionState(ConnectionState.Phase.Connecting, 0, failure)
            runCurrent()
            expectNoEvents()

            // Recovery clears the banner.
            state.value = ConnectionState(ConnectionState.Phase.Connected)
            assertNull(awaitItem())

            // Background suspension hides it even with a stale start stamp:
            // no Closed emission ever arrives (banner host is invisible).
            state.value = ConnectionState(ConnectionState.Phase.Suspended, 20_000, ConnectionFailure(DisconnectReason.Closed))
            advanceTimeBy(60_000)
            runCurrent()
            expectNoEvents()
        }
    }

    @Test fun `a null-reason outage still emits an outage notice after the grace`() = runTest {
        val state = MutableStateFlow(ConnectionState())
        state.reconnectOutageNotice { currentTime }.test {
            assertNull(awaitItem())
            // Auth-side outage: Backoff cycles with no transport failure
            // attributed (stale JWT, refresh failing before any attempt).
            state.value = ConnectionState(ConnectionState.Phase.Backoff, 0, null)
            runCurrent()
            advanceTimeBy(3_999)
            expectNoEvents()
            advanceTimeBy(1)
            runCurrent()
            assertEquals(OutageNotice(null), awaitItem())

            // A later attribution upgrades the label without a new grace.
            val failure = ConnectionFailure(DisconnectReason.TransportError, 503)
            state.value = ConnectionState(ConnectionState.Phase.Backoff, 0, failure)
            runCurrent()
            assertEquals(OutageNotice(failure), awaitItem())
        }
    }
}

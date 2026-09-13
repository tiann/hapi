@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package app.hapi.data.sse

import app.cash.turbine.test
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertFalse
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
}

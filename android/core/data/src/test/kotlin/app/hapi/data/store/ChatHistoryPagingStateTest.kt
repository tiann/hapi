package app.hapi.data.store

import app.hapi.protocol.window.OlderLoadOutcome
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import org.junit.Test

class ChatHistoryPagingStateTest {
    @Test fun `trimming revives exhaustion but never bypasses an explicit retry`() {
        val exhausted = ChatHistoryPagingState(phase = ChatHistoryPagingState.Phase.Exhausted)
        assertEquals(ChatHistoryPagingState.Phase.Idle, exhausted.refreshAvailability(true).phase)
        val paused = ChatHistoryPagingState(phase = ChatHistoryPagingState.Phase.Paused)
        assertEquals(paused, paused.refreshAvailability(true))
    }
    @Test fun `a page waits for layout before continuous demand can load again`() {
        var state = ChatHistoryPagingState().begin()
        assertEquals(state, state.begin())
        state = state.received(OlderLoadOutcome.Applied(3, true, 2), state.generation)
        assertEquals(state, state.begin())
        assertEquals(state, state.laidOut(2, true))
        state = state.laidOut(3, true)
        assertEquals(ChatHistoryPagingState.Phase.Loading, state.begin().phase)
    }

    @Test fun `two timed retries then manual retry`() {
        var state = ChatHistoryPagingState()
        for (delay in listOf(500L, 1500L)) {
            state = state.begin()
            state = state.received(OlderLoadOutcome.Failed(Exception()), state.generation)
            assertEquals(delay, state.retryDelayMillis)
            state = state.retryElapsed(state.generation)
        }
        state = state.begin()
        state = state.received(OlderLoadOutcome.Failed(Exception()), state.generation)
        assertEquals(ChatHistoryPagingState.Phase.Failed, state.phase)
        assertEquals(ChatHistoryPagingState.Phase.Idle, state.resume().phase)
    }

    @Test fun `hidden pages pause and cancellation poisons stale results`() {
        var state = ChatHistoryPagingState()
        for (version in 1L..3L) {
            state = state.begin()
            state = state.received(OlderLoadOutcome.Applied(version, true, 0), state.generation)
            state = state.laidOut(version, false)
        }
        assertEquals(ChatHistoryPagingState.Phase.Paused, state.phase)
        val old = state.generation
        state = state.cancel().begin()
        assertNotEquals(old, state.generation)
        assertEquals(state, state.received(OlderLoadOutcome.Applied(100, true, 1), old))
        assertEquals(state, state.retryElapsed(old))
    }
}

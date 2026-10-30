package app.hapi.companion.feature.chat

import app.hapi.data.api.ApiError
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * [messageHistoryActions] — the per-row fork/rewind gating port of the web
 * `UserMessage.tsx` / `AssistantMessage.tsx` formulas — plus the rewind
 * error-code helpers ([REWIND_FALLBACK_CODE] detection, `hydrateFailed`,
 * error formatting).
 */
class ConversationHistoryActionsTest {

    private val fullGate = ChatHistoryGate(
        forkCurrent = true,
        forkAtMessage = true,
        rewindToMessage = true,
        historyPoints = mapOf("lm-1" to true, "lm-2" to true),
        latestBoundaryKey = "user-text:u2",
        available = true,
        locked = false,
    )

    // ---------------------------------------------------------------- user --

    @Test
    fun `latest boundary user row with a native point offers fork current and rewind`() {
        // Web showRewind = rewindToMessage && hasNativePoint — no boundary
        // exclusion: rewinding to the last point lands on this same message.
        val actions = messageHistoryActions("user", "lm-2", "user-text:u2", fullGate)
        assertEquals(HistoryActionKind.ForkCurrent, actions.fork)
        assertTrue(actions.rewind)
    }

    @Test
    fun `latest boundary user row without a native point offers fork current only`() {
        val gate = fullGate.copy(historyPoints = mapOf("lm-1" to true))
        val actions = messageHistoryActions("user", "lm-2", "user-text:u2", gate)
        assertEquals(HistoryActionKind.ForkCurrent, actions.fork)
        assertFalse(actions.rewind)
    }

    @Test
    fun `older user row with a native point offers historical fork and rewind`() {
        val actions = messageHistoryActions("user", "lm-1", "user-text:u1", fullGate)
        assertEquals(HistoryActionKind.ForkAtMessage, actions.fork)
        assertTrue(actions.rewind)
    }

    @Test
    fun `user row without a native point offers neither fork-at nor rewind`() {
        val actions = messageHistoryActions("user", null, "user-text:u1", fullGate)
        assertNull(actions.fork)
        assertFalse(actions.rewind)
    }

    @Test
    fun `unlisted local id is not a native point`() {
        val actions = messageHistoryActions("user", "lm-9", "user-text:u1", fullGate)
        assertNull(actions.fork)
        assertFalse(actions.rewind)
    }

    @Test
    fun `rewind only is offered when fork capabilities are off`() {
        val gate = fullGate.copy(forkCurrent = false, forkAtMessage = false)
        val actions = messageHistoryActions("user", "lm-1", "user-text:u1", gate)
        assertNull(actions.fork)
        assertTrue(actions.rewind)
    }

    // ----------------------------------------------------------- assistant --

    @Test
    fun `assistant boundary row offers fork current only`() {
        val gate = fullGate.copy(latestBoundaryKey = "agent-text:a1")
        val actions = messageHistoryActions("assistant", "lm-1", "agent-text:a1", gate)
        assertEquals(HistoryActionKind.ForkCurrent, actions.fork)
        assertFalse(actions.rewind, "assistant rows never rewind (web parity)")
    }

    @Test
    fun `mid-run assistant row offers nothing`() {
        val gate = fullGate.copy(latestBoundaryKey = "agent-text:a1")
        val actions = messageHistoryActions("assistant", "lm-2", "agent-text:a2", gate)
        assertTrue(actions.isEmpty)
    }

    // ----------------------------------------------------------------- off --

    @Test
    fun `locked gate hides every action`() {
        val actions = messageHistoryActions("user", "lm-1", "user-text:u1", fullGate.copy(locked = true))
        assertTrue(actions.isEmpty)
    }

    @Test
    fun `unavailable gate hides every action`() {
        val actions = messageHistoryActions("user", "lm-1", "user-text:u1", fullGate.copy(available = false))
        assertTrue(actions.isEmpty)
    }

    @Test
    fun `default gate is fully off`() {
        assertFalse(ChatHistoryGate().enabled)
        assertTrue(messageHistoryActions("user", "lm-1", "user-text:u1", ChatHistoryGate()).isEmpty)
    }

    @Test
    fun `system role offers nothing`() {
        assertTrue(messageHistoryActions("system", "lm-1", "agent-event:e1", fullGate).isEmpty)
    }

    // ---------------------------------------------------------- error text --

    @Test
    fun `hub error string is preferred over the raw exception message`() {
        val error = ApiError(status = 409, code = "Session is busy", body = """{"error":"Session is busy"}""")
        assertEquals("Session is busy", formatHistoryActionError(error))
    }

    @Test
    fun `unparseable bodies fall back to the exception message`() {
        val error = ApiError(status = 500, body = "boom")
        assertEquals("HTTP 500: boom", formatHistoryActionError(error))
        assertEquals("plain", formatHistoryActionError(IllegalStateException("plain")))
        assertNull(formatHistoryActionError(IllegalStateException()))
    }

    // ------------------------------------------------ rewind error classes --

    @Test
    fun `fork-safe ambiguity is detected via the machine code`() {
        val error = ApiError(
            status = 409,
            code = REWIND_FALLBACK_CODE,
            body = """{"error":"Boundary ambiguous","code":"ambiguous_native_boundary_fork_safe"}""",
        )
        assertTrue(error.code == REWIND_FALLBACK_CODE)
        // Plain hub failures stay string-coded (no fallback dialog).
        assertFalse(ApiError(status = 409, code = "Session is busy").code == REWIND_FALLBACK_CODE)
    }

    @Test
    fun `hydrate failed marker is detected on a 500`() {
        val error = ApiError(
            status = 500,
            body = """{"error":"Rewind outcome unknown","hydrateFailed":true}""",
        )
        assertTrue(rewindHydrateFailed(error))
    }

    @Test
    fun `hydrate failed marker ignores other statuses and bodies`() {
        assertFalse(
            rewindHydrateFailed(
                ApiError(status = 409, body = """{"error":"busy","hydrateFailed":true}""")
            ),
        )
        assertFalse(rewindHydrateFailed(ApiError(status = 500, body = """{"error":"other"}""")))
        assertFalse(rewindHydrateFailed(IllegalStateException("offline")))
    }
}

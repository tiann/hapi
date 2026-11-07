package app.hapi.companion.feature.chat

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Derivation rules of the send-failure reopen card (web router.tsx gating). */
class SendFailureReopenCardTest {

    @Test
    fun `hidden without a failed inactive send`() {
        val card = SendFailureReopenCardLogic.derive(
            lastSendFailedInactive = false,
            sessionActive = false,
            reopenPending = false,
        )
        assertFalse(card.visible)
        assertFalse(card.reopenPending)
    }

    @Test
    fun `visible when the send failed inactive and the session stays inactive`() {
        val card = SendFailureReopenCardLogic.derive(
            lastSendFailedInactive = true,
            sessionActive = false,
            reopenPending = false,
        )
        assertTrue(card.visible)
        assertFalse(card.reopenPending)
    }

    @Test
    fun `hidden once the session is active again`() {
        val card = SendFailureReopenCardLogic.derive(
            lastSendFailedInactive = true,
            sessionActive = true,
            reopenPending = false,
        )
        assertFalse(card.visible)
    }

    @Test
    fun `pending only reported while visible`() {
        // Pending rides the card: an in-flight reopen must not leak through
        // once the session reflects active (or without a failed send).
        assertTrue(
            SendFailureReopenCardLogic.derive(true, false, reopenPending = true).reopenPending,
        )
        assertFalse(
            SendFailureReopenCardLogic.derive(true, true, reopenPending = true).reopenPending,
        )
        assertFalse(
            SendFailureReopenCardLogic.derive(false, false, reopenPending = true).reopenPending,
        )
    }
}

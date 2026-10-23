package app.hapi.protocol.window

import app.hapi.protocol.wire.DecryptedMessage
import app.hapi.protocol.wire.OptionalField
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * `markConsumed` steered-marker coverage (slice 6d, web
 * `markMessagesConsumed` steered gate): stamps on matched rows, defaults off,
 * skips failed rows, and re-stamps already-sent rows via the identity-changing
 * copy the ChatViewModel normalize cache relies on.
 */
class MessageWindowLogicTest {

    private fun queuedRow(
        localId: String,
        createdAt: Long = 1000,
        status: MessageStatus? = MessageStatus.Queued,
    ): WindowMessage = WindowMessage(
        wire = DecryptedMessage(
            id = localId,
            seq = null,
            localId = localId,
            createdAt = createdAt,
            invokedAt = OptionalField.Present(null),
            content = buildJsonObject {
                put("role", "user")
                put("content", buildJsonObject {
                    put("type", "text")
                    put("text", localId)
                })
            },
        ),
        status = status,
    )

    private fun stateOf(vararg rows: WindowMessage): MessageWindowState =
        MessageWindowState(sessionId = "s", messages = rows.toList())

    @Test
    fun `markConsumed stamps steered on matched rows`() {
        val row = queuedRow("l-1")
        val next = MessageWindowLogic.markConsumed(stateOf(row), listOf("l-1"), invokedAt = 900, steered = true)
        val stamped = next.messages.single()
        assertTrue(stamped.steered)
        assertEquals(MessageStatus.Sent, stamped.status)
        assertEquals(900L, stamped.invokedAtOrNull)
        // New instance — the ChatViewModel normalize cache identity check
        // (cached.source === message) must re-normalize and re-attach.
        assertFalse(stamped === row)
    }

    @Test
    fun `markConsumed without the steered flag leaves rows unmarked`() {
        val next = MessageWindowLogic.markConsumed(stateOf(queuedRow("l-1")), listOf("l-1"), invokedAt = 900)
        assertFalse(next.messages.single().steered)
        // A second steered pass is idempotent (needsSteered false → same row).
        val stamped = MessageWindowLogic.markConsumed(next, listOf("l-1"), invokedAt = 900, steered = true)
        assertTrue(stamped.messages.single().steered)
        val restamped = MessageWindowLogic.markConsumed(stamped, listOf("l-1"), invokedAt = 901, steered = true)
        assertTrue(restamped.messages.single().steered)
    }

    @Test
    fun `markConsumed skips failed rows for the steered marker too`() {
        val next = MessageWindowLogic.markConsumed(
            stateOf(queuedRow("l-1", status = MessageStatus.Failed)),
            listOf("l-1"),
            invokedAt = 900,
            steered = true,
        )
        val row = next.messages.single()
        assertEquals(MessageStatus.Failed, row.status)
        assertFalse(row.steered)
    }

    @Test
    fun `markConsumed stamps steered on an already-sent row`() {
        // needsStatus false and needsInvokedAt false, but needsSteered true —
        // the state must still change (a normal drain cannot resurrect this,
        // only a steered messages-consumed can).
        val sent = queuedRow("l-1").let { row ->
            row.copy(status = MessageStatus.Sent)
                .withInvokedAt(500)
        }
        val before = stateOf(sent)
        val next = MessageWindowLogic.markConsumed(before, listOf("l-1"), invokedAt = 900, steered = true)
        assertTrue(next.messages.single().steered)
        assertEquals(MessageStatus.Sent, next.messages.single().status)
        // Without the flag the same call is a no-op (early return, same state).
        val untouched = MessageWindowLogic.markConsumed(before, listOf("l-1"), invokedAt = 900)
        assertTrue(untouched === before)
    }
}

package app.hapi.protocol.window

import app.hapi.protocol.wire.DecryptedMessage
import app.hapi.protocol.wire.OptionalField
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Merge/retention edges the pagination fixtures deliberately avoid: full
 * position ties (the fixtures keep every `(at, seq)` pair distinct so the
 * web's `localeCompare` never decides an order — natives pin ASCII), the 10s
 * no-echo dedup fallback, invokedAt preservation across a stale refetch, and
 * the skippable/codex retention predicate.
 */
class MessageMergeTest {

    private fun userRow(
        id: String,
        createdAt: Long,
        localId: String? = null,
        seq: Long? = null,
        invokedAt: OptionalField<Long?> = OptionalField.Present(null),
        status: MessageStatus? = null,
        steered: Boolean = false,
    ): WindowMessage = WindowMessage(
        wire = DecryptedMessage(
            id = id,
            seq = seq,
            localId = localId,
            createdAt = createdAt,
            invokedAt = invokedAt,
            content = buildJsonObject {
                put("role", "user")
                put("content", buildJsonObject {
                    put("type", "text")
                    put("text", id)
                })
            },
        ),
        status = status,
        steered = steered,
    )

    @Test
    fun `full position ties break by ASCII id comparison`() {
        // 'B' (0x42) sorts before 'a' (0x61) in ASCII; locale-aware collation
        // (the web's localeCompare) would typically order them the other way.
        val rows = listOf(
            userRow("row-a", createdAt = 1000),
            userRow("row-B", createdAt = 1000),
        )
        val merged = MessageMerge.mergeMessages(emptyList(), rows)
        assertEquals(listOf("row-B", "row-a"), merged.map { it.id })
    }

    @Test
    fun `an optimistic sent row is dropped when a server user row lands within ten seconds`() {
        val optimistic = userRow(
            "local-1",
            createdAt = 10_000,
            localId = "local-1",
            status = MessageStatus.Sent,
        )
        // Server row WITHOUT a localId echo, 9 999 ms away by position.
        val server = userRow("srv-9", createdAt = 19_999, seq = 9, invokedAt = OptionalField.Absent)
        val merged = MessageMerge.mergeMessages(listOf(optimistic), listOf(server))
        assertEquals(listOf("srv-9"), merged.map { it.id })

        // At exactly 10 000 ms the fallback does not fire.
        val far = userRow("srv-far", createdAt = 20_000, seq = 10, invokedAt = OptionalField.Absent)
        val kept = MessageMerge.mergeMessages(listOf(optimistic), listOf(far))
        assertEquals(listOf("local-1", "srv-far"), kept.map { it.id })
    }

    @Test
    fun `a locally-known invokedAt survives a stale refetch of the same row`() {
        val stamped = userRow("srv-1", createdAt = 1000, seq = 1, invokedAt = OptionalField.Present(5000))
        val stale = userRow("srv-1", createdAt = 1000, seq = 1, invokedAt = OptionalField.Present(null))
        val merged = MessageMerge.mergeMessages(listOf(stamped), listOf(stale))
        assertEquals(5000L, merged.single().invokedAtOrNull)
    }

    @Test
    fun `merge preserves the steered marker when the incoming by-id copy lacks it`() {
        // Steered is live-only: a later server copy of the same row must not
        // wipe the badge marker (web messages.ts steered preservation).
        val steered = userRow("srv-1", createdAt = 1000, seq = 1, steered = true)
        val echo = userRow("srv-1", createdAt = 1000, seq = 1, invokedAt = OptionalField.Present(5000))
        val merged = MessageMerge.mergeMessages(listOf(steered), listOf(echo))
        assertTrue(merged.single().steered)

        // And never fabricates one on a plain re-fetch of an unsteered row.
        val plain = MessageMerge.mergeMessages(
            listOf(userRow("srv-2", createdAt = 1000, seq = 2)),
            listOf(userRow("srv-2", createdAt = 1000, seq = 2, invokedAt = OptionalField.Present(5000))),
        )
        assertTrue(!plain.single().steered)
    }

    @Test
    fun `merge carries steered from the optimistic row onto the replacing server echo`() {
        // The steered optimistic bubble (id == localId) is replaced by the
        // stored echo carrying the same localId but a server id.
        val steeredOptimistic = userRow(
            "local-1", createdAt = 1000, localId = "local-1",
            status = MessageStatus.Sent, steered = true,
        )
        val steeredEcho = userRow("srv-1", createdAt = 1000, localId = "local-1", seq = 1)
        val steeredResult = MessageMerge.mergeMessages(listOf(steeredOptimistic), listOf(steeredEcho))
        assertEquals(listOf("srv-1"), steeredResult.map { it.id })
        assertTrue(steeredResult.single().steered)

        // Control: a non-steered optimistic row's echo stays non-steered.
        val plainOptimistic = userRow(
            "local-2", createdAt = 2000, localId = "local-2",
            status = MessageStatus.Sent,
        )
        val plainEcho = userRow("srv-2", createdAt = 2000, localId = "local-2", seq = 2)
        val plainResult = MessageMerge.mergeMessages(listOf(plainOptimistic), listOf(plainEcho))
        assertEquals(listOf("srv-2"), plainResult.map { it.id })
        assertTrue(!plainResult.single().steered)
    }

    @Test
    fun `retention hides skippable output and unrenderable codex payloads only`() {
        fun agentContent(inner: kotlinx.serialization.json.JsonObject) = buildJsonObject {
            put("role", "agent")
            put("content", inner)
        }

        // Meta system output — hidden.
        assertTrue(
            !MessageRetention.isRenderable(agentContent(buildJsonObject {
                put("type", "output")
                put("data", buildJsonObject {
                    put("type", "system")
                    put("isMeta", true)
                })
            }))
        )
        // codex row with no message payload — hidden.
        assertTrue(
            !MessageRetention.isRenderable(agentContent(buildJsonObject {
                put("type", "codex")
                put("data", buildJsonObject { put("type", "unknown-kind") })
            }))
        )
        // codex text message — renderable.
        assertTrue(
            MessageRetention.isRenderable(agentContent(buildJsonObject {
                put("type", "codex")
                put("data", buildJsonObject {
                    put("type", "message")
                    put("message", "hi")
                })
            }))
        )
        // Unparseable envelope falls back to a stringify bubble — renderable.
        assertTrue(MessageRetention.isRenderable(buildJsonObject { put("whatever", 1) }))
    }
}

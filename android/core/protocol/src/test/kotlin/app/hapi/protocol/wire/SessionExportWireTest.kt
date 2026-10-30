package app.hapi.protocol.wire

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * `SessionExport` wire surface against `shared/src/sessionExport.ts`:
 * 200-body discrimination (payload vs warning), raw preservation, and the
 * strict 413 too-large body parser.
 */
class SessionExportWireTest {

    private val payloadBody = """
        {
          "schemaVersion": 2,
          "exportedAt": 1700000000123,
          "futureField": "extra",
          "session": {
            "id": "abcdefgh1234",
            "namespace": "test",
            "seq": 3,
            "createdAt": 1700000000000,
            "updatedAt": 1700000000000,
            "active": false,
            "metadataVersion": 1,
            "agentStateVersion": 1,
            "thinking": false,
            "thinkingAt": 0,
            "metadata": {
              "path": "/home/user/proj",
              "host": "mac",
              "name": "Fixture Sweep",
              "flavor": "claude"
            }
          },
          "messages": [
            {
              "id": "m1",
              "seq": 1,
              "createdAt": 1700000000000,
              "content": { "role": "user", "content": { "type": "text", "text": "hi" } }
            }
          ],
          "scratchlist": [
            {
              "entryId": "e1",
              "text": "note",
              "createdAt": 1700000001000,
              "updatedAt": 1700000001000,
              "attachments": [
                { "id": "a1", "filename": "n.txt", "mimeType": "text/plain", "size": 12, "path": "hapi-hub:scratchlist/a1" }
              ]
            }
          ]
        }
    """.trimIndent()

    @Test
    fun `constants mirror the shared module`() {
        assertEquals(2, SESSION_EXPORT_SCHEMA_VERSION)
        assertEquals(20_000, SESSION_EXPORT_MESSAGE_LIMIT)
        assertEquals(100L * 1024 * 1024, SESSION_EXPORT_MAX_BYTES)
        assertEquals("session_export_too_large", SESSION_EXPORT_TOO_LARGE_CODE)
    }

    @Test
    fun `payload body parses as Full keeping the raw element and unknown fields`() {
        val response = SessionExportResponse.parse(payloadBody)

        val full = assertIs<SessionExportResponse.Full>(response)
        assertEquals(2, full.export.schemaVersion)
        assertEquals(1_700_000_000_123L, full.export.exportedAt)
        assertEquals("abcdefgh1234", full.export.session.id)
        assertEquals("Fixture Sweep", full.export.session.metadata?.name)
        assertEquals(1, full.export.messages.size)
        assertEquals("m1", full.export.messages.single().id)
        assertEquals(1, full.export.scratchlist.size)
        assertEquals(12L, full.export.scratchlist.single().attachments.single().size)

        // The JSON outlet re-encodes the raw element, so a field this DTO set
        // does not model must survive the round trip.
        assertEquals("extra", full.raw.jsonObject["futureField"]?.jsonPrimitive?.content)
    }

    @Test
    fun `warning body parses as Warning with its three numbers`() {
        val response = SessionExportResponse.parse(
            """{"type":"warning","count":21000,"limit":20000,"estimatedBytes":12345678}""",
        )

        val warning = assertIs<SessionExportResponse.Warning>(response)
        assertEquals(SessionExportWarning(count = 21_000, limit = 20_000, estimatedBytes = 12_345_678), warning.warning)
    }

    @Test
    fun `non-object bodies are rejected loudly`() {
        assertFailsWith<SerializationException> { SessionExportResponse.parse("[1,2,3]") }
        assertFailsWith<SerializationException> { SessionExportResponse.parse(""""text"""") }
    }

    // -------------------------------------------------- too-large body parser --

    @Test
    fun `valid too-large body parses ignoring error and code`() {
        val parsed = SessionExportTooLarge.fromBody(
            """{"type":"too-large","error":"Session export too large","code":"session_export_too_large","count":30000,"estimatedBytes":123456789,"maxBytes":104857600}""",
        )
        assertEquals(SessionExportTooLarge(count = 30_000, estimatedBytes = 123_456_789L, maxBytes = 104_857_600L), parsed)
    }

    @Test
    fun `too-large parser rejects type mismatches`() {
        assertNull(SessionExportTooLarge.fromBody("""{"type":"warning","count":1,"estimatedBytes":2,"maxBytes":3}"""))
        assertNull(SessionExportTooLarge.fromBody("not json at all"))
    }

    @Test
    fun `too-large parser rejects missing or fractional numbers`() {
        assertNull(SessionExportTooLarge.fromBody("""{"type":"too-large","count":1,"estimatedBytes":2}"""))
        assertNull(SessionExportTooLarge.fromBody("""{"type":"too-large","count":"1","estimatedBytes":2,"maxBytes":3}"""))
        assertNull(SessionExportTooLarge.fromBody("""{"type":"too-large","count":1.5,"estimatedBytes":2,"maxBytes":3}"""))
    }

    @Test
    fun `too-large parser tolerates blank and null bodies`() {
        assertNull(SessionExportTooLarge.fromBody(null))
        assertNull(SessionExportTooLarge.fromBody(""))
        assertNull(SessionExportTooLarge.fromBody("   "))
    }

    @Test
    fun `Json-null content round trips through DecryptedMessage`() {
        // `content: null` is the legacy empty-message shape; decode must keep
        // it (the markdown serializer stringifies whatever it finds).
        val body = """
            {
              "schemaVersion": 2,
              "exportedAt": 0,
              "session": {
                "id": "s1", "namespace": "n", "seq": 1,
                "createdAt": 0, "updatedAt": 0, "active": false,
                "metadataVersion": 1, "agentStateVersion": 1,
                "thinking": false, "thinkingAt": 0
              },
              "messages": [ { "id": "m1", "createdAt": 0, "content": null } ]
            }
        """.trimIndent()
        val full = assertIs<SessionExportResponse.Full>(SessionExportResponse.parse(body))
        assertEquals(1, full.export.messages.size)
        assertEquals(JsonNull, full.export.messages.single().content)
    }
}

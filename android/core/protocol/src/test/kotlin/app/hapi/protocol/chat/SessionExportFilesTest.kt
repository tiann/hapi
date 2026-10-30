package app.hapi.protocol.chat

import app.hapi.protocol.wire.SessionExportResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * `SessionExportFiles.kt` against `web/src/lib/sessionExport/download.ts`:
 * format enum storage values, the slug + filename builder (including the
 * nullish-`??` title chain — deliberately different from the markdown
 * serializer's truthy chain), the size formatter, and artifact assembly with
 * the client-side byte cap.
 */
class SessionExportFilesTest {

    private fun payload(metadataJson: String): String = """
        {
          "schemaVersion": 2,
          "exportedAt": 1700000000123,
          "futureField": "extra",
          "session": {
            "id": "abcdefgh1234",
            "namespace": "test",
            "seq": 1,
            "createdAt": 1700000000000,
            "updatedAt": 1700000000000,
            "active": false,
            "metadataVersion": 1,
            "agentStateVersion": 1,
            "thinking": false,
            "thinkingAt": 0,
            "metadata": $metadataJson
          },
          "messages": [
            { "id": "m1", "createdAt": 1700000000000, "content": { "role": "user", "content": { "type": "text", "text": "hi" } } }
          ],
          "scratchlist": []
        }
    """.trimIndent()

    private fun export(metadataJson: String = """{ "path": "/p", "host": "h", "name": "Fixture Sweep" }""") =
        (SessionExportResponse.parse(payload(metadataJson)) as SessionExportResponse.Full)

    // -------------------------------------------------------------- slugify --

    @Test
    fun `slugify keeps lowercase digits and cjk collapses the rest`() {
        assertEquals("fixture-sweep", slugifySessionExportTitle("Fixture Sweep!"))
        assertEquals("fixture-sweep", slugifySessionExportTitle("  --Fixture..Sweep--  "))
        assertEquals("项目-repo", slugifySessionExportTitle("项目 Repo"))
        // Everything invalid → empty → the "session" fallback (web: `slug || 'session'`).
        assertEquals("session", slugifySessionExportTitle("/***"))
        assertEquals("session", slugifySessionExportTitle(""))
    }

    // ------------------------------------------------------------- filename --

    @Test
    fun `filename is slug shortId utcDate extension`() {
        val full = export()
        assertEquals(
            "fixture-sweep-abcdefgh-2023-11-14.json",
            buildSessionExportFilename(full.export, SessionExportFormat.JSON),
        )
        assertEquals(
            "fixture-sweep-abcdefgh-2023-11-14.md",
            buildSessionExportFilename(full.export, SessionExportFormat.MARKDOWN),
        )
    }

    @Test
    fun `filename title chain is nullish - empty name wins over summary`() {
        // `??` (not truthy): "" is a present value, so it is the title → slug fallback "session".
        val full = export(
            metadataJson = """{ "path": "/a/b/proj", "host": "h", "name": "", "summary": { "text": "Sum", "updatedAt": 0 } }""",
        )
        assertEquals("session-abcdefgh-2023-11-14.json", buildSessionExportFilename(full.export, SessionExportFormat.JSON))

        val noName = export(metadataJson = """{ "path": "/a/b/proj", "host": "h" }""")
        assertEquals("proj-abcdefgh-2023-11-14.json", buildSessionExportFilename(noName.export, SessionExportFormat.JSON))
    }

    @Test
    fun `long titles cap the slug at 80 characters before the id`() {
        val full = export(metadataJson = """{ "path": "/p", "host": "h", "name": "${"x".repeat(100)}" }""")
        val filename = buildSessionExportFilename(full.export, SessionExportFormat.JSON)
        assertEquals("x".repeat(80) + "-abcdefgh-2023-11-14.json", filename)
    }

    // ---------------------------------------------------------------- format --

    @Test
    fun `storage values map back losslessly with json as the fallback`() {
        assertEquals(SessionExportFormat.MARKDOWN, SessionExportFormat.fromStorageValue("markdown"))
        assertEquals(SessionExportFormat.JSON, SessionExportFormat.fromStorageValue("json"))
        assertEquals(SessionExportFormat.JSON, SessionExportFormat.fromStorageValue(null))
        assertEquals(SessionExportFormat.JSON, SessionExportFormat.fromStorageValue("bogus"))
        assertEquals("markdown", SessionExportFormat.MARKDOWN.storageValue)
        assertEquals("md", SessionExportFormat.MARKDOWN.extension)
        assertEquals("text/markdown", SessionExportFormat.MARKDOWN.mimeType)
        assertEquals("application/json", SessionExportFormat.JSON.mimeType)
    }

    // --------------------------------------------------------------- sizes --

    @Test
    fun `formatExportSize uses toFixed semantics`() {
        assertEquals("0 B", formatExportSize(0))
        assertEquals("512 B", formatExportSize(512))
        assertEquals("1.5 KiB", formatExportSize(1_536))
        assertEquals("2.0 KiB", formatExportSize(2_048))
        assertEquals("5.0 MiB", formatExportSize(5L * 1_024 * 1_024))
        assertEquals("3.0 GiB", formatExportSize(3L * 1_024 * 1_024 * 1_024))
        // Past GiB the loop stops climbing.
        assertEquals("2048.0 GiB", formatExportSize(2L * 1_024 * 1_024 * 1_024 * 1_024))
    }

    // ------------------------------------------------------------- artifact --

    @Test
    fun `json artifact pretty prints the raw element with a trailing newline`() {
        val full = export()

        val result = buildSessionExportArtifact(full.export, full.raw, SessionExportFormat.JSON)
        val ready = assertIs<SessionExportArtifactResult.Ready>(result)

        // Byte-parity with the web's `JSON.stringify(payload, null, 2) + '\n'`:
        // unknown fields and explicit nulls survive because the RAW element is
        // re-encoded, not the typed DTO.
        assertEquals(
            """
                {
                  "schemaVersion": 2,
                  "exportedAt": 1700000000123,
                  "futureField": "extra",
                  "session": {
                    "id": "abcdefgh1234",
                    "namespace": "test",
                    "seq": 1,
                    "createdAt": 1700000000000,
                    "updatedAt": 1700000000000,
                    "active": false,
                    "metadataVersion": 1,
                    "agentStateVersion": 1,
                    "thinking": false,
                    "thinkingAt": 0,
                    "metadata": {
                      "path": "/p",
                      "host": "h",
                      "name": "Fixture Sweep"
                    }
                  },
                  "messages": [
                    {
                      "id": "m1",
                      "createdAt": 1700000000000,
                      "content": {
                        "role": "user",
                        "content": {
                          "type": "text",
                          "text": "hi"
                        }
                      }
                    }
                  ],
                  "scratchlist": []
                }
            """.trimIndent() + "\n",
            ready.artifact.text,
        )
        assertEquals("fixture-sweep-abcdefgh-2023-11-14.json", ready.artifact.filename)
        assertEquals(1, ready.artifact.messageCount)
        assertEquals(ready.artifact.text.toByteArray(Charsets.UTF_8).size.toLong(), ready.artifact.byteCount)
    }

    @Test
    fun `markdown artifact serializes the readable document`() {
        val full = export()
        val result = buildSessionExportArtifact(full.export, full.raw, SessionExportFormat.MARKDOWN)
        val ready = assertIs<SessionExportArtifactResult.Ready>(result)

        assertEquals(SessionExportFormat.MARKDOWN, ready.artifact.format)
        assertEquals(serializeSessionMarkdown(full.export), ready.artifact.text)
        assertTrue("# Fixture Sweep" in ready.artifact.text.split('\n'))
        assertEquals("fixture-sweep-abcdefgh-2023-11-14.md", ready.artifact.filename)
    }

    @Test
    fun `artifacts over the byte cap report too-large with payload count`() {
        val full = export()
        val uncapped = assertIs<SessionExportArtifactResult.Ready>(
            buildSessionExportArtifact(full.export, full.raw, SessionExportFormat.JSON),
        )

        val result = buildSessionExportArtifact(
            full.export,
            full.raw,
            SessionExportFormat.JSON,
            maxBytes = 4, // far under the built text.
        )
        val tooLarge = assertIs<SessionExportArtifactResult.TooLarge>(result)
        assertEquals(1, tooLarge.count)
        assertEquals(4, tooLarge.maxBytes)
        // The reported size is the built artifact's exact byte count.
        assertEquals(uncapped.artifact.byteCount, tooLarge.estimatedBytes)
    }
}

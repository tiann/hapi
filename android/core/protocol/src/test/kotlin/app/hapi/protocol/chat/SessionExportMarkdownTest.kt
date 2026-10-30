package app.hapi.protocol.chat

import app.hapi.protocol.wire.SessionExportResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * `serializeSessionMarkdown` against a hand-computed fixture document — the
 * web twin is `web/src/lib/sessionExport/markdown.ts`. The fixture walks one
 * wire shape per block kind (user text+attachment, assistant
 * text/reasoning/tool-call, tool results, generated image, compact event,
 * summary, sidechain-style empty assistant) so every rendering branch is
 * pinned by exact expected bytes.
 */
class SessionExportMarkdownTest {

    private fun payload(metadataJson: String, messagesJson: String, scratchlistJson: String = "[]"): String = """
        {
          "schemaVersion": 2,
          "exportedAt": 1700000000123,
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
            "metadata": $metadataJson
          },
          "messages": [$messagesJson],
          "scratchlist": $scratchlistJson
        }
    """.trimIndent()

    private fun export(metadataJson: String, messagesJson: String, scratchlistJson: String = "[]") =
        (SessionExportResponse.parse(payload(metadataJson, messagesJson, scratchlistJson))
            as SessionExportResponse.Full).export

    // ------------------------------------------------------------- document --

    @Test
    fun `full document renders every section with exact bytes`() {
        val export = export(
            metadataJson = """
                {
                  "path": "/home/user/proj",
                  "host": "mac",
                  "name": "Fixture \"Sweep\" Run",
                  "flavor": "claude"
                }
            """.trimIndent(),
            messagesJson = """
                {
                  "id": "m1", "seq": 1, "createdAt": 1700000000000,
                  "content": {
                    "role": "user",
                    "content": {
                      "type": "text",
                      "text": "Please\nrun  the sweep",
                      "attachments": [
                        { "id": "f1", "filename": "data.csv", "mimeType": "text/csv", "size": 1200, "path": "/tmp/data.csv" }
                      ]
                    }
                  }
                },
                {
                  "id": "m2", "seq": 2, "createdAt": 1700000000500,
                  "content": {
                    "role": "agent",
                    "content": {
                      "type": "output",
                      "data": {
                        "type": "assistant",
                        "uuid": "u2",
                        "message": {
                          "model": "claude-3",
                          "content": [
                            { "type": "text", "text": "On it" },
                            { "type": "thinking", "thinking": "Plan the\nsweep" },
                            { "type": "tool_use", "id": "t1", "name": "Bash", "input": { "command": "ls", "timeout": 5 } }
                          ]
                        }
                      }
                    }
                  }
                },
                {
                  "id": "m3", "seq": 3, "createdAt": 1700000000600,
                  "content": {
                    "role": "agent",
                    "content": {
                      "type": "output",
                      "data": {
                        "type": "user",
                        "uuid": "u3",
                        "message": {
                          "content": [
                            { "type": "tool_result", "tool_use_id": "t1", "content": "exit 0\n(no  output)", "is_error": false },
                            { "type": "tool_result", "tool_use_id": "t2", "content": "", "is_error": false }
                          ]
                        }
                      }
                    }
                  }
                },
                {
                  "id": "m4", "seq": 4, "createdAt": 1700000000700,
                  "content": {
                    "role": "agent",
                    "content": {
                      "type": "codex",
                      "data": { "type": "generated-image", "id": "u4", "imageId": "img_1", "fileName": "sweep.png", "mimeType": "image/png" }
                    }
                  }
                },
                {
                  "id": "m5", "seq": 5, "createdAt": 1700000000800,
                  "content": {
                    "role": "agent",
                    "content": {
                      "type": "output",
                      "data": {
                        "type": "system",
                        "subtype": "compact_boundary",
                        "compactMetadata": { "trigger": "auto", "preTokens": 1000 }
                      }
                    }
                  }
                },
                {
                  "id": "m6", "seq": 6, "createdAt": 1700000000900,
                  "content": {
                    "role": "agent",
                    "content": { "type": "output", "data": { "type": "summary", "summary": "Swept the repo" } }
                  }
                },
                {
                  "id": "m7", "seq": 7, "createdAt": 1700000000950,
                  "content": {
                    "role": "agent",
                    "content": {
                      "type": "output",
                      "data": { "type": "assistant", "uuid": "u7", "message": { "model": "claude-3", "content": [] } }
                    }
                  }
                }
            """.trimIndent(),
            scratchlistJson = """
                [
                  {
                    "entryId": "e1",
                    "text": "Remember the milk",
                    "createdAt": 1700000001000,
                    "updatedAt": 1700000001000,
                    "attachments": [
                      { "id": "a1", "filename": "notes.txt", "mimeType": "text/plain", "size": 2048, "path": "hapi-hub:scratchlist/a1" }
                    ]
                  }
                ]
            """.trimIndent(),
        )

        val expected = """
            ---
            title: "Fixture \"Sweep\" Run"
            sessionId: "abcdefgh1234"
            exportedAt: "2023-11-14T22:13:20.123Z"
            messageCount: 7
            scratchlistCount: 1
            path: "/home/user/proj"
            host: "mac"
            agent: "claude"
            ---

            # Fixture "Sweep" Run

            Session: `abcdefgh1234`

            Exported: 2023-11-14T22:13:20.123Z

            ## Scratchlist

            ### Note

            _Time: 2023-11-14T22:13:21.000Z_

            Remember the milk

            - Attachment: notes.txt (text/plain, 2048 bytes)

            ## User

            _Time: 2023-11-14T22:13:20.000Z_

            Please
            run  the sweep

            - Attachment: data.csv (text/csv, 1200 bytes)

            ## Assistant

            _Time: 2023-11-14T22:13:20.500Z_

            On it

            > Reasoning: Plan the
            sweep

            - Tool: Bash — { "command": "ls", "timeout": 5 }

            ## Assistant

            _Time: 2023-11-14T22:13:20.600Z_

            - Tool result: exit 0 (no output)

            - Tool result

            ## Assistant

            _Time: 2023-11-14T22:13:20.700Z_

            - Generated image: sweep.png

            ## Event

            _Time: 2023-11-14T22:13:20.800Z_

            Conversation compacted

            ## Assistant

            _Time: 2023-11-14T22:13:20.900Z_

            > Summary: Swept the repo
        """.trimIndent() + "\n"

        assertEquals(expected, serializeSessionMarkdown(export))
    }

    // ------------------------------------------------------------- truncation --

    @Test
    fun `tool input collapses whitespace then truncates at 160`() {
        val export = export(
            metadataJson = """{ "path": "/p", "host": "h" }""",
            messagesJson = """
                {
                  "id": "m1", "createdAt": 0,
                  "content": {
                    "role": "agent",
                    "content": {
                      "type": "output",
                      "data": {
                        "type": "assistant",
                        "message": {
                          "content": [ { "type": "tool_use", "id": "t1", "name": "Grep", "input": { "q": "${"a".repeat(300)}" } } ]
                        }
                      }
                    }
                  }
                }
            """.trimIndent(),
        )

        val markdown = serializeSessionMarkdown(export)
        // `{\n  "q": "<300 a>"\n}` → collapse → `{ "q": "<300 a>" }` (311) → take(159) + …
        val expected = "- Tool: Grep — { \"q\": \"" + "a".repeat(151) + "…"
        assertTrue(expected in markdown.split('\n'), markdown)
    }

    @Test
    fun `tool result truncates at 240 and errors relabel`() {
        val export = export(
            metadataJson = """{ "path": "/p", "host": "h" }""",
            messagesJson = """
                {
                  "id": "m1", "createdAt": 0,
                  "content": {
                    "role": "agent",
                    "content": {
                      "type": "output",
                      "data": {
                        "type": "user",
                        "message": {
                          "content": [
                            { "type": "tool_result", "tool_use_id": "t1", "content": "${"b".repeat(300)}", "is_error": false },
                            { "type": "tool_result", "tool_use_id": "t2", "content": "${"c".repeat(300)}", "is_error": true }
                          ]
                        }
                      }
                    }
                  }
                }
            """.trimIndent(),
        )

        val markdown = serializeSessionMarkdown(export)
        val lines = markdown.split('\n')
        assertTrue("- Tool result: " + "b".repeat(239) + "…" in lines, markdown)
        assertTrue("- Tool error: " + "c".repeat(239) + "…" in lines, markdown)
    }

    // ---------------------------------------------------------- yaml escaping --

    @Test
    fun `front matter escapes backslash quote and newline in the title`() {
        // Title chars: a \ b " c LF d — YAML must escape all four.
        val export = export(
            // JSON-escaped name: `a\b"c<LF>d` → `a\\b\"c\nd` (raw string keeps the escapes verbatim).
            metadataJson = """{ "path": "/p", "host": "h", "name": "a\\b\"c\nd" }""",
            messagesJson = "",
        )

        val lines = serializeSessionMarkdown(export).split('\n')
        assertEquals("---", lines[0])
        assertEquals("""title: "a\\b\"c\nd"""", lines[1])
    }

    // -------------------------------------------------------------- title chain --

    @Test
    fun `title chain is truthy - empty name falls through to summary then path tail then id`() {
        val noMeta = export(metadataJson = "null", messagesJson = "")
        assertTrue("# abcdefgh" in serializeSessionMarkdown(noMeta).split('\n'))

        val emptyName = export(metadataJson = """{ "path": "/a/b/proj", "host": "h", "name": "", "summary": { "text": "Sum", "updatedAt": 0 } }""", messagesJson = "")
        assertTrue("# Sum" in serializeSessionMarkdown(emptyName).split('\n'))

        val pathOnly = export(metadataJson = """{ "path": "/a/b/proj", "host": "h", "summary": { "text": "", "updatedAt": 0 } }""", messagesJson = "")
        assertTrue("# proj" in serializeSessionMarkdown(pathOnly).split('\n'))
    }

    @Test
    fun `empty payloads render only the front matter and header`() {
        val export = export(metadataJson = """{ "path": "/p", "host": "h" }""", messagesJson = "")
        val markdown = serializeSessionMarkdown(export)

        assertEquals(
            """
                ---
                title: "p"
                sessionId: "abcdefgh1234"
                exportedAt: "2023-11-14T22:13:20.123Z"
                messageCount: 0
                scratchlistCount: 0
                path: "/p"
                host: "h"
                ---

                # p

                Session: `abcdefgh1234`

                Exported: 2023-11-14T22:13:20.123Z
            """.trimIndent() + "\n",
            markdown,
        )
        assertFalse("## Scratchlist" in markdown)
    }

    // ------------------------------------------------------------- timestamps --

    @Test
    fun `timestamps format as JS toISOString with millis`() {
        assertEquals("1970-01-01T00:00:00.000Z", formatExportTimestamp(0))
        assertEquals("2023-11-14T22:13:20.123Z", formatExportTimestamp(1_700_000_000_123))
        assertEquals("1969-12-31T23:59:59.999Z", formatExportTimestamp(-1))
        // Beyond the JS Date validity bound the web prints the raw number.
        assertEquals("9000000000000000", formatExportTimestamp(9_000_000_000_000_000))
        assertEquals("1970-01-01", formatExportDate(0))
        assertEquals("2023-11-14", formatExportDate(1_700_000_000_123))
    }
}

package app.hapi.data.store

import app.hapi.protocol.wire.ScratchlistAttachmentLimits
import app.hapi.protocol.wire.ScratchlistErrorCodes
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer

class ScratchlistStoreTest {

    private fun runScratchlistTest(
        invalidations: MutableSharedFlow<String>? = null,
        block: suspend TestScope.(ScratchlistStore, MockWebServer) -> Unit,
    ) = runTest {
        val server = MockWebServer()
        server.start()
        try {
            val store = ScratchlistStore(
                api = apiFor(server),
                scope = backgroundScope,
                invalidations = invalidations,
                now = { 111 },
                entryIdGenerator = { "opt-1" },
            )
            block(store, server)
        } finally {
            server.shutdown()
        }
    }

    private fun entryJson(
        id: String,
        text: String,
        createdAt: Long = 1,
        updatedAt: Long = 1,
        attachmentsJson: String? = null,
    ): String {
        val attachments = attachmentsJson?.let { ""","attachments":$it""" } ?: ""
        return """{"entryId":"$id","text":"$text","createdAt":$createdAt,"updatedAt":$updatedAt$attachments}"""
    }

    private fun entriesJson(vararg entries: String) = """{"entries":[${entries.joinToString(",")}]}"""

    private fun body(request: okhttp3.mockwebserver.RecordedRequest) =
        Json.parseToJsonElement(request.body.readUtf8()).jsonObject

    // ------------------------------------------------------------- fetching --

    @Test
    fun `open refreshes and loads entries (absent attachments default empty)`() =
        runScratchlistTest { store, server ->
            server.enqueueJson(entriesJson(entryJson("e1", "note one", updatedAt = 5)))

            store.open("s1")
            val state = store.state("s1").first { it.loaded }

            assertEquals(listOf("e1"), state.entries.map { it.entryId })
            assertEquals(emptyList(), state.entries.single().attachments)
            assertTrue(!state.atCap)
            val request = server.takeRequest()
            assertEquals("GET", request.method)
            assertEquals("/api/sessions/s1/scratchlist", request.path)
        }

    @Test
    fun `initial fetch failure lands in loadFailed until a retry succeeds`() =
        runScratchlistTest { store, server ->
            server.enqueueJson("""{"error":"boom"}""", code = 500)
            runCatching { store.refresh("s1") }
            assertTrue(store.currentState("s1").loadFailed)

            server.enqueueJson(entriesJson(entryJson("e1", "note")))
            store.refresh("s1")
            val state = store.currentState("s1")
            assertTrue(state.loaded)
            assertTrue(!state.loadFailed)
        }

    // --------------------------------------------------------------- create --

    @Test
    fun `create shows the optimistic row then reconciles with the canonical entry`() =
        runScratchlistTest { store, server ->
            server.enqueue(
                MockResponse()
                    .setResponseCode(201)
                    .setHeader("Content-Type", "application/json")
                    .setBody("""{"entry":${entryJson("opt-1", "note", createdAt = 111, updatedAt = 999)}}""")
                    .setBodyDelay(150, TimeUnit.MILLISECONDS),
            )

            val result = async { store.createEntry("s1", "  note  ") }
            // Optimistic row (client stamp 111) is visible before the hub answers.
            store.state("s1").first { st -> st.entries.any { it.entryId == "opt-1" && it.updatedAt == 111L } }

            assertIs<ScratchlistCreateResult.Created>(result.await())
            store.state("s1").first { st -> st.entries.singleOrNull()?.updatedAt == 999L }

            val request = server.takeRequest()
            assertEquals("POST", request.method)
            assertEquals("/api/sessions/s1/scratchlist", request.path)
            val sent = body(request)
            assertEquals("note", sent["text"]?.jsonPrimitive?.content)
            assertEquals("opt-1", sent["entryId"]?.jsonPrimitive?.content)
            assertEquals("111", sent["createdAt"]?.jsonPrimitive?.content)
        }

    @Test
    fun `create failure rolls the optimistic row back`() = runScratchlistTest { store, server ->
        server.enqueueJson("""{"error":"boom"}""", code = 500)

        val result = store.createEntry("s1", "doomed")

        assertIs<ScratchlistCreateResult.Failed>(result)
        assertTrue(store.currentState("s1").entries.isEmpty())
    }

    @Test
    fun `create 409 at_cap surfaces the friendly cap state without a ghost row`() =
        runScratchlistTest { store, server ->
            server.enqueueJson(
                """{"error":"Scratchlist is at its 200-entry cap","code":"${ScratchlistErrorCodes.AT_CAP}"}""",
                code = 409,
            )
            // The cap verdict schedules a reconcile refetch.
            server.enqueueJson(entriesJson())

            val result = store.createEntry("s1", "over the cap")

            assertEquals(ScratchlistCreateResult.AtCap, result)
            val state = store.currentState("s1")
            assertTrue(state.atCap)
            assertTrue(state.entries.none { it.entryId == "opt-1" })
        }

    @Test
    fun `local 200-entry cap short-circuits create without a request`() =
        runScratchlistTest { store, server ->
            val full = (1..200).map { entryJson("e$it", "n$it") }
            server.enqueueJson(entriesJson(*full.toTypedArray()))
            store.refresh("s1")
            assertTrue(store.currentState("s1").atCap)

            val result = store.createEntry("s1", "one too many")

            assertEquals(ScratchlistCreateResult.AtCap, result)
            assertEquals(1, server.requestCount)
        }

    // --------------------------------------------------------------- update --

    @Test
    fun `update applies optimistically and reconciles with the canonical row`() =
        runScratchlistTest { store, server ->
            server.enqueueJson(entriesJson(entryJson("e1", "old", updatedAt = 1)))
            store.refresh("s1")
            server.enqueueJson("""{"entry":${entryJson("e1", "new", updatedAt = 999)}}""")

            assertTrue(store.updateEntry("s1", "e1", text = "new"))

            val entry = store.currentState("s1").entries.single()
            assertEquals("new", entry.text)
            assertEquals(999, entry.updatedAt)
            server.takeRequest() // initial GET
            val request = server.takeRequest()
            assertEquals("PUT", request.method)
            assertEquals("/api/sessions/s1/scratchlist/e1", request.path)
            assertEquals("new", body(request)["text"]?.jsonPrimitive?.content)
        }

    @Test
    fun `update failure restores the previous row`() = runScratchlistTest { store, server ->
        server.enqueueJson(entriesJson(entryJson("e1", "old", updatedAt = 7)))
        store.refresh("s1")
        server.enqueueJson("""{"error":"boom"}""", code = 500)

        assertTrue(!store.updateEntry("s1", "e1", text = "new"))

        val entry = store.currentState("s1").entries.single()
        assertEquals("old", entry.text)
        assertEquals(7, entry.updatedAt)
    }

    @Test
    fun `update 404 drops the row deleted elsewhere`() = runScratchlistTest { store, server ->
        server.enqueueJson(entriesJson(entryJson("e1", "old")))
        store.refresh("s1")
        server.enqueueJson("""{"error":"Scratchlist entry not found"}""", code = 404)
        // 404 schedules a reconcile refetch.
        server.enqueueJson(entriesJson())

        assertTrue(!store.updateEntry("s1", "e1", text = "new"))
        assertTrue(store.currentState("s1").entries.isEmpty())
    }

    // --------------------------------------------------------------- delete --

    @Test
    fun `delete removes optimistically and restores at the same position on failure`() =
        runScratchlistTest { store, server ->
            server.enqueueJson(entriesJson(entryJson("e1", "first"), entryJson("e2", "second")))
            store.refresh("s1")
            server.enqueueJson("""{"error":"boom"}""", code = 500)

            assertTrue(!store.deleteEntry("s1", "e1"))

            assertEquals(listOf("e1", "e2"), store.currentState("s1").entries.map { it.entryId })
        }

    @Test
    fun `delete 404 counts as success`() = runScratchlistTest { store, server ->
        server.enqueueJson(entriesJson(entryJson("e1", "gone soon")))
        store.refresh("s1")
        server.enqueueJson("""{"error":"Scratchlist entry not found"}""", code = 404)

        assertTrue(store.deleteEntry("s1", "e1"))
        assertTrue(store.currentState("s1").entries.isEmpty())
    }

    // ------------------------------------------------------ SSE invalidation --

    @Test
    fun `scratchlistUpdatedAt signal refetches observed sessions only`() {
        val invalidations = MutableSharedFlow<String>(extraBufferCapacity = 8)
        runScratchlistTest(invalidations) { store, server ->
            server.enqueueJson(entriesJson(entryJson("e1", "note")))
            store.open("s1")
            store.state("s1").first { it.loaded }

            // Signal for the observed session → refetch picks up the new entry.
            server.enqueueJson(entriesJson(entryJson("e1", "note"), entryJson("e2", "from another device")))
            invalidations.emit("s1")
            store.state("s1").first { st -> st.entries.any { it.entryId == "e2" } }
            assertEquals(2, server.requestCount)

            // Signals for unobserved sessions are ignored.
            invalidations.emit("s2")
            advanceUntilIdle()
            assertEquals(2, server.requestCount)

            // Released sessions stop refetching too.
            store.release("s1")
            invalidations.emit("s1")
            advanceUntilIdle()
            assertEquals(2, server.requestCount)
        }
    }

    // ---------------------------------------------------------- attachments --

    @Test
    fun `upload reports in-flight progress and returns the stored attachment`() =
        runScratchlistTest { store, server ->
            server.enqueue(
                MockResponse()
                    .setHeader("Content-Type", "application/json")
                    .setBody(
                        """{"success":true,"attachment":{"id":"a1","filename":"pic.jpg",""" +
                            """"mimeType":"image/jpeg","size":3,"path":"hapi-hub:scratchlist/a1"}}"""
                    )
                    .setBodyDelay(150, TimeUnit.MILLISECONDS),
            )

            val result = async { store.uploadAttachment("s1", "pic.jpg", byteArrayOf(1, 2, 3), "image/jpeg") }
            store.state("s1").first { it.uploadsInFlight == listOf("pic.jpg") }

            val uploaded = assertIs<ScratchlistUploadResult.Uploaded>(result.await())
            assertEquals("a1", uploaded.attachment.id)
            store.state("s1").first { it.uploadsInFlight.isEmpty() }

            val request = server.takeRequest()
            assertEquals("POST", request.method)
            assertEquals("/api/sessions/s1/scratchlist/upload", request.path)
            val sent = body(request)
            assertEquals("pic.jpg", sent["filename"]?.jsonPrimitive?.content)
            assertEquals("image/jpeg", sent["mimeType"]?.jsonPrimitive?.content)
            assertEquals("AQID", sent["content"]?.jsonPrimitive?.content) // base64 of 1,2,3
        }

    @Test
    fun `upload 413 maps to the typed too-large code`() = runScratchlistTest { store, server ->
        server.enqueueJson(
            """{"success":false,"error":"File exceeds the 10 MB limit","code":"${ScratchlistErrorCodes.ATTACHMENT_TOO_LARGE}"}""",
            code = 413,
        )

        val result = store.uploadAttachment("s1", "huge.png", ByteArray(4), "image/png")

        val failed = assertIs<ScratchlistUploadResult.Failed>(result)
        assertEquals(ScratchlistErrorCodes.ATTACHMENT_TOO_LARGE, failed.code)
        assertTrue(store.currentState("s1").uploadsInFlight.isEmpty())
    }

    @Test
    fun `attachment delete maps 409 in_use and ok bodies`() = runScratchlistTest { store, server ->
        server.enqueueJson(
            """{"error":"Attachment is still referenced","code":"${ScratchlistErrorCodes.ATTACHMENT_IN_USE}"}""",
            code = 409,
        )
        assertEquals(
            ScratchlistAttachmentDeleteResult.InUse,
            store.deleteAttachment("s1", "a1"),
        )

        server.enqueueJson("""{"ok":true}""")
        assertEquals(
            ScratchlistAttachmentDeleteResult.Removed,
            store.deleteAttachment("s1", "a1"),
        )
        val first = server.takeRequest()
        assertEquals("DELETE", first.method)
        assertEquals("/api/sessions/s1/scratchlist/attachments/a1", first.path)
    }

    @Test
    fun `limits default offline and cache after the first success`() =
        runScratchlistTest { store, server ->
            server.enqueueJson("""{"error":"boom"}""", code = 500)
            assertEquals(ScratchlistAttachmentLimits.DEFAULT, store.limits("s1"))

            server.enqueueJson(
                """{"limits":{"maxBytesPerFile":1024,"maxAttachmentsPerEntry":2,""" +
                    """"maxBytesPerEntry":2048,"maxBytesPerSession":4096,"allowedMimeTypes":["image/png"]}}"""
            )
            val fetched = store.limits("s1")
            assertEquals(1024, fetched.maxBytesPerFile)
            assertEquals(listOf("image/png"), fetched.allowedMimeTypes)

            // Third call answers from the cache — no further request.
            assertEquals(fetched, store.limits("s1"))
            assertEquals(2, server.requestCount)
        }
}

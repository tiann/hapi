package app.hapi.data.store

import app.hapi.data.sse.SseSubscriptionKey
import java.io.File
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest

class SessionStoreTest {

    private val globalScope = SseSubscriptionKey.Global

    private fun runStoreTest(
        snapshotDir: File? = null,
        block: suspend kotlinx.coroutines.test.TestScope.(SessionStore, MockWebServer) -> Unit,
    ) = runTest {
        val server = MockWebServer()
        server.start()
        try {
            val store = SessionStore(apiFor(server), backgroundScope, snapshotDir)
            block(store, server)
        } finally {
            server.shutdown()
        }
    }

    // ------------------------------------------------------------ refresh --

    @Test
    fun `refresh replaces the list with the sorted server response`() = runStoreTest { store, server ->
        server.enqueueJson(
            sessionsResponseJson(
                summary("old-inactive", updatedAt = 1_000),
                summary("pinned", updatedAt = 500, pinned = true),
                summary("active", active = true, updatedAt = 100),
            )
        )
        store.refresh()
        assertEquals(listOf("pinned", "active", "old-inactive"), store.sessions.value.map { it.id })
    }

    @Test
    fun `refresh failure throws and keeps previous state`() = runStoreTest { store, server ->
        server.enqueueJson(sessionsResponseJson(summary("s1")))
        store.refresh()
        server.enqueueJson("""{"error":"boom"}""", code = 500)
        assertFailsWith<Exception> { store.refresh() }
        assertEquals(listOf("s1"), store.sessions.value.map { it.id })
    }

    // ----------------------------------------------------- event: full session --

    @Test
    fun `full-session event replaces the detail and upserts the summary`() = runStoreTest { store, server ->
        server.enqueueJson(
            sessionsResponseJson(
                summary("s1", updatedAt = 100, futureScheduledMessageCount = 2, nextScheduledAt = 999)
            )
        )
        store.refresh()

        val full = session("s1", updatedAt = 5_000, agentStateVersion = 9)
        store.applySessionEvent(globalScope, sessionUpdatedEvent("s1", fullSessionJson(full)))

        assertEquals(full, store.currentDetail("s1"))
        val row = store.sessions.value.single()
        assertEquals(5_000, row.updatedAt)
        assertEquals(9, row.agentStateVersion)
        // Hub-computed fields the projection cannot derive are preserved.
        assertEquals(2, row.futureScheduledMessageCount)
        assertEquals(999L, row.nextScheduledAt)
    }

    @Test
    fun `full-session event with mismatched id falls back to list refetch`() = runStoreTest { store, server ->
        server.enqueueJson(sessionsResponseJson(summary("s1", updatedAt = 100)))
        store.refresh()
        // The refetch triggered by the mismatching payload:
        server.enqueueJson(sessionsResponseJson(summary("s1", updatedAt = 100), summary("s2", updatedAt = 50)))

        store.applySessionEvent(
            globalScope,
            sessionUpdatedEvent("s2", fullSessionJson(session("other-id"))),
        )
        assertNull(store.currentDetail("s2"))
        // runTest's real-time timeout guards the await (virtual withTimeout
        // would race the real network round-trip).
        store.sessions.first { list -> list.any { it.id == "s2" } }
    }

    // ----------------------------------------------------------- event: patch --

    @Test
    fun `stale versioned patch leaves detail and summary untouched`() = runStoreTest { store, server ->
        server.enqueueJson(sessionsResponseJson(summary("s1", updatedAt = 100, agentStateVersion = 5)))
        store.refresh()
        store.applySessionEvent(globalScope, sessionUpdatedEvent("s1", fullSessionJson(session("s1", agentStateVersion = 5))))

        val before = store.sessions.value
        store.applySessionEvent(
            globalScope,
            sessionUpdatedEvent(
                "s1",
                """{"agentState":{"version":4,"value":{"requests":{"r1":{"tool":"Bash"}}}}}""",
            ),
        )
        assertEquals(5, store.currentDetail("s1")?.agentStateVersion)
        assertNull(store.currentDetail("s1")?.agentState)
        assertEquals(0, store.sessions.value.single().pendingRequestsCount)
        assertSame(before, store.sessions.value, "stale patch must keep the list identity")
    }

    @Test
    fun `equal-version patch applies to the summary but not the detail`() = runStoreTest { store, server ->
        // The replicated web divergence: summary path >= vs detail path >.
        server.enqueueJson(sessionsResponseJson(summary("s1", updatedAt = 100, agentStateVersion = 5)))
        store.refresh()
        store.applySessionEvent(globalScope, sessionUpdatedEvent("s1", fullSessionJson(session("s1", agentStateVersion = 5))))

        store.applySessionEvent(
            globalScope,
            sessionUpdatedEvent(
                "s1",
                """{"agentState":{"version":5,"value":{"requests":{"r1":{"tool":"Bash"}}}}}""",
            ),
        )
        assertNull(store.currentDetail("s1")?.agentState, "detail gates strictly greater")
        val row = store.sessions.value.single()
        assertEquals(1, row.pendingRequestsCount)
        assertEquals(listOf("permission"), row.pendingRequestKinds)
    }

    @Test
    fun `newer versioned patch applies to both caches and re-sorts`() = runStoreTest { store, server ->
        server.enqueueJson(
            sessionsResponseJson(
                summary("s1", active = true, updatedAt = 100, agentStateVersion = 5),
                summary("s2", active = true, updatedAt = 200),
            )
        )
        store.refresh()
        assertEquals(listOf("s2", "s1"), store.sessions.value.map { it.id })
        store.applySessionEvent(globalScope, sessionUpdatedEvent("s1", fullSessionJson(session("s1", agentStateVersion = 5))))

        store.applySessionEvent(
            globalScope,
            sessionUpdatedEvent(
                "s1",
                """{"updatedAt":300,"agentState":{"version":6,"value":{"requests":{"r1":{"tool":"Bash"}}}}}""",
            ),
        )
        val detail = store.currentDetail("s1")
        assertEquals(6, detail?.agentStateVersion)
        assertEquals("Bash", detail?.agentState?.requests?.get("r1")?.tool)
        // Pending requests push the active session ahead of the newer one.
        assertEquals(listOf("s1", "s2"), store.sessions.value.map { it.id })
        assertEquals(1, store.sessions.value.first().pendingRequestsCount)
    }

    @Test
    fun `keep-alive activeAt-only patch keeps the list identity`() = runStoreTest { store, server ->
        server.enqueueJson(sessionsResponseJson(summary("s1", active = true, updatedAt = 100, activeAt = 1_000)))
        store.refresh()
        val before = store.sessions.value
        store.applySessionEvent(globalScope, sessionUpdatedEvent("s1", """{"active":true,"activeAt":11000}"""))
        assertSame(before, store.sessions.value)
    }

    @Test
    fun `patch for an unlisted session falls back to a list refetch`() = runStoreTest { store, server ->
        server.enqueueJson(sessionsResponseJson(summary("brand-new", updatedAt = 10)))
        store.applySessionEvent(globalScope, sessionUpdatedEvent("brand-new", """{"updatedAt":10}"""))
        store.sessions.first { list -> list.any { it.id == "brand-new" } }
    }

    @Test
    fun `unparseable data refetches list and cached detail`() = runStoreTest { store, server ->
        server.enqueueJson(sessionsResponseJson(summary("s1", updatedAt = 100)))
        store.refresh()
        store.applySessionEvent(globalScope, sessionUpdatedEvent("s1", fullSessionJson(session("s1", updatedAt = 100))))

        // Detail + list refetch run concurrently — route by path, not FIFO.
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val body = when {
                    request.path!!.startsWith("/api/sessions/s1") ->
                        """{"session":${fullSessionJson(session("s1", updatedAt = 900))}}"""
                    request.path!!.startsWith("/api/sessions") ->
                        sessionsResponseJson(summary("s1", updatedAt = 900))
                    else -> return MockResponse().setResponseCode(404)
                }
                return MockResponse().setResponseCode(200)
                    .setHeader("Content-Type", "application/json")
                    .setBody(body)
            }
        }

        // `data` present but neither a Session nor a strict patch.
        store.applySessionEvent(globalScope, sessionUpdatedEvent("s1", """{"unknownKey":1}"""))
        store.sessions.first { list -> list.any { it.updatedAt == 900L } }
        store.sessionDetail("s1").first { it?.updatedAt == 900L }
    }

    // ------------------------------------------------------ event: removal --

    @Test
    fun `session-removed drops the row and the detail`() = runStoreTest { store, server ->
        server.enqueueJson(sessionsResponseJson(summary("s1"), summary("s2")))
        store.refresh()
        store.applySessionEvent(globalScope, sessionUpdatedEvent("s1", fullSessionJson(session("s1"))))

        store.applySessionEvent(globalScope, sessionRemovedEvent("s1"))
        assertEquals(listOf("s2"), store.sessions.value.map { it.id })
        assertNull(store.currentDetail("s1"))
    }

    @Test
    fun `session-added with a full session inserts a new row`() = runStoreTest { store, server ->
        server.enqueueJson(sessionsResponseJson(summary("s1", updatedAt = 500)))
        store.refresh()
        store.applySessionEvent(globalScope, sessionAddedEvent("s2", fullSessionJson(session("s2", updatedAt = 900))))
        assertEquals(listOf("s2", "s1"), store.sessions.value.map { it.id })
    }

    // --------------------------------------------------------- pin/archive --

    @Test
    fun `setPinMode flips flags optimistically and re-sorts`() = runStoreTest { store, server ->
        server.enqueueJson(
            sessionsResponseJson(
                summary("s1", updatedAt = 900),
                summary("s2", updatedAt = 100),
            )
        )
        store.refresh()
        server.enqueueJson("""{"ok":true}""") // PUT pin
        store.setPinMode("s2", "project")
        assertEquals(listOf("s2", "s1"), store.sessions.value.map { it.id })
        assertEquals(true, store.sessions.value.first().pinned)
        assertEquals(false, store.sessions.value.first().globalPinned)

        server.enqueueJson("""{"ok":true}""")
        store.setPinMode("s2", "global")
        assertEquals(false, store.sessions.value.first().pinned)
        assertEquals(true, store.sessions.value.first().globalPinned)

        server.enqueueJson("""{"ok":true}""")
        store.setPinMode("s2", "none")
        assertEquals(listOf("s1", "s2"), store.sessions.value.map { it.id })
    }

    @Test
    fun `setPinMode failure rolls forward to server truth`() = runStoreTest { store, server ->
        server.enqueueJson(sessionsResponseJson(summary("s1", updatedAt = 900), summary("s2", updatedAt = 100)))
        store.refresh()
        server.enqueueJson("""{"error":"boom"}""", code = 500) // PUT pin fails
        server.enqueueJson(sessionsResponseJson(summary("s1", updatedAt = 900), summary("s2", updatedAt = 100)))

        assertFailsWith<Exception> { store.setPinMode("s2", "project") }
        store.sessions.first { list -> list.map { it.id } == listOf("s1", "s2") && list.none { it.pinned == true } }
    }

    @Test
    fun `archive removes optimistically and restores on failure`() = runStoreTest { store, server ->
        server.enqueueJson(sessionsResponseJson(summary("s1", updatedAt = 900), summary("s2", updatedAt = 100)))
        store.refresh()

        server.enqueueJson("""{"ok":true}""")
        store.archiveSession("s2")
        assertEquals(listOf("s1"), store.sessions.value.map { it.id })

        server.enqueueJson("""{"error":"session_inactive"}""", code = 409)
        assertFailsWith<Exception> { store.archiveSession("s1") }
        assertEquals(listOf("s1"), store.sessions.value.map { it.id }, "failed archive restores the row")
    }

    // ------------------------------------------- rename / delete / reopen --

    private fun namedSummary(id: String, name: String? = null, active: Boolean = false) = summary(
        id = id,
        active = active,
        updatedAt = 100,
        metadata = app.hapi.protocol.wire.SessionSummaryMetadata(name = name, path = "/repo/$id"),
    )

    @Test
    fun `rename updates the summary and detail optimistically and PATCHes the hub`() = runStoreTest { store, server ->
        server.enqueueJson(sessionsResponseJson(namedSummary("s1", name = "Old")))
        store.refresh()
        server.enqueueJson("""{"session":${fullSessionJson(session("s1"))}}""")
        store.loadSessionDetail("s1")
        server.enqueueJson("""{"ok":true}""") // PATCH rename

        store.renameSession("s1", "New name")

        assertEquals("New name", store.sessions.value.single().metadata?.name)
        server.takeRequest() // GET /sessions
        server.takeRequest() // GET /sessions/s1
        val patch = server.takeRequest()
        assertEquals("PATCH", patch.method)
        assertEquals("/api/sessions/s1", patch.path)
        assertEquals("""{"name":"New name"}""", patch.body.readUtf8())
        // The fixture detail has no metadata; the store must not invent one.
        assertNull(store.currentDetail("s1")!!.metadata)
    }

    @Test
    fun `rename failure rolls forward to server truth`() = runStoreTest { store, server ->
        server.enqueueJson(sessionsResponseJson(namedSummary("s1", name = "Old")))
        store.refresh()
        server.enqueueJson("""{"error":"boom"}""", code = 500) // PATCH fails
        server.enqueueJson(sessionsResponseJson(namedSummary("s1", name = "Old"))) // scheduled refetch

        assertFailsWith<Exception> { store.renameSession("s1", "New name") }
        // Optimistic name applied first, then the refetch restores the truth.
        store.sessions.first { list -> list.single().metadata?.name == "Old" }
    }

    @Test
    fun `delete removes optimistically and restores on 409`() = runStoreTest { store, server ->
        server.enqueueJson(sessionsResponseJson(namedSummary("s1"), namedSummary("s2")))
        store.refresh()
        server.enqueueJson("""{"session":${fullSessionJson(session("s1"))}}""")
        store.loadSessionDetail("s1")

        server.enqueueJson("""{"ok":true}""")
        store.deleteSession("s2")
        assertEquals(listOf("s1"), store.sessions.value.map { it.id })
        server.takeRequest() // GET /sessions
        server.takeRequest() // GET /sessions/s1
        val delete = server.takeRequest()
        assertEquals("DELETE", delete.method)
        assertEquals("/api/sessions/s2", delete.path)

        server.enqueueJson("""{"error":"session is active","code":"session_active"}""", code = 409)
        assertFailsWith<Exception> { store.deleteSession("s1") }
        assertEquals(listOf("s1"), store.sessions.value.map { it.id }, "failed delete restores the row")
        assertEquals("s1", store.currentDetail("s1")?.id, "failed delete restores the cached detail")
    }

    @Test
    fun `reopen marks the returned session active and refetches`() = runStoreTest { store, server ->
        server.enqueueJson(sessionsResponseJson(namedSummary("s1"), namedSummary("s2")))
        store.refresh()
        server.enqueueJson("""{"ok":true,"sessionId":"s2","resumed":true}""") // POST reopen → superseding id
        // The scheduled refetch fires after the reopen (16 ms batch).
        server.enqueueJson(sessionsResponseJson(namedSummary("s1"), namedSummary("s2", active = true)))

        val response = store.reopenSession("s1")

        assertEquals("s2", response.sessionId)
        assertTrue(response.resumed)
        // Optimistic active flag on the RETURNED id, before the refetch lands.
        assertTrue(store.sessions.value.first { it.id == "s2" }.active)
        store.sessions.first { list -> list.first { it.id == "s2" }.active }
    }

    // ------------------------------------------------------------ snapshot --

    @Test
    fun `summaries round-trip through the snapshot into a cold store`() = runTest {
        val dir = Files.createTempDirectory("session-store").toFile()
        val server = MockWebServer()
        server.start()
        try {
            val store = SessionStore(apiFor(server), backgroundScope, dir)
            server.enqueueJson(
                sessionsResponseJson(
                    summary("pinned", updatedAt = 100, pinned = true),
                    summary("recent", updatedAt = 900),
                )
            )
            store.refresh()
            store.flushPersistence()

            val cold = SessionStore(apiFor(server), backgroundScope, dir)
            assertEquals(listOf("pinned", "recent"), cold.sessions.value.map { it.id })
            assertTrue(cold.sessions.value.first().pinned == true)
            assertTrue(File(dir, "sessions.json").isFile)
        } finally {
            server.shutdown()
        }
    }
}

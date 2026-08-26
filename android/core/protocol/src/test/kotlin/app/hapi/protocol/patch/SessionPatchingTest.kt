package app.hapi.protocol.patch

import app.hapi.protocol.wire.AgentState
import app.hapi.protocol.wire.AgentStateRequest
import app.hapi.protocol.wire.HapiJson
import app.hapi.protocol.wire.OptionalField
import app.hapi.protocol.wire.Session
import app.hapi.protocol.wire.SessionMetadata
import app.hapi.protocol.wire.SessionPatch
import app.hapi.protocol.wire.SessionPatches
import app.hapi.protocol.wire.TodoItem
import app.hapi.protocol.wire.VersionedValue
import kotlinx.serialization.json.JsonElement
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Port of the pure-function cases from `web/src/hooks/useSSE.test.ts`
 * (`isNewerVersionedPatch`, `isRenderIrrelevantSessionPatch`,
 * `applySessionDetailPatch`) plus the `SessionPatches.parse` strictness
 * contract from `docs/api/client-contract/sse.md`.
 */
class SessionPatchingTest {

    private fun makeSession(
        updatedAt: Long = 2_000,
        activeAt: Long = 1_000,
        metadataVersion: Long = 1,
        agentStateVersion: Long = 1,
        todosUpdatedAt: Long? = 0,
        teamStateUpdatedAt: Long? = 0,
        metadata: SessionMetadata? = null,
        agentState: AgentState? = null,
        todos: List<TodoItem>? = null,
        model: String? = "gpt-5",
        copilotAgentMode: String? = "interactive",
    ): Session = Session(
        id = "session-1",
        namespace = "default",
        seq = 1,
        createdAt = 1_000,
        updatedAt = updatedAt,
        active = true,
        activeAt = activeAt,
        metadata = metadata,
        metadataVersion = metadataVersion,
        agentState = agentState,
        agentStateVersion = agentStateVersion,
        thinking = false,
        thinkingAt = 0,
        todos = todos,
        todosUpdatedAt = todosUpdatedAt,
        teamStateUpdatedAt = teamStateUpdatedAt,
        model = model,
        permissionMode = "default",
        copilotAgentMode = copilotAgentMode,
    )

    private fun metadata(name: String) = SessionMetadata(path = "/tmp", host = "host-1", name = name)

    // --- isNewerVersionedPatch (useSSE.test.ts, PR #897 review) ---

    @Test
    fun `accepts a strictly newer patch`() {
        assertTrue(isNewerVersionedPatch(5, 4))
    }

    @Test
    fun `rejects an older patch - the stale buffered replay bug case`() {
        assertFalse(isNewerVersionedPatch(4, 5))
    }

    @Test
    fun `rejects a same-version patch - idempotent duplicate replay`() {
        assertFalse(isNewerVersionedPatch(5, 5))
    }

    @Test
    fun `accepts the first write into a freshly-cached session`() {
        assertTrue(isNewerVersionedPatch(1, 0))
    }

    // --- version gates in applySessionDetailPatch ---

    @Test
    fun `stale metadata patch is dropped entirely`() {
        val session = makeSession(metadataVersion = 5, metadata = metadata("current"))
        val patch = SessionPatch(metadata = VersionedValue(4, metadata("stale")))
        assertNull(applySessionDetailPatch(session, patch))
    }

    @Test
    fun `equal-version metadata patch is dropped`() {
        val session = makeSession(metadataVersion = 5, metadata = metadata("current"))
        val patch = SessionPatch(metadata = VersionedValue(5, metadata("duplicate")))
        assertNull(applySessionDetailPatch(session, patch))
    }

    @Test
    fun `newer metadata patch applies value and stores version`() {
        val session = makeSession(metadataVersion = 5, metadata = metadata("current"))
        val next = assertNotNull(
            applySessionDetailPatch(session, SessionPatch(metadata = VersionedValue(6, metadata("newer"))))
        )
        assertEquals(6, next.metadataVersion)
        assertEquals(metadata("newer"), next.metadata)
    }

    @Test
    fun `stale agentState patch cannot resurrect resolved requests`() {
        val resolved = makeSession(agentStateVersion = 3, agentState = AgentState(requests = emptyMap()))
        val staleRequests = AgentState(
            requests = mapOf("req-1" to AgentStateRequest(tool = "Bash"))
        )
        assertNull(
            applySessionDetailPatch(resolved, SessionPatch(agentState = VersionedValue(3, staleRequests)))
        )
        assertNull(
            applySessionDetailPatch(resolved, SessionPatch(agentState = VersionedValue(2, staleRequests)))
        )
    }

    @Test
    fun `newer agentState patch applies`() {
        val session = makeSession(agentStateVersion = 3)
        val incoming = AgentState(requests = mapOf("req-9" to AgentStateRequest(tool = "Edit")))
        val next = assertNotNull(
            applySessionDetailPatch(session, SessionPatch(agentState = VersionedValue(4, incoming)))
        )
        assertEquals(4, next.agentStateVersion)
        assertEquals(incoming, next.agentState)
    }

    @Test
    fun `versioned null value clears metadata when newer`() {
        val session = makeSession(metadataVersion = 2, metadata = metadata("current"))
        val next = assertNotNull(
            applySessionDetailPatch(session, SessionPatch(metadata = VersionedValue(3, null)))
        )
        assertNull(next.metadata)
        assertEquals(3, next.metadataVersion)
    }

    @Test
    fun `todos gate treats absent watermark as zero`() {
        val session = makeSession(todosUpdatedAt = null)
        val todos = listOf(TodoItem(content = "port the patcher", status = "in_progress"))
        val next = assertNotNull(
            applySessionDetailPatch(session, SessionPatch(todos = VersionedValue(1, todos)))
        )
        assertEquals(todos, next.todos)
        assertEquals(1, next.todosUpdatedAt)

        // Same version again: duplicate replay must keep prior identity.
        assertNull(applySessionDetailPatch(next, SessionPatch(todos = VersionedValue(1, emptyList()))))
    }

    @Test
    fun `teamState null value clears the team when newer`() {
        val team = HapiJson.parseToJsonElement("""{"teamName":"crew"}""")
        val session = makeSession(teamStateUpdatedAt = 10).copy(teamState = team)
        val next = assertNotNull(
            applySessionDetailPatch(session, SessionPatch(teamState = VersionedValue(11, null)))
        )
        assertNull(next.teamState)
        assertEquals(11, next.teamStateUpdatedAt)
    }

    // --- updatedAt monotonicity ---

    @Test
    fun `stale updatedAt alone never rewinds the clock and reports no change`() {
        val session = makeSession(updatedAt = 2_000)
        assertNull(applySessionDetailPatch(session, SessionPatch(updatedAt = 1_000)))
    }

    @Test
    fun `newer updatedAt advances`() {
        val session = makeSession(updatedAt = 2_000)
        val next = assertNotNull(applySessionDetailPatch(session, SessionPatch(updatedAt = 3_000)))
        assertEquals(3_000, next.updatedAt)
    }

    @Test
    fun `stale updatedAt in a mixed patch applies the rest but keeps the clock`() {
        val session = makeSession(updatedAt = 2_000)
        val next = assertNotNull(
            applySessionDetailPatch(session, SessionPatch(thinking = true, updatedAt = 1_000))
        )
        assertTrue(next.thinking)
        assertEquals(2_000, next.updatedAt)
    }

    // --- flat fields are unconditional (no version involved) ---

    @Test
    fun `flat model change applies regardless of versions`() {
        val session = makeSession(model = "gpt-5")
        val next = assertNotNull(
            applySessionDetailPatch(session, SessionPatch(model = OptionalField.Present("opus")))
        )
        assertEquals("opus", next.model)
    }

    @Test
    fun `present-null serviceTier clears the field`() {
        val session = makeSession().copy(serviceTier = "fast")
        val next = assertNotNull(
            applySessionDetailPatch(session, SessionPatch(serviceTier = OptionalField.Present(null)))
        )
        assertNull(next.serviceTier)
    }

    @Test
    fun `absent model leaves the field untouched`() {
        val session = makeSession(model = "gpt-5")
        val next = assertNotNull(applySessionDetailPatch(session, SessionPatch(thinking = true)))
        assertEquals("gpt-5", next.model)
    }

    // --- applySessionDetailPatch (useSSE.test.ts, Copilot keep-alive) ---

    @Test
    fun `applies a copilotAgentMode keep-alive change to the detail session`() {
        val session = makeSession()
        val next = assertNotNull(
            applySessionDetailPatch(
                session,
                SessionPatch(active = true, thinking = false, activeAt = 11_000, copilotAgentMode = "plan")
            )
        )
        assertEquals("plan", next.copilotAgentMode)
        assertEquals(11_000, next.activeAt)
    }

    @Test
    fun `returns null for a keep-alive that only repeats the current copilot mode`() {
        val session = makeSession()
        assertNull(
            applySessionDetailPatch(
                session,
                SessionPatch(active = true, thinking = false, activeAt = 11_000, copilotAgentMode = "interactive")
            )
        )
    }

    // --- mixed patch: versioned gates are per-field ---

    @Test
    fun `mixed patch applies flat and newer-versioned fields while rejecting stale ones`() {
        val session = makeSession(
            metadataVersion = 5,
            agentStateVersion = 5,
            metadata = metadata("current"),
            agentState = AgentState(requests = emptyMap()),
        )
        val next = assertNotNull(
            applySessionDetailPatch(
                session,
                SessionPatch(
                    thinking = true,
                    updatedAt = 9_000,
                    metadata = VersionedValue(6, metadata("newer")),
                    agentState = VersionedValue(4, AgentState(requests = mapOf("stale" to AgentStateRequest(tool = "Bash")))),
                )
            )
        )
        assertTrue(next.thinking)
        assertEquals(9_000, next.updatedAt)
        assertEquals(metadata("newer"), next.metadata)
        assertEquals(6, next.metadataVersion)
        // Stale agentState rejected: value and version untouched.
        assertEquals(session.agentState, next.agentState)
        assertEquals(5, next.agentStateVersion)
    }

    // --- isRenderIrrelevantSessionPatch (useSSE.test.ts) ---

    @Test
    fun `treats a sub-minute activeAt keep-alive as irrelevant`() {
        val session = makeSession(activeAt = 1_000, model = "opus")
        assertTrue(
            isRenderIrrelevantSessionPatch(
                session,
                SessionPatch(
                    active = true,
                    thinking = false,
                    activeAt = 11_000,
                    model = OptionalField.Present("opus"),
                    effort = OptionalField.Present(null),
                    permissionMode = "default",
                    serviceTier = OptionalField.Present(null),
                )
            )
        )
    }

    @Test
    fun `treats an activeAt move of at least one minute as render-relevant`() {
        val session = makeSession(activeAt = 1_000, model = "opus")
        assertFalse(
            isRenderIrrelevantSessionPatch(
                session,
                SessionPatch(
                    active = true,
                    thinking = false,
                    activeAt = 1_000 + 60_000,
                    model = OptionalField.Present("opus"),
                    effort = OptionalField.Present(null),
                    permissionMode = "default",
                    serviceTier = OptionalField.Present(null),
                )
            )
        )
    }

    @Test
    fun `reports a changed field as relevant even alongside a new activeAt`() {
        val session = makeSession()
        assertFalse(
            isRenderIrrelevantSessionPatch(session, SessionPatch(thinking = true, activeAt = 11_000))
        )
    }

    @Test
    fun `reports a field the session does not carry yet as relevant`() {
        val session = makeSession()
        assertFalse(
            isRenderIrrelevantSessionPatch(
                session,
                SessionPatch(activeAt = 11_000, scratchlistUpdatedAt = 5_000)
            )
        )
    }

    @Test
    fun `treats an empty patch as irrelevant`() {
        assertTrue(isRenderIrrelevantSessionPatch(makeSession(), SessionPatch()))
    }

    // --- SessionPatches.parse: strictness + tri-state decoding ---

    @Test
    fun `parse rejects unknown keys - a full Session payload is not a patch`() {
        val fullSession = HapiJson.parseToJsonElement(
            """{"id":"session-1","namespace":"default","seq":1,"active":true,"updatedAt":2}"""
        )
        assertNull(SessionPatches.parse(fullSession))
    }

    @Test
    fun `parse rejects an empty patch`() {
        assertNull(SessionPatches.parse(HapiJson.parseToJsonElement("{}")))
        assertNull(SessionPatches.parse(null))
        assertNull(SessionPatches.parse(HapiJson.parseToJsonElement("42")))
    }

    @Test
    fun `parse keeps absent vs explicit-null apart for clear-fields`() {
        val patch = assertNotNull(
            SessionPatches.parse(HapiJson.parseToJsonElement("""{"model":null,"activeAt":5}"""))
        )
        assertEquals(OptionalField.Present<String?>(null), patch.model)
        assertEquals(OptionalField.Absent, patch.effort)
        assertEquals(5L, patch.activeAt)
    }

    @Test
    fun `parse decodes versioned wrappers without wholesale-spreading them`() {
        val patch = assertNotNull(
            SessionPatches.parse(
                HapiJson.parseToJsonElement(
                    """
                    {
                      "metadata": {"version": 7, "value": {"path": "/repo", "host": "devbox"}},
                      "todos": {"version": 1755000000000, "value": [{"content": "ship it", "status": "pending"}]},
                      "teamState": {"version": 3, "value": null}
                    }
                    """
                )
            )
        )
        assertEquals(7L, patch.metadata?.version)
        assertEquals("/repo", patch.metadata?.value?.path)
        assertEquals(1_755_000_000_000L, patch.todos?.version)
        assertEquals(listOf(TodoItem(content = "ship it", status = "pending")), patch.todos?.value)
        assertEquals(VersionedValue<JsonElement>(3, null), patch.teamState)
    }

    @Test
    fun `parse rejects a versioned wrapper missing its value key`() {
        assertNull(SessionPatches.parse(HapiJson.parseToJsonElement("""{"metadata":{"version":7}}""")))
    }

    @Test
    fun `parse rejects malformed wrapped values`() {
        // metadata.value without required path/host must fail like zod does.
        assertNull(
            SessionPatches.parse(
                HapiJson.parseToJsonElement("""{"metadata":{"version":7,"value":{"name":"x"}}}""")
            )
        )
        assertNull(
            SessionPatches.parse(HapiJson.parseToJsonElement("""{"todos":{"version":1,"value":{}}}"""))
        )
    }

    @Test
    fun `parse normalizes legacy copilot fleet mode`() {
        val patch = assertNotNull(
            SessionPatches.parse(HapiJson.parseToJsonElement("""{"copilotAgentMode":"fleet"}"""))
        )
        assertEquals("interactive", patch.copilotAgentMode)
    }

    @Test
    fun `parsed keep-alive drives the full pipeline end to end`() {
        // The canonical ~10s CLI keep-alive shape: only activeAt moves.
        val session = makeSession(activeAt = 1_000)
        val keepAlive = assertNotNull(
            SessionPatches.parse(HapiJson.parseToJsonElement("""{"active":true,"thinking":false,"activeAt":11000}"""))
        )
        assertNull(applySessionDetailPatch(session, keepAlive))

        val minuteLater = assertNotNull(
            SessionPatches.parse(HapiJson.parseToJsonElement("""{"active":true,"thinking":false,"activeAt":61000}"""))
        )
        assertEquals(61_000, assertNotNull(applySessionDetailPatch(session, minuteLater)).activeAt)
    }
}

package app.hapi.protocol.wire

import kotlinx.serialization.json.JsonNull
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Port of the summary-path cases from `web/src/hooks/useSSE.test.ts`
 * (`canApplyVersionedSummaryPatch`, `isRenderIrrelevantPatch`) plus pins for
 * the pieces the web only exercises through the hook: the `>=` versioned
 * gates of `patchSessionSummary`, the `shared/src/sessionSummary.ts`
 * derivations, and the `toSessionSummary` projection.
 */
class SummaryPatchingTest {

    private fun makeSummary(
        id: String = "session-1",
        active: Boolean = true,
        thinking: Boolean = false,
        activeAt: Long = 1_000,
        updatedAt: Long = 2_000,
        pinned: Boolean? = null,
        globalPinned: Boolean? = null,
        metadata: SessionSummaryMetadata? = null,
        metadataVersion: Long = 0,
        agentStateVersion: Long = 0,
        todosUpdatedAt: Long = 0,
        todoProgress: TodoProgress? = null,
        pendingRequestsCount: Int = 0,
        pendingRequestKinds: List<String> = emptyList(),
        pendingRequests: List<PendingRequest> = emptyList(),
        backgroundTaskCount: Int = 0,
        model: String? = null,
        modelReasoningEffort: String? = null,
        effort: String? = null,
    ): SessionSummary = SessionSummary(
        id = id,
        active = active,
        thinking = thinking,
        activeAt = activeAt,
        updatedAt = updatedAt,
        pinned = pinned,
        globalPinned = globalPinned,
        metadata = metadata,
        metadataVersion = metadataVersion,
        agentStateVersion = agentStateVersion,
        todosUpdatedAt = todosUpdatedAt,
        todoProgress = todoProgress,
        pendingRequestsCount = pendingRequestsCount,
        pendingRequestKinds = pendingRequestKinds,
        pendingRequests = pendingRequests,
        backgroundTaskCount = backgroundTaskCount,
        futureScheduledMessageCount = 0,
        nextScheduledAt = null,
        model = model,
        modelReasoningEffort = modelReasoningEffort,
        effort = effort,
    )

    private fun request(tool: String, createdAt: Long? = null) =
        AgentStateRequest(tool = tool, arguments = JsonNull, createdAt = createdAt)

    // ------------------------------------------------------- derivations --

    @Test
    fun `computePendingRequestKinds dedupes and canonicalizes both-kinds order`() {
        assertEquals(emptyList(), SummaryPatching.computePendingRequestKinds(null))
        assertEquals(emptyList(), SummaryPatching.computePendingRequestKinds(AgentState()))

        val permissionOnly = AgentState(requests = mapOf("a" to request("Bash"), "b" to request("Edit")))
        assertEquals(listOf("permission"), SummaryPatching.computePendingRequestKinds(permissionOnly))

        val inputOnly = AgentState(requests = mapOf("a" to request("AskUserQuestion")))
        assertEquals(listOf("input"), SummaryPatching.computePendingRequestKinds(inputOnly))

        // Input encountered first — canonical order is still permission,input.
        val both = AgentState(
            requests = linkedMapOf(
                "a" to request("request_user_input"),
                "b" to request("Bash"),
            )
        )
        assertEquals(listOf("permission", "input"), SummaryPatching.computePendingRequestKinds(both))
    }

    @Test
    fun `computePendingRequests sorts oldest-first with id tiebreak and falls back to fallbackSince`() {
        val state = AgentState(
            requests = linkedMapOf(
                "req-c" to request("Bash", createdAt = 300),
                "req-a" to request("Edit", createdAt = null), // → fallbackSince = 100
                "req-b" to request("ExitPlanMode", createdAt = 100),
            )
        )
        val items = SummaryPatching.computePendingRequests(state, fallbackSince = 100)
        assertEquals(listOf("req-a", "req-b", "req-c"), items.map { it.id })
        assertEquals(listOf(100L, 100L, 300L), items.map { it.since })
        assertEquals(listOf("permission", "input", "permission"), items.map { it.kind })
    }

    @Test
    fun `computePendingRequests caps at five but count stays authoritative`() {
        val requests = (1..7).associate { "req-$it" to request("Bash", createdAt = it.toLong()) }
        val state = AgentState(requests = requests)
        val items = SummaryPatching.computePendingRequests(state, fallbackSince = 0)
        assertEquals(5, items.size)
        assertEquals((1..5).map { "req-$it" }, items.map { it.id })
        assertEquals(7, SummaryPatching.computePendingRequestsCount(state))
    }

    @Test
    fun `computeTodoProgress is null for absent or empty and counts completed`() {
        assertNull(SummaryPatching.computeTodoProgress(null))
        assertNull(SummaryPatching.computeTodoProgress(emptyList()))
        val todos = listOf(
            TodoItem(content = "a", status = "completed"),
            TodoItem(content = "b", status = "in_progress"),
            TodoItem(content = "c", status = "completed"),
        )
        assertEquals(TodoProgress(completed = 2, total = 3), SummaryPatching.computeTodoProgress(todos))
    }

    // -------------------------------------------------------- projection --

    private fun makeSession(
        metadata: SessionMetadata? = null,
        agentState: AgentState? = null,
        todos: List<TodoItem>? = null,
    ): Session = Session(
        id = "session-1",
        namespace = "default",
        seq = 1,
        createdAt = 1_000,
        updatedAt = 2_000,
        active = true,
        activeAt = 1_000,
        metadata = metadata,
        metadataVersion = 3,
        agentState = agentState,
        agentStateVersion = 4,
        thinking = true,
        thinkingAt = 0,
        todos = todos,
        todosUpdatedAt = 5,
        backgroundTaskCount = 2,
        model = "opus",
        effort = "high",
    )

    @Test
    fun `toSessionSummary projects derived fields and watermarks`() {
        val session = makeSession(
            metadata = SessionMetadata(
                path = "/repo",
                host = "host",
                name = "My session",
                flavor = "claude",
                claudeSessionId = " abc ",
                summary = MetadataSummary(text = "doing things", updatedAt = 9),
            ),
            agentState = AgentState(requests = mapOf("r1" to request("Bash", createdAt = 50))),
            todos = listOf(TodoItem(content = "a", status = "completed")),
        )
        val summary = SummaryPatching.toSessionSummary(session)
        assertEquals("session-1", summary.id)
        assertTrue(summary.active)
        assertTrue(summary.thinking)
        assertEquals(false, summary.pinned)
        assertEquals(false, summary.globalPinned)
        assertEquals(3, summary.metadataVersion)
        assertEquals(4, summary.agentStateVersion)
        assertEquals(5, summary.todosUpdatedAt)
        assertEquals(TodoProgress(1, 1), summary.todoProgress)
        assertEquals(1, summary.pendingRequestsCount)
        assertEquals(listOf("permission"), summary.pendingRequestKinds)
        assertEquals("abc", summary.metadata?.agentSessionId) // trimmed
        assertEquals("doing things", summary.metadata?.summary?.text)
        assertEquals(2, summary.backgroundTaskCount)
        assertEquals(0, summary.futureScheduledMessageCount)
        assertNull(summary.nextScheduledAt)
    }

    @Test
    fun `agentSessionId uses only the known flavor's field, legacy chain otherwise`() {
        // Known flavor: other flavors' ids are ignored, blank collapses to null.
        val claude = SummaryPatching.toSessionSummaryMetadata(
            SessionMetadata(path = "/p", host = "h", flavor = "claude", claudeSessionId = "  ", codexSessionId = "cx")
        )
        assertNull(claude?.agentSessionId)

        // Unknown flavor: legacy fallback chain, codex first, untrimmed.
        val unknown = SummaryPatching.toSessionSummaryMetadata(
            SessionMetadata(path = "/p", host = "h", flavor = "newagent", claudeSessionId = "cl", codexSessionId = "cx")
        )
        assertEquals("cx", unknown?.agentSessionId)

        // Legacy chain never reads piSessionId (replicated web quirk).
        val piOnly = SummaryPatching.toSessionSummaryMetadata(
            SessionMetadata(path = "/p", host = "h", flavor = null, piSessionId = "pi-1")
        )
        assertNull(piOnly?.agentSessionId)
    }

    // ------------------------------------------------- patch application --

    @Test
    fun `flat fields are last-write-wins and updatedAt is max-monotonic`() {
        val current = makeSummary(updatedAt = 2_000, model = "opus", backgroundTaskCount = 1)
        val next = SummaryPatching.applySessionSummaryPatch(
            current,
            SessionPatch(
                active = false,
                thinking = true,
                activeAt = 9_000,
                updatedAt = 1_500, // stale — must not rewind
                model = OptionalField.Present(null), // present null clears
                effort = OptionalField.Present("low"),
                backgroundTaskCount = 3,
            ),
        )
        assertFalse(next.active)
        assertTrue(next.thinking)
        assertEquals(9_000, next.activeAt)
        assertEquals(2_000, next.updatedAt)
        assertNull(next.model)
        assertEquals("low", next.effort)
        assertEquals(3, next.backgroundTaskCount)
    }

    @Test
    fun `absent optional fields leave the summary untouched`() {
        val current = makeSummary(model = "opus", modelReasoningEffort = "high", effort = "medium")
        val next = SummaryPatching.applySessionSummaryPatch(current, SessionPatch(activeAt = 5_000))
        assertEquals("opus", next.model)
        assertEquals("high", next.modelReasoningEffort)
        assertEquals("medium", next.effort)
    }

    @Test
    fun `agentState patch with equal version reapplies (summary path accepts gte)`() {
        // DIVERGENCE FROM DETAIL PATH, replicated from web: the detail cache
        // gates with strict `>`; the summary path re-derives from `>=`
        // because the derivation is idempotent (sse.md#versioned-patch-algorithm).
        val current = makeSummary(agentStateVersion = 5, pendingRequestsCount = 0)
        val state = AgentState(requests = mapOf("r1" to request("Bash", createdAt = 10)))
        val next = SummaryPatching.applySessionSummaryPatch(
            current,
            SessionPatch(agentState = VersionedValue(version = 5, value = state)),
        )
        assertEquals(1, next.pendingRequestsCount)
        assertEquals(listOf("permission"), next.pendingRequestKinds)
        assertEquals(5, next.agentStateVersion)
    }

    @Test
    fun `stale versioned patches are rejected`() {
        val current = makeSummary(
            metadataVersion = 5,
            agentStateVersion = 5,
            todosUpdatedAt = 5,
            pendingRequestsCount = 2,
            todoProgress = TodoProgress(1, 2),
        )
        val next = SummaryPatching.applySessionSummaryPatch(
            current,
            SessionPatch(
                metadata = VersionedValue(4, SessionMetadata(path = "/new", host = "h")),
                agentState = VersionedValue(4, AgentState()),
                todos = VersionedValue(4, emptyList()),
            ),
        )
        assertEquals(5, next.metadataVersion)
        assertEquals(5, next.agentStateVersion)
        assertEquals(5, next.todosUpdatedAt)
        assertEquals(2, next.pendingRequestsCount)
        assertEquals(TodoProgress(1, 2), next.todoProgress)
        assertNull(next.metadata)
    }

    @Test
    fun `newer versioned patches recompute the derived fields`() {
        val current = makeSummary(updatedAt = 2_000, agentStateVersion = 1, todosUpdatedAt = 1, metadataVersion = 1)
        val next = SummaryPatching.applySessionSummaryPatch(
            current,
            SessionPatch(
                updatedAt = 8_000,
                metadata = VersionedValue(2, SessionMetadata(path = "/repo", host = "h", name = "n")),
                agentState = VersionedValue(2, AgentState(requests = mapOf("r1" to request("Edit")))),
                todos = VersionedValue(2, listOf(TodoItem(content = "a", status = "pending"))),
            ),
        )
        assertEquals(8_000, next.updatedAt)
        assertEquals(2, next.metadataVersion)
        assertEquals("/repo", next.metadata?.path)
        assertEquals(2, next.agentStateVersion)
        assertEquals(1, next.pendingRequestsCount)
        // Requests without createdAt use the POST-patch updatedAt as `since`.
        assertEquals(8_000, next.pendingRequests.single().since)
        assertEquals(2, next.todosUpdatedAt)
        assertEquals(TodoProgress(0, 1), next.todoProgress)
    }

    @Test
    fun `agentState null value clears the pending fields`() {
        val current = makeSummary(
            agentStateVersion = 1,
            pendingRequestsCount = 2,
            pendingRequestKinds = listOf("permission"),
            pendingRequests = listOf(PendingRequest("r1", "permission", "Bash", 1)),
        )
        val next = SummaryPatching.applySessionSummaryPatch(
            current,
            SessionPatch(agentState = VersionedValue(2, null)),
        )
        assertEquals(0, next.pendingRequestsCount)
        assertEquals(emptyList(), next.pendingRequestKinds)
        assertEquals(emptyList(), next.pendingRequests)
    }

    @Test
    fun `teamState patch is a summary no-op`() {
        val current = makeSummary()
        val next = SummaryPatching.applySessionSummaryPatch(
            current,
            SessionPatch(teamState = VersionedValue(9, null)),
        )
        assertEquals(current, next)
    }

    // -------------------------------------------- render-irrelevance filter --

    @Test
    fun `keep-alive that only moves activeAt is irrelevant`() {
        val current = makeSummary(activeAt = 1_000)
        val next = makeSummary(activeAt = 11_000)
        assertTrue(SummaryPatching.isRenderIrrelevantPatch(current, next))
    }

    @Test
    fun `identical summaries are irrelevant`() {
        assertTrue(SummaryPatching.isRenderIrrelevantPatch(makeSummary(), makeSummary()))
    }

    @Test
    fun `each rendered field change is relevant`() {
        val cases = listOf<SessionSummary>(
            makeSummary(active = false),
            makeSummary(thinking = true),
            makeSummary(updatedAt = 9_999),
            makeSummary(backgroundTaskCount = 3),
            makeSummary(model = "opus"),
            makeSummary(modelReasoningEffort = "high"),
            makeSummary(effort = "medium"),
            makeSummary(pendingRequestsCount = 2),
            makeSummary(metadata = SessionSummaryMetadata(path = "/other")),
            makeSummary(metadata = SessionSummaryMetadata(path = "/tmp", flavor = "claude")),
            makeSummary(metadata = SessionSummaryMetadata(path = "/tmp", machineId = "Teemo")),
            makeSummary(
                metadata = SessionSummaryMetadata(
                    path = "/tmp",
                    worktree = WorktreeMetadata(
                        basePath = "/tmp", branch = "feat/x", name = "x", worktreePath = "/tmp/x",
                    ),
                )
            ),
            makeSummary(todoProgress = TodoProgress(1, 2)),
            makeSummary(pendingRequestKinds = listOf("input")),
            makeSummary(metadataVersion = 7),
            makeSummary(agentStateVersion = 7),
            makeSummary(todosUpdatedAt = 7),
        )
        for (changed in cases) {
            assertFalse(
                SummaryPatching.isRenderIrrelevantPatch(makeSummary(), changed.copy(activeAt = 11_000)),
                "expected relevant: $changed",
            )
        }
    }

    @Test
    fun `pendingRequests compare id kind tool but not since`() {
        val current = makeSummary(
            pendingRequests = listOf(PendingRequest("r1", "permission", "Bash", since = 1)),
        )
        val sinceOnly = makeSummary(
            pendingRequests = listOf(PendingRequest("r1", "permission", "Bash", since = 2)),
        )
        assertTrue(SummaryPatching.isRenderIrrelevantPatch(current, sinceOnly))

        val toolChanged = makeSummary(
            pendingRequests = listOf(PendingRequest("r1", "permission", "Edit", since = 1)),
        )
        assertFalse(SummaryPatching.isRenderIrrelevantPatch(current, toolChanged))
    }

    // ---------------------------------------- legacy detail-required gate --

    @Suppress("DEPRECATION")
    @Test
    fun `canApplyVersionedSummaryPatch mirrors the legacy rule`() {
        // Non-versioned patches never need detail.
        assertTrue(SummaryPatching.canApplyVersionedSummaryPatch(SessionPatch(), detailPresent = false))
        // metadata/agentState/todos each require detail.
        assertFalse(
            SummaryPatching.canApplyVersionedSummaryPatch(
                SessionPatch(metadata = VersionedValue(1, null)), detailPresent = false,
            )
        )
        assertFalse(
            SummaryPatching.canApplyVersionedSummaryPatch(
                SessionPatch(agentState = VersionedValue(1, null)), detailPresent = false,
            )
        )
        assertFalse(
            SummaryPatching.canApplyVersionedSummaryPatch(
                SessionPatch(todos = VersionedValue(1, emptyList())), detailPresent = false,
            )
        )
        // teamState-only is a summary no-op and never blocks.
        assertTrue(
            SummaryPatching.canApplyVersionedSummaryPatch(
                SessionPatch(teamState = VersionedValue(1, null)), detailPresent = false,
            )
        )
        // With detail present everything is allowed.
        assertTrue(
            SummaryPatching.canApplyVersionedSummaryPatch(
                SessionPatch(metadata = VersionedValue(2, null)), detailPresent = true,
            )
        )
    }
}

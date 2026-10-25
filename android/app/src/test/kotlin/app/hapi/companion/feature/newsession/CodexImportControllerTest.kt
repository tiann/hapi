@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package app.hapi.companion.feature.newsession

import app.hapi.protocol.wire.AgentAvailabilityResponse
import app.hapi.protocol.wire.CodexDesktopScriptResponse
import app.hapi.protocol.wire.CodexDesktopSyncRequest
import app.hapi.protocol.wire.CodexLocalSessionSummary
import app.hapi.protocol.wire.CodexLocalSessionsResponse
import app.hapi.protocol.wire.CodexModelsResponse
import app.hapi.protocol.wire.GrokModelsResponse
import app.hapi.protocol.wire.MachineListDirectoryResponse
import app.hapi.protocol.wire.MachinePathsExistsResponse
import app.hapi.protocol.wire.ResumeSessionResponse
import app.hapi.protocol.wire.SpawnResponse
import app.hapi.protocol.wire.SpawnSessionRequest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest

/**
 * Controller-level pin of the codex import flow (slice A) against the web
 * state machine: `web/src/components/CodexSessionSyncDialog.tsx` + the
 * codex-import branches of `web/src/components/NewSession/index.tsx`.
 */
class CodexImportControllerTest {

    private fun session(
        id: String,
        title: String = "Session $id",
        cwd: String? = "/repo",
    ): CodexLocalSessionSummary = CodexLocalSessionSummary(
        id = id,
        title = title,
        cwd = cwd,
        file = "/rollout/$id.json",
        modifiedAt = 1_700_000_000_000,
    )

    private class FakeGateway : NewSessionGateway {
        val codexSessionsCalls = mutableListOf<Pair<String?, String?>>()
        val syncCalls = mutableListOf<CodexDesktopSyncRequest>()
        val resumeCalls = mutableListOf<Pair<String, String?>>()

        var codexSessionsResult: CodexLocalSessionsResponse =
            CodexLocalSessionsResponse(success = true, sessions = emptyList())
        var codexSessionsThrows: Exception? = null
        var syncResult: CodexDesktopScriptResponse = CodexDesktopScriptResponse(success = true)
        var syncThrows: Exception? = null
        var resumeResult: ResumeSessionResponse = ResumeSessionResponse(sessionId = "s-resumed")
        var resumeThrows: Exception? = null

        override suspend fun spawn(machineId: String, request: SpawnSessionRequest): SpawnResponse =
            throw UnsupportedOperationException()

        override suspend fun listDirectory(
            machineId: String,
            path: String,
            includeHidden: Boolean,
        ): MachineListDirectoryResponse = throw UnsupportedOperationException()

        override suspend fun pathsExist(machineId: String, paths: List<String>): MachinePathsExistsResponse =
            throw UnsupportedOperationException()

        override suspend fun agentAvailability(machineId: String): AgentAvailabilityResponse =
            throw UnsupportedOperationException()

        override suspend fun codexModels(machineId: String): CodexModelsResponse =
            throw UnsupportedOperationException()

        override suspend fun grokModels(machineId: String, cwd: String): GrokModelsResponse =
            throw UnsupportedOperationException()

        override suspend fun getCodexSessions(cwd: String?, machineId: String?): CodexLocalSessionsResponse {
            codexSessionsCalls.add(cwd to machineId)
            codexSessionsThrows?.let { throw it }
            return codexSessionsResult
        }

        override suspend fun syncCodexSession(sync: CodexDesktopSyncRequest): CodexDesktopScriptResponse {
            syncCalls.add(sync)
            syncThrows?.let { throw it }
            return syncResult
        }

        override suspend fun resumeSession(sessionId: String, permissionMode: String?): ResumeSessionResponse {
            resumeCalls.add(sessionId to permissionMode)
            resumeThrows?.let { throw it }
            return resumeResult
        }
    }

    private class RecordingStore(initial: Map<String, Long> = emptyMap()) : CodexImportedSessionsStore {
        private val backing = MutableStateFlow(initial)
        override val markers: StateFlow<Map<String, Long>> = backing
        override suspend fun markImported(ids: List<String>, importedAt: Long) {
            backing.value = backing.value + ids.map { it to importedAt }
        }
        override suspend fun clearMarker(id: String) {
            backing.value = backing.value - id
        }
    }

    private fun TestScope.buildController(
        gateway: FakeGateway,
        store: CodexImportedSessionsStore = RecordingStore(),
        applied: MutableList<String> = mutableListOf(),
    ): CodexImportController {
        val controller = CodexImportController(
            scope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler)),
            gateway = gateway,
            store = store,
            applyDirectory = { applied.add(it) },
        )
        // Markers collector runs in the controller scope.
        advanceUntilIdle()
        return controller
    }

    // ---------------------------------------------------------------- load --

    @Test
    fun `load failure clears context and surfaces the error`() = runTest {
        val gateway = FakeGateway().apply { codexSessionsThrows = RuntimeException("rpc down") }
        val controller = buildController(gateway)

        controller.openDialog("/repo", "m1")
        advanceUntilIdle()

        val state = controller.state.value
        assertTrue(state.open)
        assertFalse(state.loading)
        assertTrue(state.sessions.isEmpty())
        assertNull(state.machineId)
        assertNull(state.selectedSessionId)
        assertEquals("rpc down", state.error)
        assertEquals(listOf<Pair<String?, String?>>("/repo" to "m1"), gateway.codexSessionsCalls)
    }

    @Test
    fun `soft-failure listing is silent and backfills the machine id`() = runTest {
        val gateway = FakeGateway().apply {
            codexSessionsResult = CodexLocalSessionsResponse(
                success = false,
                sessions = emptyList(),
                machineId = "m-echo",
            )
        }
        val controller = buildController(gateway)

        controller.openDialog("/repo", "m1")
        advanceUntilIdle()

        val state = controller.state.value
        assertNull(state.error, "web never checks success on the listing call")
        assertTrue(state.sessions.isEmpty())
        assertEquals("m-echo", state.machineId)
    }

    @Test
    fun `listing keeps the inline selection only while its session is listed`() = runTest {
        val gateway = FakeGateway().apply {
            codexSessionsResult = CodexLocalSessionsResponse(
                success = true,
                sessions = listOf(session("thread-1"), session("thread-2")),
            )
        }
        val controller = buildController(gateway)
        controller.openDialog("/repo", "m1")
        advanceUntilIdle()
        controller.selectInline(session("thread-2"))
        assertEquals("thread-2", controller.state.value.selectedSessionId)

        controller.load("/repo", "m1")
        advanceUntilIdle()
        assertEquals("thread-2", controller.state.value.selectedSessionId)

        gateway.codexSessionsResult = CodexLocalSessionsResponse(
            success = true,
            sessions = listOf(session("thread-1")),
        )
        controller.load("/repo", "m1")
        advanceUntilIdle()
        assertNull(controller.state.value.selectedSessionId)
    }

    @Test
    fun `workdir filter initializes once and falls back when its directory vanishes`() = runTest {
        val gateway = FakeGateway().apply {
            codexSessionsResult = CodexLocalSessionsResponse(
                success = true,
                sessions = listOf(session("a", cwd = "/alpha"), session("b", cwd = "/beta")),
            )
        }
        val controller = buildController(gateway)
        controller.openDialog("/alpha", "m1")
        advanceUntilIdle()
        assertEquals("/alpha", controller.state.value.workdirFilter, "current directory is among the options")

        // A reload never re-initializes the filter (one-shot init).
        controller.setWorkdirFilter("/beta")
        controller.load("/alpha", "m1")
        advanceUntilIdle()
        assertEquals("/beta", controller.state.value.workdirFilter, "user choice survives reloads")

        // A filter whose directory disappears from the list falls back to the default.
        gateway.codexSessionsResult = CodexLocalSessionsResponse(
            success = true,
            sessions = listOf(session("a", cwd = "/alpha")),
        )
        controller.load("/alpha", "m1")
        advanceUntilIdle()
        assertEquals("/alpha", controller.state.value.workdirFilter)
    }

    @Test
    fun `workdir filter stays on all when the current directory is not listed`() = runTest {
        val gateway = FakeGateway().apply {
            codexSessionsResult = CodexLocalSessionsResponse(
                success = true,
                sessions = listOf(session("a", cwd = "/alpha")),
            )
        }
        val controller = buildController(gateway)
        controller.openDialog("/nowhere", "m1")
        advanceUntilIdle()
        assertEquals(CodexImportLogic.ALL_WORKDIR_FILTER, controller.state.value.workdirFilter)
    }

    @Test
    fun `checkbox init pre-checks the inline selection unless already imported`() = runTest {
        val gateway = FakeGateway().apply {
            codexSessionsResult = CodexLocalSessionsResponse(
                success = true,
                sessions = listOf(session("a"), session("b")),
            )
        }
        val store = RecordingStore(mapOf("b" to 1L))
        val controller = buildController(gateway, store)
        controller.selectInline(session("b")) // already imported

        controller.openDialog("/repo", "m1")
        advanceUntilIdle()
        assertEquals(emptySet(), controller.state.value.dialogSelection, "imported session is not default-checked")

        // Reopen with a fresh inline selection: the checkboxes re-initialize.
        controller.close()
        controller.selectInline(session("a"))
        controller.openDialog("/repo", "m1")
        advanceUntilIdle()
        assertEquals(setOf("a"), controller.state.value.dialogSelection)
    }

    // ------------------------------------------------------------- confirm --

    @Test
    fun `confirm with one row selects inline, applies its cwd and closes`() = runTest {
        val gateway = FakeGateway().apply {
            codexSessionsResult = CodexLocalSessionsResponse(
                success = true,
                sessions = listOf(session("thread-1", cwd = " /repo ")),
            )
        }
        val applied = mutableListOf<String>()
        val controller = buildController(gateway, applied = applied)
        controller.openDialog("/repo", "m1")
        advanceUntilIdle()

        controller.toggleSession("thread-1")
        controller.confirm()
        advanceUntilIdle()

        val state = controller.state.value
        assertFalse(state.open)
        assertEquals("thread-1", state.selectedSessionId)
        assertEquals(listOf("/repo"), applied, "cwd is trimmed before applying to the form")
        assertEquals(0, gateway.syncCalls.size, "single-row confirm never syncs")
    }

    @Test
    fun `confirm with many rows bulk-imports, marks, trims selection and closes`() = runTest {
        val gateway = FakeGateway().apply {
            codexSessionsResult = CodexLocalSessionsResponse(
                success = true,
                sessions = listOf(session("a"), session("b"), session("c")),
                machineId = "m-echo",
            )
            syncResult = CodexDesktopScriptResponse(success = true, syncedCount = 2)
        }
        val store = RecordingStore()
        val controller = buildController(gateway, store)
        controller.openDialog("  /repo  ", "m-form")
        advanceUntilIdle()
        controller.toggleSession("a")
        controller.toggleSession("b")
        controller.selectInline(session("c")) // inline selection survives (not in batch)

        controller.confirm()
        advanceUntilIdle()

        val request = gateway.syncCalls.single()
        assertEquals(listOf("a", "b"), request.sessionIds)
        assertEquals("/repo", request.cwd, "form directory is trimmed in the bulk payload")
        assertEquals("m-echo", request.machineId, "listing machine id wins over the form machine")

        val state = controller.state.value
        assertFalse(state.open)
        assertEquals("c", state.selectedSessionId, "inline selection kept: outside the batch")
        assertTrue(store.markers.value.containsKey("a"))
        assertTrue(store.markers.value.containsKey("b"))
        assertFalse(store.markers.value.containsKey("c"))
        assertNull(state.importError)
    }

    @Test
    fun `bulk import clears the inline selection when it was part of the batch`() = runTest {
        val gateway = FakeGateway().apply {
            codexSessionsResult = CodexLocalSessionsResponse(
                success = true,
                sessions = listOf(session("a"), session("b")),
            )
            syncResult = CodexDesktopScriptResponse(success = true)
        }
        val controller = buildController(gateway)
        controller.openDialog("/repo", "m1")
        advanceUntilIdle()
        controller.selectInline(session("a"))
        controller.toggleSession("a")
        controller.toggleSession("b")

        controller.confirm()
        advanceUntilIdle()

        assertNull(controller.state.value.selectedSessionId)
        assertFalse(controller.state.value.open)
    }

    @Test
    fun `bulk import keeps the dialog open on soft failure with the normalized error`() = runTest {
        val gateway = FakeGateway().apply {
            codexSessionsResult = CodexLocalSessionsResponse(
                success = true,
                sessions = listOf(session("a"), session("b")),
            )
            syncResult = CodexDesktopScriptResponse(success = false, error = "disk full")
        }
        val store = RecordingStore()
        val controller = buildController(gateway, store)
        controller.openDialog("/repo", "m1")
        advanceUntilIdle()
        controller.toggleSession("a")
        controller.toggleSession("b")

        controller.confirm()
        advanceUntilIdle()

        val state = controller.state.value
        assertTrue(state.open)
        assertEquals(setOf("a", "b"), state.dialogSelection, "selection survives a failed import")
        assertEquals("Import failed: disk full", state.importError)
        assertFalse(state.importing)
        assertTrue(store.markers.value.isEmpty())
    }

    @Test
    fun `timeout and active-thread errors are classified`() = runTest {
        val gateway = FakeGateway().apply {
            codexSessionsResult = CodexLocalSessionsResponse(
                success = true,
                sessions = listOf(session("a"), session("b")),
            )
        }
        val controller = buildController(gateway)
        controller.openDialog("/repo", "m1")
        advanceUntilIdle()
        controller.toggleSession("a")
        controller.toggleSession("b")

        gateway.syncResult = CodexDesktopScriptResponse(success = false, error = "Command timed out after 30s")
        controller.confirm()
        advanceUntilIdle()
        assertEquals("Operation timed out", controller.state.value.importError, "classified, no reason prefix")

        // The selection survived the failed import; retry with another error.
        gateway.syncResult = CodexDesktopScriptResponse(
            success = false,
            error = "Active Hapi process already has this Codex thread",
        )
        controller.confirm()
        advanceUntilIdle()
        assertEquals(
            "This session is still active. Please wait until it ends and try again.",
            controller.state.value.importError,
        )
    }

    @Test
    fun `bulk import exception is formatted with the reason`() = runTest {
        val gateway = FakeGateway().apply {
            codexSessionsResult = CodexLocalSessionsResponse(
                success = true,
                sessions = listOf(session("a"), session("b")),
            )
            syncThrows = RuntimeException("socket reset")
        }
        val controller = buildController(gateway)
        controller.openDialog("/repo", "m1")
        advanceUntilIdle()
        controller.toggleSession("a")
        controller.toggleSession("b")

        controller.confirm()
        advanceUntilIdle()

        assertTrue(controller.state.value.open)
        assertEquals("Import failed: socket reset", controller.state.value.importError)
    }

    @Test
    fun `machine id falls back to the form machine when the listing had none`() = runTest {
        val gateway = FakeGateway().apply {
            codexSessionsResult = CodexLocalSessionsResponse(
                success = true,
                sessions = listOf(session("a"), session("b")),
            )
            syncResult = CodexDesktopScriptResponse(success = true)
        }
        val controller = buildController(gateway)
        controller.openDialog("/repo", "m-form")
        advanceUntilIdle()
        controller.toggleSession("a")
        controller.toggleSession("b")

        controller.confirm()
        advanceUntilIdle()

        assertEquals("m-form", gateway.syncCalls.single().machineId)
    }

    // ----------------------------------------------------- import at create --

    @Test
    fun `import at create syncs, resumes with the permission mode and marks imported`() = runTest {
        val gateway = FakeGateway().apply {
            syncResult = CodexDesktopScriptResponse(
                success = true,
                hapiSessionIds = listOf("h-1"),
            )
        }
        val store = RecordingStore()
        val controller = buildController(gateway, store)
        val request = CodexDesktopSyncRequest(sessionIds = listOf("thread-1"), collaborationMode = "default")

        val result = controller.importAtCreate(request, permissionMode = "yolo")

        assertEquals(CodexImportAtCreateResult.Imported("s-resumed"), result)
        assertEquals(listOf(request), gateway.syncCalls)
        assertEquals(listOf<Pair<String, String?>>("h-1" to "yolo"), gateway.resumeCalls, "non-default mode travels to resume")
        assertTrue(store.markers.value.containsKey("thread-1"))
        assertFalse(controller.state.value.importingAtCreate)

        // Default mode omits the resume permissionMode (web parity).
        gateway.syncResult = CodexDesktopScriptResponse(success = true, hapiSessionIds = listOf("h-2"))
        val second = controller.importAtCreate(
            CodexDesktopSyncRequest(sessionIds = listOf("thread-2")),
            permissionMode = "default",
        )
        assertEquals(CodexImportAtCreateResult.Imported("s-resumed"), second)
        assertEquals("h-2" to null, gateway.resumeCalls.last())
    }

    @Test
    fun `import at create surfaces soft failures raw`() = runTest {
        val gateway = FakeGateway().apply {
            syncResult = CodexDesktopScriptResponse(success = false, error = "boom")
        }
        val controller = buildController(gateway)

        val result = controller.importAtCreate(
            CodexDesktopSyncRequest(sessionIds = listOf("thread-1")),
            permissionMode = "default",
        )

        assertEquals(CodexImportAtCreateResult.Failed("boom"), result)
        assertEquals(0, gateway.resumeCalls.size)
        assertFalse(controller.state.value.importingAtCreate)
    }

    @Test
    fun `import at create without a hapi session id fails loudly`() = runTest {
        val gateway = FakeGateway().apply {
            syncResult = CodexDesktopScriptResponse(success = true, hapiSessionIds = emptyList())
        }
        val controller = buildController(gateway)

        val result = controller.importAtCreate(
            CodexDesktopSyncRequest(sessionIds = listOf("thread-1")),
            permissionMode = "default",
        )

        assertEquals(CodexImportAtCreateResult.Failed("Imported session id missing"), result)
        assertEquals(0, gateway.resumeCalls.size)
    }

    @Test
    fun `import at create wraps thrown errors with the create fallback`() = runTest {
        val gateway = FakeGateway().apply {
            syncResult = CodexDesktopScriptResponse(success = true, hapiSessionIds = listOf("h-1"))
            resumeThrows = RuntimeException("resume exploded")
        }
        val controller = buildController(gateway)

        val result = controller.importAtCreate(
            CodexDesktopSyncRequest(sessionIds = listOf("thread-1")),
            permissionMode = "default",
        )

        assertEquals(CodexImportAtCreateResult.Failed("resume exploded"), result)

        gateway.resumeThrows = RuntimeException()
        val blank = controller.importAtCreate(
            CodexDesktopSyncRequest(sessionIds = listOf("thread-1")),
            permissionMode = "default",
        )
        assertEquals(CodexImportAtCreateResult.Failed("Failed to create session"), blank)
    }

    // -------------------------------------------------------------- resets --

    @Test
    fun `agent change reset drops everything including the open dialog`() = runTest {
        val gateway = FakeGateway().apply {
            codexSessionsResult = CodexLocalSessionsResponse(
                success = true,
                sessions = listOf(session("a")),
            )
        }
        val controller = buildController(gateway)
        controller.openDialog("/repo", "m1")
        advanceUntilIdle()
        controller.toggleSession("a")

        controller.resetForAgentChange()
        advanceUntilIdle()

        val state = controller.state.value
        assertFalse(state.open)
        assertFalse(state.loading)
        assertTrue(state.sessions.isEmpty())
        assertNull(state.machineId)
        assertNull(state.selectedSessionId)
        assertNull(state.error)
    }

    @Test
    fun `context change reset keeps the dialog flag but clears the listing`() = runTest {
        val gateway = FakeGateway().apply {
            codexSessionsResult = CodexLocalSessionsResponse(
                success = true,
                sessions = listOf(session("a")),
            )
        }
        val controller = buildController(gateway)
        controller.openDialog("/repo", "m1")
        advanceUntilIdle()

        controller.resetForContextChange()
        advanceUntilIdle()

        val state = controller.state.value
        assertTrue(state.open)
        assertTrue(state.sessions.isEmpty())
        assertNull(state.machineId)
        assertNull(state.selectedSessionId)
    }

    @Test
    fun `select all replaces the selection with the filtered rows`() = runTest {
        val gateway = FakeGateway().apply {
            codexSessionsResult = CodexLocalSessionsResponse(
                success = true,
                sessions = listOf(session("a", cwd = "/alpha"), session("b", cwd = "/beta")),
            )
        }
        val controller = buildController(gateway)
        controller.openDialog("/alpha", "m1")
        advanceUntilIdle()
        controller.toggleSession("b") // outside /alpha

        controller.selectAll()
        assertEquals(setOf("a"), controller.state.value.dialogSelection)

        controller.setWorkdirFilter(CodexImportLogic.ALL_WORKDIR_FILTER)
        controller.selectAll()
        assertEquals(setOf("a", "b"), controller.state.value.dialogSelection)

        controller.clearSelection()
        assertEquals(emptySet(), controller.state.value.dialogSelection)
    }
}

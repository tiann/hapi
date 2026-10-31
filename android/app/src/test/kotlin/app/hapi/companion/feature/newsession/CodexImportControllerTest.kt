@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package app.hapi.companion.feature.newsession

import app.hapi.protocol.wire.AgentAvailabilityResponse
import app.hapi.protocol.wire.CodexArchiveSessionResponse
import app.hapi.protocol.wire.CodexDesktopScriptResponse
import app.hapi.protocol.wire.CodexDesktopStatusResponse
import app.hapi.protocol.wire.CodexDesktopSyncRequest
import app.hapi.protocol.wire.CodexDuplicateSessionGroup
import app.hapi.protocol.wire.CodexDuplicateSessionsResponse
import app.hapi.protocol.wire.CodexLocalSessionSummary
import app.hapi.protocol.wire.CodexLocalSessionsResponse
import app.hapi.protocol.wire.CodexMergeDuplicateSessionsResponse
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
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
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
        val archiveCalls = mutableListOf<Pair<String, String?>>()
        val statusCalls = mutableListOf<Int>()
        val duplicateCalls = mutableListOf<CodexDesktopSyncRequest>()
        val mergeCalls = mutableListOf<CodexDesktopSyncRequest>()
        val restartCalls = mutableListOf<Int>()

        var codexSessionsResult: CodexLocalSessionsResponse =
            CodexLocalSessionsResponse(success = true, sessions = emptyList())
        var codexSessionsThrows: Exception? = null
        var syncResult: CodexDesktopScriptResponse = CodexDesktopScriptResponse(success = true)
        var syncThrows: Exception? = null
        /** Suspends the sync call until completed — pins the in-flight window. */
        var syncGate: kotlinx.coroutines.CompletableDeferred<Unit>? = null
        var resumeResult: ResumeSessionResponse = ResumeSessionResponse(sessionId = "s-resumed")
        var resumeThrows: Exception? = null
        var archiveResult: CodexArchiveSessionResponse = CodexArchiveSessionResponse(success = true)
        var archiveThrows: Exception? = null
        var statusResult: CodexDesktopStatusResponse =
            CodexDesktopStatusResponse(success = true, codexClientAvailable = true)
        var duplicateResult: CodexDuplicateSessionsResponse =
            CodexDuplicateSessionsResponse(success = true)
        var duplicateThrows: Exception? = null
        var mergeResult: CodexMergeDuplicateSessionsResponse =
            CodexMergeDuplicateSessionsResponse(success = true)
        var mergeThrows: Exception? = null
        var restartResult: CodexDesktopScriptResponse = CodexDesktopScriptResponse(success = true)

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
            syncGate?.await()
            syncThrows?.let { throw it }
            return syncResult
        }

        override suspend fun resumeSession(sessionId: String, permissionMode: String?): ResumeSessionResponse {
            resumeCalls.add(sessionId to permissionMode)
            resumeThrows?.let { throw it }
            return resumeResult
        }

        override suspend fun archiveCodexSession(
            sessionId: String,
            machineId: String?,
        ): CodexArchiveSessionResponse {
            archiveCalls.add(sessionId to machineId)
            archiveThrows?.let { throw it }
            return archiveResult
        }

        override suspend fun getCodexDesktopStatus(): CodexDesktopStatusResponse {
            statusCalls.add(1)
            return statusResult
        }

        override suspend fun getCodexDuplicateSessions(payload: CodexDesktopSyncRequest): CodexDuplicateSessionsResponse {
            duplicateCalls.add(payload)
            duplicateThrows?.let { throw it }
            return duplicateResult
        }

        override suspend fun mergeCodexDuplicateSessions(payload: CodexDesktopSyncRequest): CodexMergeDuplicateSessionsResponse {
            mergeCalls.add(payload)
            mergeThrows?.let { throw it }
            return mergeResult
        }

        override suspend fun restartCodexDesktop(): CodexDesktopScriptResponse {
            restartCalls.add(1)
            return restartResult
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
        navigated: MutableList<String> = mutableListOf(),
    ): CodexImportController {
        val controller = CodexImportController(
            scope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler)),
            gateway = gateway,
            store = store,
            applyDirectory = { applied.add(it) },
            navigateToSession = { navigated.add(it) },
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
    fun `confirm keeps the dialog open when the single checked row was archived`() = runTest {
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

        // The row is archived externally (e.g. from the desktop client) after
        // it was checked — the listing no longer contains it.
        controller.archive("a")
        advanceUntilIdle()

        controller.confirm()
        advanceUntilIdle()

        val state = controller.state.value
        assertTrue(state.open, "dialog stays open instead of silently closing")
        assertTrue(state.confirmSelectionMissing, "visible notice is armed")
        assertEquals(setOf("a"), state.dialogSelection, "checked row is not cleared")
        assertNull(state.selectedSessionId, "no selection was made")
        assertEquals(0, gateway.syncCalls.size, "nothing is synced for a vanished row")

        // Recovering: re-picking clears the notice and confirms fine (the
        // stale archived id is dropped first so the single-row path runs).
        controller.clearSelection()
        assertFalse(controller.state.value.confirmSelectionMissing, "notice clears with the selection change")
        controller.toggleSession("b")
        controller.confirm()
        advanceUntilIdle()

        val recovered = controller.state.value
        assertFalse(recovered.open)
        assertFalse(recovered.confirmSelectionMissing)
        assertEquals("b", recovered.selectedSessionId)
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

    // --------------------------------------------------- dismissal feedback --

    @Test
    fun `dismissing the sheet mid bulk import keeps the failure observable`() = runTest {
        val gateway = FakeGateway().apply {
            codexSessionsResult = CodexLocalSessionsResponse(
                success = true,
                sessions = listOf(session("a"), session("b")),
            )
            syncGate = CompletableDeferred()
            syncResult = CodexDesktopScriptResponse(success = false, error = "disk full")
        }
        val store = RecordingStore()
        val controller = buildController(gateway, store)
        controller.openDialog("/repo", "m1")
        advanceUntilIdle()
        controller.toggleSession("a")
        controller.toggleSession("b")

        controller.confirm()
        runCurrent() // coroutine reaches the gated sync call
        assertTrue(controller.state.value.importing)
        controller.close() // Back/scrim/swipe while in flight
        assertFalse(controller.state.value.open)

        gateway.syncGate?.complete(Unit)
        advanceUntilIdle()

        val state = controller.state.value
        assertFalse(state.open)
        assertFalse(state.importing)
        assertEquals("Import failed: disk full", state.importError, "failure survives the dismissal")
        assertTrue(store.markers.value.isEmpty(), "failed import marks nothing")
    }

    @Test
    fun `import finishing after a mid-flight dismissal succeeds without leftovers`() = runTest {
        val gateway = FakeGateway().apply {
            codexSessionsResult = CodexLocalSessionsResponse(
                success = true,
                sessions = listOf(session("a"), session("b")),
            )
            syncGate = CompletableDeferred()
            syncResult = CodexDesktopScriptResponse(success = true, syncedCount = 2)
        }
        val store = RecordingStore()
        val controller = buildController(gateway, store)
        controller.openDialog("/repo", "m1")
        advanceUntilIdle()
        controller.toggleSession("a")
        controller.toggleSession("b")

        controller.confirm()
        runCurrent()
        assertTrue(controller.state.value.importing)
        controller.close()

        gateway.syncGate?.complete(Unit)
        advanceUntilIdle()

        val state = controller.state.value
        assertFalse(state.open)
        assertFalse(state.importing)
        assertNull(state.importError, "success clears any stale error")
        assertTrue(store.markers.value.containsKey("a"))
        assertTrue(store.markers.value.containsKey("b"))
    }

    @Test
    fun `closing after a failed import retains the error until the dialog reopens`() = runTest {
        val gateway = FakeGateway().apply {
            codexSessionsResult = CodexLocalSessionsResponse(
                success = true,
                sessions = listOf(session("a"), session("b")),
            )
            syncResult = CodexDesktopScriptResponse(success = false, error = "disk full")
        }
        val controller = buildController(gateway)
        controller.openDialog("/repo", "m1")
        advanceUntilIdle()
        controller.toggleSession("a")
        controller.toggleSession("b")
        controller.confirm()
        advanceUntilIdle()
        assertTrue(controller.state.value.open)
        assertEquals("Import failed: disk full", controller.state.value.importError)

        controller.close()
        assertFalse(controller.state.value.open)
        assertEquals("Import failed: disk full", controller.state.value.importError, "retained for the inline section")

        controller.openDialog("/repo", "m1")
        advanceUntilIdle()
        assertNull(controller.state.value.importError, "reopening starts clean")
    }

    @Test
    fun `single row confirm drops any stale import error`() = runTest {
        val gateway = FakeGateway().apply {
            codexSessionsResult = CodexLocalSessionsResponse(
                success = true,
                sessions = listOf(session("a"), session("b")),
            )
            syncResult = CodexDesktopScriptResponse(success = false, error = "disk full")
        }
        val controller = buildController(gateway)
        controller.openDialog("/repo", "m1")
        advanceUntilIdle()
        controller.toggleSession("a")
        controller.toggleSession("b")
        controller.confirm()
        advanceUntilIdle()
        assertEquals("Import failed: disk full", controller.state.value.importError)

        // User resolves the situation with an inline pick instead.
        controller.toggleSession("b")
        controller.confirm()
        advanceUntilIdle()

        val state = controller.state.value
        assertFalse(state.open)
        assertEquals("a", state.selectedSessionId)
        assertNull(state.importError, "a clean inline pick clears the stale failure")
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

    // --------------------------------------------- duplicate detection (B) --

    @Test
    fun `bulk import with duplicates arms the merge confirm state`() = runTest {
        val groups = listOf(
            CodexDuplicateSessionGroup(
                codexSessionId = "a",
                hapiSessionIds = listOf("h1", "h2"),
                canonicalSessionId = "h1",
                removedSessionIds = listOf("h2"),
            ),
        )
        val gateway = FakeGateway().apply {
            codexSessionsResult = CodexLocalSessionsResponse(
                success = true,
                sessions = listOf(session("a"), session("b")),
            )
            syncResult = CodexDesktopScriptResponse(success = true, hapiSessionIds = listOf("h1", "h2"))
            duplicateResult = CodexDuplicateSessionsResponse(success = true, duplicates = groups)
        }
        val controller = buildController(gateway)
        controller.openDialog("/repo", "m1")
        advanceUntilIdle()
        controller.toggleSession("a")
        controller.toggleSession("b")

        controller.confirm()
        advanceUntilIdle()

        val state = controller.state.value
        assertFalse(state.open, "import succeeded and the dialog closed")
        assertTrue(state.duplicateMergeConfirmOpen, "duplicates arm the confirm")
        assertEquals(listOf("a", "b"), state.pendingDuplicateSessionIds, "pending batch == the imported batch")
        assertEquals(listOf("h1", "h2"), state.pendingDuplicateHapiSessionIds)
        assertEquals(groups, state.duplicateSessionGroups)
        assertNull(state.duplicateDetectError)

        val detection = gateway.duplicateCalls.single()
        assertEquals(listOf("a", "b"), detection.sessionIds)
        assertNull(detection.cwd, "detection payload carries only sessionIds")
        assertNull(detection.machineId)
    }

    @Test
    fun `bulk import without duplicates leaves the confirm closed`() = runTest {
        val gateway = FakeGateway().apply {
            codexSessionsResult = CodexLocalSessionsResponse(
                success = true,
                sessions = listOf(session("a"), session("b")),
            )
            syncResult = CodexDesktopScriptResponse(success = true, hapiSessionIds = listOf("h1"))
        }
        val controller = buildController(gateway)
        controller.openDialog("/repo", "m1")
        advanceUntilIdle()
        controller.toggleSession("a")
        controller.toggleSession("b")

        controller.confirm()
        advanceUntilIdle()

        val state = controller.state.value
        assertFalse(state.duplicateMergeConfirmOpen)
        assertTrue(state.pendingDuplicateSessionIds.isEmpty())
        assertTrue(state.duplicateSessionGroups.isEmpty())
    }

    @Test
    fun `failed duplicate detection never disturbs the finished import`() = runTest {
        val gateway = FakeGateway().apply {
            codexSessionsResult = CodexLocalSessionsResponse(
                success = true,
                sessions = listOf(session("a"), session("b")),
            )
            syncResult = CodexDesktopScriptResponse(success = true, hapiSessionIds = listOf("h1"))
            duplicateResult = CodexDuplicateSessionsResponse(success = false, error = "busy")
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
        assertFalse(state.open, "the import itself stands")
        assertTrue(store.markers.value.containsKey("a"))
        assertEquals("busy", state.duplicateDetectError, "soft failure is surfaced inline")
        assertFalse(state.duplicateMergeConfirmOpen)

        // Thrown detection errors surface the same way.
        gateway.duplicateThrows = RuntimeException("probe exploded")
        controller.bulkImport(listOf("a", "b"))
        advanceUntilIdle()
        assertEquals("probe exploded", controller.state.value.duplicateDetectError)
        assertTrue(controller.state.value.pendingDuplicateSessionIds.isEmpty())
    }

    @Test
    fun `pending duplicate state is flushed by the next bulk import`() = runTest {
        val gateway = FakeGateway().apply {
            codexSessionsResult = CodexLocalSessionsResponse(
                success = true,
                sessions = listOf(session("a"), session("b")),
            )
            syncResult = CodexDesktopScriptResponse(success = true, hapiSessionIds = listOf("h1"))
            duplicateResult = CodexDuplicateSessionsResponse(
                success = true,
                duplicates = listOf(
                    CodexDuplicateSessionGroup("a", hapiSessionIds = listOf("h1"), canonicalSessionId = "h1"),
                ),
            )
        }
        val controller = buildController(gateway)
        controller.bulkImport(listOf("a"))
        advanceUntilIdle()
        assertTrue(controller.state.value.duplicateMergeConfirmOpen)

        // Next import without duplicates flushes the stale pending state.
        gateway.duplicateResult = CodexDuplicateSessionsResponse(success = true)
        controller.bulkImport(listOf("b"))
        advanceUntilIdle()

        val state = controller.state.value
        assertFalse(state.duplicateMergeConfirmOpen)
        assertTrue(state.pendingDuplicateSessionIds.isEmpty())
        assertTrue(state.duplicateSessionGroups.isEmpty())
        assertEquals(
            listOf("h1"),
            state.pendingDuplicateHapiSessionIds,
            "web keeps the newest import's hapi ids armed unconditionally",
        )
    }

    // ---------------------------------------------------------- merge (B) --

    @Test
    fun `merge success clears the pending state and navigates to the canonical survivor`() = runTest {
        val gateway = FakeGateway().apply {
            syncResult = CodexDesktopScriptResponse(success = true, hapiSessionIds = listOf("h1", "h2"))
            duplicateResult = CodexDuplicateSessionsResponse(
                success = true,
                duplicates = listOf(
                    CodexDuplicateSessionGroup("a", hapiSessionIds = listOf("h1", "h2"), canonicalSessionId = "h1"),
                ),
            )
            mergeResult = CodexMergeDuplicateSessionsResponse(
                success = true,
                merged = listOf(
                    CodexDuplicateSessionGroup("a", hapiSessionIds = listOf("h1", "h2"), canonicalSessionId = "h9"),
                ),
                mergedCount = 1,
            )
        }
        val navigated = mutableListOf<String>()
        val controller = buildController(gateway, navigated = navigated)
        controller.bulkImport(listOf("a"))
        advanceUntilIdle()
        assertTrue(controller.state.value.duplicateMergeConfirmOpen)

        controller.mergeDuplicates()
        advanceUntilIdle()

        assertEquals(listOf("a"), gateway.mergeCalls.single().sessionIds, "merge re-sends the pending batch")
        assertEquals(listOf("h9"), navigated, "navigates to the merge's canonical survivor")
        val state = controller.state.value
        assertFalse(state.duplicateMergeConfirmOpen)
        assertTrue(state.pendingDuplicateSessionIds.isEmpty())
        assertNull(state.duplicateMergeError)
        assertFalse(state.mergingDuplicates)
    }

    @Test
    fun `merge success falls back to the first imported hapi session`() = runTest {
        val gateway = FakeGateway().apply {
            syncResult = CodexDesktopScriptResponse(success = true, hapiSessionIds = listOf("h1", "h2"))
            duplicateResult = CodexDuplicateSessionsResponse(
                success = true,
                duplicates = listOf(CodexDuplicateSessionGroup("a", hapiSessionIds = listOf("h1", "h2"))),
            )
            mergeResult = CodexMergeDuplicateSessionsResponse(success = true, mergedCount = 1)
        }
        val navigated = mutableListOf<String>()
        val controller = buildController(gateway, navigated = navigated)
        controller.bulkImport(listOf("a"))
        advanceUntilIdle()

        controller.mergeDuplicates()
        advanceUntilIdle()

        assertEquals(listOf("h1"), navigated)
    }

    @Test
    fun `merge failure keeps the confirm dialog open and retryable`() = runTest {
        val gateway = FakeGateway().apply {
            syncResult = CodexDesktopScriptResponse(success = true, hapiSessionIds = listOf("h1"))
            duplicateResult = CodexDuplicateSessionsResponse(
                success = true,
                duplicates = listOf(
                    CodexDuplicateSessionGroup("a", hapiSessionIds = listOf("h1"), canonicalSessionId = "h1"),
                ),
            )
            mergeResult = CodexMergeDuplicateSessionsResponse(success = false, error = "merge script died")
        }
        val navigated = mutableListOf<String>()
        val controller = buildController(gateway, navigated = navigated)
        controller.bulkImport(listOf("a"))
        advanceUntilIdle()

        controller.mergeDuplicates()
        advanceUntilIdle()

        val state = controller.state.value
        assertTrue(state.duplicateMergeConfirmOpen, "failure leaves the dialog open (web rethrow)")
        assertEquals("merge script died", state.duplicateMergeError)
        assertTrue(navigated.isEmpty())

        // Retry after fixing the backend: the pending batch is still armed.
        gateway.mergeResult = CodexMergeDuplicateSessionsResponse(success = true, mergedCount = 1)
        controller.mergeDuplicates()
        advanceUntilIdle()
        assertEquals(2, gateway.mergeCalls.size)
        assertEquals(listOf("h1"), navigated)
        assertFalse(controller.state.value.duplicateMergeConfirmOpen)
    }

    @Test
    fun `close duplicate merge dialog clears every pending slot`() = runTest {
        val gateway = FakeGateway().apply {
            syncResult = CodexDesktopScriptResponse(success = true, hapiSessionIds = listOf("h1"))
            duplicateResult = CodexDuplicateSessionsResponse(
                success = true,
                duplicates = listOf(
                    CodexDuplicateSessionGroup("a", hapiSessionIds = listOf("h1"), canonicalSessionId = "h1"),
                ),
            )
        }
        val controller = buildController(gateway)
        controller.bulkImport(listOf("a"))
        advanceUntilIdle()
        controller.mergeDuplicates()
        advanceUntilIdle()

        controller.closeDuplicateMergeDialog()
        val state = controller.state.value
        assertTrue(state.pendingDuplicateSessionIds.isEmpty())
        assertTrue(state.pendingDuplicateHapiSessionIds.isEmpty())
        assertTrue(state.duplicateSessionGroups.isEmpty())
        assertNull(state.duplicateMergeError)
    }

    // -------------------------------------------------------- archive (B) --

    @Test
    fun `archive removes the row and the inline selection when it pointed there`() = runTest {
        val gateway = FakeGateway().apply {
            codexSessionsResult = CodexLocalSessionsResponse(
                success = true,
                sessions = listOf(session("a"), session("b")),
                machineId = "m-echo",
            )
        }
        val controller = buildController(gateway)
        controller.openDialog("/repo", "m-form")
        advanceUntilIdle()
        controller.selectInline(session("a"))

        controller.archive("a")
        advanceUntilIdle()

        assertEquals(listOf<Pair<String, String?>>("a" to "m-echo"), gateway.archiveCalls, "listing machine wins")
        val state = controller.state.value
        assertTrue(state.sessions.map { it.id }.containsAll(listOf("b")))
        assertFalse(state.sessions.any { it.id == "a" }, "archived row is removed")
        assertNull(state.selectedSessionId, "inline selection pointing at it is cleared")
        assertNull(state.archiveError)
    }

    @Test
    fun `archive keeps an unrelated inline selection`() = runTest {
        val gateway = FakeGateway().apply {
            codexSessionsResult = CodexLocalSessionsResponse(
                success = true,
                sessions = listOf(session("a"), session("b")),
            )
        }
        val controller = buildController(gateway)
        controller.openDialog("/repo", "m1")
        advanceUntilIdle()
        controller.selectInline(session("b"))

        controller.archive("a")
        advanceUntilIdle()

        assertEquals("b", controller.state.value.selectedSessionId)
    }

    @Test
    fun `archive failure lands in the dialog banner`() = runTest {
        val gateway = FakeGateway().apply {
            codexSessionsResult = CodexLocalSessionsResponse(
                success = true,
                sessions = listOf(session("a")),
                machineId = null,
            )
            archiveResult = CodexArchiveSessionResponse(success = false, error = "file locked")
        }
        val controller = buildController(gateway)
        controller.openDialog("/repo", "m-form")
        advanceUntilIdle()

        controller.archive("a")
        advanceUntilIdle()

        assertEquals(listOf<Pair<String, String?>>("a" to "m-form"), gateway.archiveCalls, "form machine as fallback")
        assertEquals("file locked", controller.state.value.archiveError)
        assertTrue(controller.state.value.sessions.any { it.id == "a" }, "row stays after a failed archive")

        gateway.archiveResult = CodexArchiveSessionResponse(success = true)
        gateway.archiveThrows = RuntimeException("socket reset")
        controller.archive("a")
        advanceUntilIdle()
        assertEquals("socket reset", controller.state.value.archiveError)
    }

    // -------------------------------------------------------- restart (B) --

    @Test
    fun `restart with an unavailable client never calls restart-desktop`() = runTest {
        val gateway = FakeGateway().apply {
            statusResult = CodexDesktopStatusResponse(
                success = true,
                codexDesktopRunning = true,
                codexClientAvailable = false,
            )
        }
        val controller = buildController(gateway)

        controller.restart()
        advanceUntilIdle()

        assertEquals(1, gateway.statusCalls.size)
        assertEquals(0, gateway.restartCalls.size, "not-found short-circuits before the restart call")
        val state = controller.state.value
        assertEquals(
            CodexImportStrings().clientNotFound,
            state.restartError,
            "not-found message, un-normalized probe failure",
        )
        assertFalse(state.restartStarted)
        assertFalse(state.restartingDesktop)
    }

    @Test
    fun `restart success sets the started notice`() = runTest {
        val gateway = FakeGateway()
        val controller = buildController(gateway)

        controller.restart()
        advanceUntilIdle()

        assertEquals(1, gateway.statusCalls.size)
        assertEquals(1, gateway.restartCalls.size)
        val state = controller.state.value
        assertTrue(state.restartStarted)
        assertNull(state.restartError)
        assertFalse(state.restartingDesktop)
    }

    @Test
    fun `restart script failure is normalized into the error slot`() = runTest {
        val gateway = FakeGateway().apply {
            restartResult = CodexDesktopScriptResponse(success = false, error = "Command timed out")
        }
        val controller = buildController(gateway)

        controller.restart()
        advanceUntilIdle()

        assertEquals("Operation timed out", controller.state.value.restartError)
        assertFalse(controller.state.value.restartStarted)
    }
}

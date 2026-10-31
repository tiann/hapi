@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package app.hapi.companion.feature.newsession

import app.hapi.protocol.wire.AgentAvailabilityResponse
import app.hapi.protocol.wire.CodexArchiveSessionResponse
import app.hapi.protocol.wire.CodexDesktopScriptResponse
import app.hapi.protocol.wire.CodexDesktopStatusResponse
import app.hapi.protocol.wire.CodexDesktopSyncRequest
import app.hapi.protocol.wire.CodexDuplicateSessionsResponse
import app.hapi.protocol.wire.CodexLocalSessionsResponse
import app.hapi.protocol.wire.CodexMergeDuplicateSessionsResponse
import app.hapi.protocol.wire.CodexModelsResponse
import app.hapi.protocol.wire.GrokModelsResponse
import app.hapi.protocol.wire.MachineListDirectoryResponse
import app.hapi.protocol.wire.MachinePathsExistsResponse
import app.hapi.protocol.wire.PiImportError
import app.hapi.protocol.wire.PiImportResult
import app.hapi.protocol.wire.PiImportSessionsRequest
import app.hapi.protocol.wire.PiImportSessionsResponse
import app.hapi.protocol.wire.PiLocalSessionSummary
import app.hapi.protocol.wire.PiLocalSessionsResponse
import app.hapi.protocol.wire.ReopenSessionResponse
import app.hapi.protocol.wire.ResumeSessionResponse
import app.hapi.protocol.wire.SpawnResponse
import app.hapi.protocol.wire.SpawnSessionRequest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest

/**
 * Controller-level pin of the pi import flow (slice C) against the web state
 * machine: `web/src/components/PiSessionImportDialog.tsx` + the pi branches
 * of `web/src/components/NewSession/index.tsx` (mirrors the web cases
 * "imports the selected Pi history and resumes the canonical HAPI session",
 * "discards a stale Pi scan after switching machines", and "refreshes
 * successful Pi imports even when another batch item fails").
 */
class PiImportControllerTest {

    private val strings = PiImportStrings()

    private fun session(
        id: String,
        title: String = "Session $id",
        cwd: String? = "C:\\repo",
        hapiSessionId: String? = null,
        importState: String? = null,
    ): PiLocalSessionSummary = PiLocalSessionSummary(
        id = id,
        title = title,
        cwd = cwd,
        file = "C:\\$id.jsonl",
        modifiedAt = 1_700_000_000_000,
        messageCount = 2,
        hapiSessionId = hapiSessionId,
        importState = importState,
    )

    private class FakeGateway : NewSessionGateway {
        val piSessionsCalls = mutableListOf<Pair<String?, String?>>()
        val importCalls = mutableListOf<PiImportSessionsRequest>()
        val reopenCalls = mutableListOf<String>()

        var piSessionsImpl: suspend (String?, String?) -> PiLocalSessionsResponse = { _, _ ->
            PiLocalSessionsResponse(success = true, sessions = emptyList())
        }
        var importResult: PiImportSessionsResponse = PiImportSessionsResponse(success = true)
        var importThrows: Exception? = null
        var reopenResult: ReopenSessionResponse = ReopenSessionResponse(sessionId = "hapi-reopened", resumed = true)

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

        override suspend fun getCodexSessions(cwd: String?, machineId: String?): CodexLocalSessionsResponse =
            CodexLocalSessionsResponse(success = true)

        override suspend fun syncCodexSession(sync: CodexDesktopSyncRequest): CodexDesktopScriptResponse =
            CodexDesktopScriptResponse(success = true)

        override suspend fun resumeSession(sessionId: String, permissionMode: String?): ResumeSessionResponse =
            ResumeSessionResponse(sessionId = "resumed")

        override suspend fun archiveCodexSession(
            sessionId: String,
            machineId: String?,
        ): CodexArchiveSessionResponse = CodexArchiveSessionResponse(success = true)

        override suspend fun getCodexDesktopStatus(): CodexDesktopStatusResponse =
            CodexDesktopStatusResponse(success = true, codexClientAvailable = true)

        override suspend fun getCodexDuplicateSessions(payload: CodexDesktopSyncRequest): CodexDuplicateSessionsResponse =
            CodexDuplicateSessionsResponse(success = true)

        override suspend fun mergeCodexDuplicateSessions(payload: CodexDesktopSyncRequest): CodexMergeDuplicateSessionsResponse =
            CodexMergeDuplicateSessionsResponse(success = true)

        override suspend fun restartCodexDesktop(): CodexDesktopScriptResponse =
            CodexDesktopScriptResponse(success = true)

        override suspend fun piSessions(cwd: String?, machineId: String?): PiLocalSessionsResponse {
            piSessionsCalls.add(cwd to machineId)
            return piSessionsImpl(cwd, machineId)
        }

        override suspend fun importPiSessions(payload: PiImportSessionsRequest): PiImportSessionsResponse {
            importCalls.add(payload)
            importThrows?.let { throw it }
            return importResult
        }

        override suspend fun reopenSession(sessionId: String): ReopenSessionResponse {
            reopenCalls.add(sessionId)
            return reopenResult
        }
    }

    private fun TestScope.buildController(
        gateway: FakeGateway,
        applied: MutableList<String> = mutableListOf(),
        refreshed: MutableList<Int> = mutableListOf(),
    ): PiImportController = PiImportController(
        scope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler)),
        gateway = gateway,
        strings = strings,
        applyDirectory = { applied.add(it) },
        refreshSessions = { refreshed.add(1) },
    )

    // -------------------------------------------------------- listing (load) --

    @Test
    fun `pi listing failure surfaces the error unlike the codex twin`() = runTest {
        val gateway = FakeGateway().apply {
            piSessionsImpl = { _, _ -> throw RuntimeException("rpc down") }
        }
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
        assertEquals(listOf<Pair<String?, String?>>("/repo" to "m1"), gateway.piSessionsCalls)
    }

    @Test
    fun `pi soft failure success false also errors and clears context`() = runTest {
        val gateway = FakeGateway().apply {
            piSessionsImpl = { _, _ ->
                PiLocalSessionsResponse(success = false, sessions = emptyList(), error = "pi_not_installed")
            }
        }
        val controller = buildController(gateway)

        controller.openDialog("/repo", "m1")
        advanceUntilIdle()

        assertEquals("pi_not_installed", controller.state.value.error, "the web Pi caller checks the envelope flag")
        assertTrue(controller.state.value.sessions.isEmpty())
    }

    @Test
    fun `settled scan backfills the machine id and re-applies the weak dialog init`() = runTest {
        val gateway = FakeGateway().apply {
            piSessionsImpl = { _, machineId ->
                PiLocalSessionsResponse(
                    success = true,
                    machineId = machineId,
                    sessions = listOf(session("a", cwd = "/alpha"), session("b", cwd = "/beta")),
                )
            }
        }
        val controller = buildController(gateway)

        controller.setSearchQuery("stale")
        controller.setDirectoryFilter("/gone")
        controller.openDialog("/alpha", "m1")
        advanceUntilIdle()

        val state = controller.state.value
        assertEquals("m1", state.machineId)
        assertEquals(2, state.sessions.size)
        assertTrue(state.dialogSelection.isEmpty(), "no inline selection means no checkboxes")
        assertEquals("/alpha", state.directoryFilter, "form cwd wins when it is an option")
        assertEquals("", state.searchQuery, "query resets on the weak init")
    }

    // -------------------------------------------------- import-at-create path --

    @Test
    fun `imports the selected pi history and reopens the canonical session`() = runTest {
        val gateway = FakeGateway().apply {
            piSessionsImpl = { _, machineId ->
                PiLocalSessionsResponse(
                    success = true,
                    machineId = machineId,
                    sessions = listOf(session("pi-native-1")),
                )
            }
            importResult = PiImportSessionsResponse(
                success = true,
                machineId = "machine-1",
                results = listOf(
                    PiImportResult(
                        piSessionId = "pi-native-1",
                        hapiSessionId = "hapi-imported-1",
                        action = "created",
                        appended = 2,
                    ),
                ),
            )
            reopenResult = ReopenSessionResponse(sessionId = "hapi-imported-1", resumed = true)
        }
        val applied = mutableListOf<String>()
        val controller = buildController(gateway, applied = applied)

        controller.openDialog("C:\\repo", "machine-1")
        advanceUntilIdle()
        controller.selectInline(session("pi-native-1"))
        assertEquals(listOf("C:\\repo"), applied, "selecting inline adopts the session cwd")

        val form = NewSessionForm(machineId = "machine-1", directory = "C:\\other", agent = "pi")
        val request = PiImportLogic.buildSingleImportRequest(
            form,
            controller.state.value.selectedSession!!,
            formMachineId = "machine-1",
            importMachineId = controller.state.value.machineId,
        )
        assertEquals(
            PiImportSessionsRequest(
                sessionIds = listOf("pi-native-1"),
                cwd = "C:\\repo",
                machineId = "machine-1",
            ),
            request,
            "the session's own cwd wins over the form directory",
        )

        val result = controller.importAtCreate(request)
        advanceUntilIdle()

        assertEquals(PiImportAtCreateResult.Imported("hapi-imported-1"), result)
        assertEquals(listOf("hapi-imported-1"), gateway.reopenCalls)
        assertFalse(controller.state.value.importingAtCreate)
    }

    @Test
    fun `per-item import error fails create mapped through formatError`() = runTest {
        val gateway = FakeGateway().apply {
            importResult = PiImportSessionsResponse(
                success = false,
                results = listOf(
                    PiImportResult(piSessionId = "pi-1", error = PiImportError(code = "transcript_diverged")),
                ),
            )
        }
        val controller = buildController(gateway)

        val result = controller.importAtCreate(PiImportSessionsRequest(sessionIds = listOf("pi-1")))

        assertEquals(PiImportAtCreateResult.Failed(strings.errorDiverged), result)
        assertTrue(gateway.reopenCalls.isEmpty())
    }

    @Test
    fun `missing hapi session id falls back to the envelope error`() = runTest {
        val gateway = FakeGateway().apply {
            importResult = PiImportSessionsResponse(success = false, error = "import unavailable")
        }
        val controller = buildController(gateway)

        val result = controller.importAtCreate(PiImportSessionsRequest(sessionIds = listOf("pi-1")))

        assertEquals(PiImportAtCreateResult.Failed("import unavailable"), result)
        assertTrue(gateway.reopenCalls.isEmpty())
    }

    // ------------------------------------------------------ generation guard --

    @Test
    fun `discards a stale pi scan after switching machines`() = runTest {
        val gateway = FakeGateway()
        val machineAScan = CompletableDeferred<Unit>()
        val machineBScan = CompletableDeferred<Unit>()
        gateway.piSessionsImpl = { _, machineId ->
            if (machineId == "machine-a") {
                machineAScan.await()
                PiLocalSessionsResponse(success = true, machineId = "machine-a", sessions = listOf(session("pi-machine-a")))
            } else {
                machineBScan.await()
                PiLocalSessionsResponse(
                    success = true,
                    machineId = "machine-b",
                    sessions = listOf(session("pi-machine-b", title = "Machine B")),
                )
            }
        }
        gateway.importResult = PiImportSessionsResponse(
            success = true,
            machineId = "machine-b",
            results = listOf(
                PiImportResult(piSessionId = "pi-machine-b", hapiSessionId = "hapi-machine-b", action = "created", appended = 1),
            ),
        )
        gateway.reopenResult = ReopenSessionResponse(sessionId = "hapi-machine-b", resumed = true)
        val controller = buildController(gateway)

        // Scan for machine A hangs; the machine changes before it answers.
        controller.openDialog("C:\\repo", "machine-a")
        controller.close()
        controller.resetForContextChange()
        controller.openDialog("C:\\repo", "machine-b")
        machineBScan.complete(Unit)
        advanceUntilIdle()

        assertEquals("pi-machine-b", controller.state.value.sessions.single().id)
        assertEquals("machine-b", controller.state.value.machineId)

        // Machine A's reply finally lands — it must not clobber B's state.
        machineAScan.complete(Unit)
        advanceUntilIdle()
        assertEquals("pi-machine-b", controller.state.value.sessions.single().id)
        assertEquals("machine-b", controller.state.value.machineId)

        // The create-path import runs against machine B's listing.
        controller.selectInline(controller.state.value.sessions.single())
        val form = NewSessionForm(machineId = "machine-b", directory = "C:\\repo", agent = "pi")
        val request = PiImportLogic.buildSingleImportRequest(
            form,
            controller.state.value.selectedSession!!,
            formMachineId = "machine-b",
            importMachineId = controller.state.value.machineId,
        )
        assertEquals("machine-b", request.machineId)
        assertEquals(PiImportAtCreateResult.Imported("hapi-machine-b"), controller.importAtCreate(request))
    }

    // ----------------------------------------------------------- bulk import --

    @Test
    fun `refreshes successful pi imports even when another batch item fails`() = runTest {
        val gateway = FakeGateway().apply {
            piSessionsImpl = { _, machineId ->
                PiLocalSessionsResponse(
                    success = true,
                    machineId = machineId,
                    sessions = listOf(session("pi-native-1"), session("pi-native-2")),
                )
            }
            importResult = PiImportSessionsResponse(
                // Envelope failure with a good row: the batch is scored from
                // results alone (web parity).
                success = false,
                machineId = "machine-1",
                results = listOf(
                    PiImportResult(piSessionId = "pi-native-1", hapiSessionId = "hapi-1", action = "created", appended = 1),
                    PiImportResult(
                        piSessionId = "pi-native-2",
                        hapiSessionId = "hapi-2",
                        error = PiImportError(code = "session_active", message = "active"),
                    ),
                ),
            )
        }
        val refreshed = mutableListOf<Int>()
        val controller = buildController(gateway, refreshed = refreshed)

        controller.openDialog("C:\\repo", "machine-1")
        advanceUntilIdle()
        controller.selectAll()
        controller.confirm()
        advanceUntilIdle()

        val state = controller.state.value
        assertEquals(1, gateway.importCalls.size)
        assertEquals(listOf("pi-native-1", "pi-native-2"), gateway.importCalls.single().sessionIds)
        assertEquals("machine-1", gateway.importCalls.single().machineId)
        assertEquals("C:\\repo", gateway.importCalls.single().cwd)
        assertEquals(2, gateway.piSessionsCalls.size, "the scan re-pulls after a partial success")
        assertEquals(1, refreshed.size, "the session list refreshes for the successful row")
        assertTrue(state.successNotice!!.startsWith(strings.successTitle))
        assertTrue(state.successNotice!!.contains("1"))
        assertTrue(state.failedNotice!!.startsWith(strings.failedTitle))
        assertTrue(state.failedNotice!!.contains(strings.errorActive), "session_active maps to the friendly text")
        assertTrue(state.open, "a partial failure keeps the dialog open")
        assertFalse(state.importing)
    }

    @Test
    fun `an all-success batch closes the dialog and clears the inline selection`() = runTest {
        val gateway = FakeGateway().apply {
            piSessionsImpl = { _, machineId ->
                PiLocalSessionsResponse(
                    success = true,
                    machineId = machineId,
                    sessions = listOf(session("pi-1"), session("pi-2")),
                )
            }
            importResult = PiImportSessionsResponse(
                success = true,
                results = listOf(
                    PiImportResult(piSessionId = "pi-1", hapiSessionId = "hapi-1"),
                    PiImportResult(piSessionId = "pi-2", hapiSessionId = "hapi-2"),
                ),
            )
        }
        val controller = buildController(gateway)

        controller.openDialog("/repo", "m1")
        advanceUntilIdle()
        controller.selectAll()
        controller.confirm()
        advanceUntilIdle()

        val state = controller.state.value
        assertFalse(state.open)
        assertNull(state.selectedSessionId)
        assertNull(state.failedNotice)
        assertTrue(state.successNotice!!.startsWith(strings.successTitle))
    }

    @Test
    fun `confirm with one checked row selects inline instead of importing`() = runTest {
        val gateway = FakeGateway().apply {
            piSessionsImpl = { _, _ ->
                PiLocalSessionsResponse(success = true, sessions = listOf(session("only")))
            }
        }
        val applied = mutableListOf<String>()
        val controller = buildController(gateway, applied = applied)

        controller.openDialog("/repo", "m1")
        advanceUntilIdle()
        controller.toggleSession("only")
        controller.confirm()
        advanceUntilIdle()

        assertFalse(controller.state.value.open)
        assertEquals("only", controller.state.value.selectedSessionId)
        assertEquals(listOf("C:\\repo"), applied)
        assertTrue(gateway.importCalls.isEmpty(), "one selection continues now, not through the batch endpoint")
    }

    @Test
    fun `confirm with a vanished row leaves the dialog open`() = runTest {
        val gateway = FakeGateway()
        val controller = buildController(gateway)

        controller.openDialog("/repo", "m1")
        advanceUntilIdle()
        controller.toggleSession("ghost")
        controller.confirm()
        advanceUntilIdle()

        assertTrue(controller.state.value.open, "web returns without closing when the row is gone")
        assertTrue(gateway.importCalls.isEmpty())
    }

    @Test
    fun `thrown bulk import keeps the dialog open with the failure notice`() = runTest {
        val gateway = FakeGateway().apply {
            piSessionsImpl = { _, _ ->
                PiLocalSessionsResponse(success = true, sessions = listOf(session("pi-1"), session("pi-2")))
            }
            importThrows = RuntimeException("network gone")
        }
        val controller = buildController(gateway)

        controller.openDialog("/repo", "m1")
        advanceUntilIdle()
        controller.selectAll()
        controller.confirm()
        advanceUntilIdle()

        val state = controller.state.value
        assertTrue(state.open)
        assertTrue(state.failedNotice!!.contains("network gone"))
        assertFalse(state.importing)
    }

    // ------------------------------------------------------------ reset paths --

    @Test
    fun `agent switch closes the dialog and clears the pi context`() = runTest {
        val gateway = FakeGateway().apply {
            piSessionsImpl = { _, _ ->
                PiLocalSessionsResponse(success = true, sessions = listOf(session("pi-1")))
            }
        }
        val controller = buildController(gateway)

        controller.openDialog("/repo", "m1")
        advanceUntilIdle()
        controller.selectInline(session("pi-1"))
        assertTrue(controller.state.value.open)

        controller.resetForAgentChange()

        val state = controller.state.value
        assertFalse(state.open)
        assertTrue(state.sessions.isEmpty())
        assertNull(state.selectedSessionId)
        assertNull(state.error)
        assertFalse(state.loading)
    }

    // ------------------------------------------------------------ pure logic --

    @Test
    fun `formatError maps the known codes and falls back to the message`() {
        assertEquals(
            strings.errorDiverged,
            PiImportLogic.formatError("transcript_diverged", null, strings),
        )
        assertEquals(
            strings.errorActive,
            PiImportLogic.formatError("session_active", "ignored", strings),
        )
        assertEquals(
            "raw message",
            PiImportLogic.formatError("unknown_code", "  raw message  ", strings),
        )
        assertEquals(
            strings.loadFailed,
            PiImportLogic.formatError(null, "   ", strings),
        )
    }

    @Test
    fun `directory filtering keeps the raw-versus-trimmed quirk`() {
        val padded = session("padded", cwd = " /repo ")
        val trimmed = session("trimmed", cwd = "/repo")

        val options = PiImportLogic.directoryOptions(listOf(padded, trimmed))
        assertEquals(listOf("/repo"), options, "options are trimmed and deduped")

        val filtered = PiImportLogic.filterSessions(listOf(padded, trimmed), "/repo", "")
        assertEquals(listOf(trimmed), filtered, "the padded raw cwd never matches")

        assertTrue(PiImportLogic.filterSessions(listOf(padded), PiImportLogic.ALL_DIRECTORIES, "").isNotEmpty())
    }

    @Test
    fun `query matches title prompt path model or id case-insensitively`() {
        val target = session("pi-1", title = "Refactor").copy(
            model = "pi-sonnet",
        )
        assertTrue(PiImportLogic.matchesQuery(target, "refactor"))
        assertTrue(PiImportLogic.matchesQuery(target, "c:\\repo"))
        assertTrue(PiImportLogic.matchesQuery(target, "PI-1"))
        assertTrue(PiImportLogic.matchesQuery(target, "sonnet"))
        assertFalse(PiImportLogic.matchesQuery(target, "nope"))
        assertTrue(PiImportLogic.matchesQuery(target, "  "))
    }

    // ------------------------------------------------------ long listings --

    /**
     * Review item: "Please cover a long list and concurrent import/marker
     * updates." A 300-row listing (well past the dialog's 380 dp cap and the
     * lazy list's initial viewport) driven through three full select-all →
     * confirm import rounds on the deterministic test scheduler: every round
     * checks all 300 rows, ships one 300-id batch, closes on all-success and
     * settles both busy flags — no drift across rounds.
     */
    @Test
    fun `a long listing stays stable across repeated select-all import rounds`() = runTest {
        val sessions = (1..300).map { session("pi-$it") }
        val ids = sessions.map { it.id }.toSet()
        val gateway = FakeGateway().apply {
            piSessionsImpl = { _, machineId ->
                PiLocalSessionsResponse(success = true, machineId = machineId, sessions = sessions)
            }
            importResult = PiImportSessionsResponse(
                success = true,
                machineId = "m1",
                results = sessions.map {
                    PiImportResult(
                        piSessionId = it.id,
                        hapiSessionId = "hapi-${it.id}",
                        action = "created",
                        appended = 1,
                    )
                },
            )
        }
        val controller = buildController(gateway)

        repeat(3) { round ->
            controller.openDialog("/repo", "m1")
            advanceUntilIdle()
            controller.selectAll()
            advanceUntilIdle()

            assertEquals(300, controller.state.value.dialogSelection.size, "round $round: select-all checks every row")
            controller.confirm() // 300 checked rows → bulk import
            advanceUntilIdle()

            val state = controller.state.value
            assertFalse(state.importing, "round $round: the busy flag clears")
            assertFalse(state.loading, "round $round: the post-import re-pull scan settles")
            assertFalse(state.open, "round $round: an all-success batch closes the dialog")
            assertNull(state.selectedSessionId, "round $round: the inline selection is cleared")
            assertTrue(state.successNotice != null, "round $round: the success notice lands inline")
            val batch = gateway.importCalls[round]
            assertEquals(300, batch.sessionIds.size, "round $round: one full batch ships")
            assertEquals(ids, batch.sessionIds.toSet(), "round $round: the batch is exactly the listing")
        }
        assertEquals(3, gateway.importCalls.size, "one import per round — the busy guard holds")
    }
}

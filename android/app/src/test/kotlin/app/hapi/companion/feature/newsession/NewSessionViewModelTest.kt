@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package app.hapi.companion.feature.newsession

import app.hapi.data.api.ApiError
import app.hapi.data.store.MachineListStore
import app.hapi.protocol.catalog.AgentFlavor
import app.hapi.protocol.wire.AgentAvailabilityEntry
import app.hapi.protocol.wire.AgentAvailabilityResponse
import app.hapi.protocol.wire.CodexModelSummary
import app.hapi.protocol.wire.CodexModelsResponse
import app.hapi.protocol.wire.HapiJson
import app.hapi.protocol.wire.Machine
import app.hapi.protocol.wire.MachineDirectoryEntry
import app.hapi.protocol.wire.MachineListDirectoryResponse
import app.hapi.protocol.wire.MachineMetadata
import app.hapi.protocol.wire.MachinePathsExistsResponse
import app.hapi.protocol.wire.SpawnResponse
import app.hapi.protocol.wire.SpawnSessionRequest
import app.hapi.protocol.wire.SyncEvent
import kotlin.coroutines.Continuation
import kotlin.coroutines.suspendCoroutine
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonPrimitive

// ------------------------------------------------------------------ fakes --

private class FakeGateway : NewSessionGateway {
    val listDirectoryCalls = mutableListOf<Pair<String, String>>()
    val pathsExistCalls = mutableListOf<Pair<String, List<String>>>()
    val spawnCalls = mutableListOf<Pair<String, SpawnSessionRequest>>()
    val codexCalls = mutableListOf<String>()
    val availabilityCalls = mutableListOf<String>()
    val includeHiddenCalls = mutableListOf<Boolean>()

    var entries: List<MachineDirectoryEntry> = emptyList()
    var existsAnswer: (String) -> Boolean? = { true }
    var spawnResult: SpawnResponse = SpawnResponse(type = "success", sessionId = "s-new")
    var codexResult: CodexModelsResponse = CodexModelsResponse(success = true, models = emptyList())
    var codexThrows: Exception? = null
    var availabilityResult = AgentAvailabilityResponse(
        AgentFlavor.CREATABLE.map { AgentAvailabilityEntry(agent = it.id, available = true) },
    )
    var availabilityThrows: Exception? = null
    var outsideWorkspaceRoots: Set<String> = emptySet()
    var listDirectoryHandler: (suspend (String, Boolean) -> MachineListDirectoryResponse)? = null

    override suspend fun spawn(machineId: String, request: SpawnSessionRequest): SpawnResponse {
        spawnCalls.add(machineId to request)
        return spawnResult
    }

    override suspend fun listDirectory(
        machineId: String,
        path: String,
        includeHidden: Boolean,
    ): MachineListDirectoryResponse {
        listDirectoryCalls.add(machineId to path)
        includeHiddenCalls.add(includeHidden)
        listDirectoryHandler?.let { return it(path, includeHidden) }
        return MachineListDirectoryResponse(success = true, entries = entries)
    }

    override suspend fun pathsExist(machineId: String, paths: List<String>): MachinePathsExistsResponse {
        pathsExistCalls.add(machineId to paths)
        return MachinePathsExistsResponse(
            exists = paths.mapNotNull { path -> existsAnswer(path)?.let { path to it } }.toMap(),
            outsideWorkspaceRoots = paths.filter { it in outsideWorkspaceRoots }.takeIf { it.isNotEmpty() },
        )
    }

    override suspend fun agentAvailability(machineId: String): AgentAvailabilityResponse {
        availabilityCalls.add(machineId)
        availabilityThrows?.let { throw it }
        return availabilityResult
    }

    override suspend fun codexModels(machineId: String): CodexModelsResponse {
        codexCalls.add(machineId)
        codexThrows?.let { throw it }
        return codexResult
    }
}

private class FakeMachineStore(initial: List<Machine> = emptyList()) : MachineListStore {
    val backing = MutableStateFlow(initial)
    override val machines: StateFlow<List<Machine>> = backing
    override suspend fun refresh() {}
    override fun scheduleRefresh() {}
    override fun applyMachineEvent(event: SyncEvent.MachineUpdated) {}
}

private class FakePrefs(
    var stored: NewSessionPrefsData = NewSessionPrefsData(),
    var draft: NewSessionForm? = null,
) : NewSessionPrefs {
    var draftCleared = false

    override suspend fun readPrefs(): NewSessionPrefsData = stored
    override suspend fun writePrefs(data: NewSessionPrefsData) {
        stored = data
    }

    override suspend fun readDraft(): NewSessionForm? = draft
    override suspend fun writeDraft(draft: NewSessionForm) {
        this.draft = draft
    }

    override suspend fun clearDraft() {
        draft = null
        draftCleared = true
    }
}

private fun machine(
    id: String,
    host: String = "devbox",
    homeDir: String? = null,
    workspaceRoots: List<String>? = null,
): Machine = Machine(
    id = id,
    namespace = "default",
    seq = 1,
    createdAt = 1,
    updatedAt = 1,
    active = true,
    activeAt = 1,
    metadata = MachineMetadata(
        host = host,
        platform = "linux",
        happyCliVersion = "1.0.0",
        homeDir = homeDir,
        workspaceRoots = workspaceRoots,
    ),
    metadataVersion = 1,
    runnerState = null,
    runnerStateVersion = 1,
)

private fun dir(name: String) = MachineDirectoryEntry(name = name, type = "directory")

private fun encode(request: SpawnSessionRequest): JsonObject =
    HapiJson.encodeToJsonElement(SpawnSessionRequest.serializer(), request) as JsonObject

// ---------------------------------------------------- spawn body exactness --

class SpawnBodyTest {

    @Test
    fun `claude simple session with model, effort and yolo off`() {
        val body = encode(
            NewSessionLogic.buildSpawnRequest(
                NewSessionForm(
                    machineId = "m1",
                    directory = " /data/github/hapi ",
                    agent = "claude",
                    model = "opus",
                    effort = "high",
                    yolo = false,
                ),
                codexFastTierVisible = false,
            ),
        )
        // Exact SpawnSessionRequestSchema field set — yolo false IS sent for
        // claude; permissionMode / reasoning / codex fields are absent.
        assertEquals(
            setOf("directory", "agent", "model", "effort", "yolo", "sessionType"),
            body.keys,
        )
        assertEquals("/data/github/hapi", body["directory"]!!.jsonPrimitive.content)
        assertEquals("claude", body["agent"]!!.jsonPrimitive.content)
        assertEquals("opus", body["model"]!!.jsonPrimitive.content)
        assertEquals("high", body["effort"]!!.jsonPrimitive.content)
        assertEquals(false, body["yolo"]!!.jsonPrimitive.boolean)
        assertEquals("simple", body["sessionType"]!!.jsonPrimitive.content)
    }

    @Test
    fun `codex worktree with reasoning effort, permission mode, plan and fast tier`() {
        val body = encode(
            NewSessionLogic.buildSpawnRequest(
                NewSessionForm(
                    machineId = "m1",
                    directory = "/repo",
                    agent = "codex",
                    model = "gpt-5.2-codex",
                    modelReasoningEffort = "high",
                    permissionMode = "safe-yolo",
                    yolo = true, // must NOT leak into the body for codex-family
                    sessionType = SESSION_TYPE_WORKTREE,
                    worktreeName = "  feature-x  ",
                    serviceTier = "fast",
                    collaborationMode = "plan",
                ),
                codexFastTierVisible = true,
            ),
        )
        assertEquals(
            setOf(
                "directory", "agent", "model", "modelReasoningEffort", "permissionMode",
                "sessionType", "worktreeName", "serviceTier", "collaborationMode",
            ),
            body.keys,
        )
        assertEquals("codex", body["agent"]!!.jsonPrimitive.content)
        assertEquals("gpt-5.2-codex", body["model"]!!.jsonPrimitive.content)
        assertEquals("high", body["modelReasoningEffort"]!!.jsonPrimitive.content)
        assertEquals("safe-yolo", body["permissionMode"]!!.jsonPrimitive.content)
        assertEquals("worktree", body["sessionType"]!!.jsonPrimitive.content)
        assertEquals("feature-x", body["worktreeName"]!!.jsonPrimitive.content)
        assertEquals("fast", body["serviceTier"]!!.jsonPrimitive.content)
        assertEquals("plan", body["collaborationMode"]!!.jsonPrimitive.content)
        assertNull(body["yolo"])
        assertNull(body["startingMode"], "startingMode stays unset in v1 (runner defaults to remote)")
    }

    @Test
    fun `grok sends permissionMode not yolo, cursor sends yolo not permissionMode`() {
        val grok = encode(
            NewSessionLogic.buildSpawnRequest(
                NewSessionForm(directory = "/repo", agent = "grok", permissionMode = "auto", yolo = true),
                codexFastTierVisible = false,
            ),
        )
        assertEquals(setOf("directory", "agent", "permissionMode", "sessionType"), grok.keys)
        assertEquals("auto", grok["permissionMode"]!!.jsonPrimitive.content)

        val cursor = encode(
            NewSessionLogic.buildSpawnRequest(
                NewSessionForm(directory = "/repo", agent = "cursor", yolo = true, model = "sonic"),
                codexFastTierVisible = false,
            ),
        )
        // Cursor has no v1 model picker: even a stashed model id is not sent.
        assertEquals(setOf("directory", "agent", "yolo", "sessionType"), cursor.keys)
        assertEquals(true, cursor["yolo"]!!.jsonPrimitive.boolean)
    }

    @Test
    fun `dsh uses managed permission policy and omits yolo`() {
        val body = encode(
            NewSessionLogic.buildSpawnRequest(
                NewSessionForm(directory = "/repo", agent = "dsh", yolo = true),
                codexFastTierVisible = false,
            ),
        )
        assertEquals(setOf("directory", "agent", "sessionType"), body.keys)
    }

    @Test
    fun `codex default selections send no optional fields, fast tier hidden sends no serviceTier`() {
        val body = encode(
            NewSessionLogic.buildSpawnRequest(
                NewSessionForm(directory = "/repo", agent = "codex", serviceTier = "fast"),
                codexFastTierVisible = false,
            ),
        )
        assertEquals(setOf("directory", "agent", "permissionMode", "sessionType"), body.keys)
        assertEquals("default", body["permissionMode"]!!.jsonPrimitive.content)
    }
}

// -------------------------------------------------------------- pure logic --

class NewSessionLogicTest {

    @Test
    fun `parent query derivation`() {
        assertEquals(
            NewSessionLogic.ParentQuery("/data", "gi"),
            NewSessionLogic.parentQuery("/data/gi"),
        )
        assertEquals(
            NewSessionLogic.ParentQuery("/data", ""),
            NewSessionLogic.parentQuery("/data/"),
        )
        assertEquals(
            NewSessionLogic.ParentQuery("/", "d"),
            NewSessionLogic.parentQuery("/d"),
        )
        assertEquals(
            NewSessionLogic.ParentQuery("/", ""),
            NewSessionLogic.parentQuery("/"),
        )
        assertNull(NewSessionLogic.parentQuery("relative/path"))
        assertNull(NewSessionLogic.parentQuery(""))
    }

    @Test
    fun `suggestions filter directories by prefix and join with parent`() {
        val query = NewSessionLogic.ParentQuery("/data", "gi")
        val entries = listOf(
            dir("github"),
            dir("gists"),
            dir("archive"),
            MachineDirectoryEntry(name = "gitconfig", type = "file"),
        )
        assertEquals(
            listOf("/data/github", "/data/gists"),
            NewSessionLogic.buildSuggestions(query, entries),
        )
        // Root parent must not double the slash.
        assertEquals(
            listOf("/data"),
            NewSessionLogic.buildSuggestions(NewSessionLogic.ParentQuery("/", "da"), listOf(dir("data"))),
        )
    }

    @Test
    fun `windows drive and UNC autocomplete preserve separators`() {
        assertEquals(
            NewSessionLogic.ParentQuery("C:\\Users", "pro", "\\"),
            NewSessionLogic.parentQuery("C:\\Users\\pro"),
        )
        assertEquals(
            NewSessionLogic.ParentQuery("C:\\", "Use", "\\"),
            NewSessionLogic.parentQuery("C:\\Use"),
        )
        assertEquals(
            NewSessionLogic.ParentQuery("\\\\server\\share", "pro", "\\"),
            NewSessionLogic.parentQuery("\\\\server\\share\\pro"),
        )
        assertEquals(
            listOf("C:\\Users\\projects"),
            NewSessionLogic.buildSuggestions(
                NewSessionLogic.ParentQuery("C:\\Users", "pro", "\\"),
                listOf(dir("projects")),
            ),
        )
    }

    @Test
    fun `recent paths LRU dedupes to front and caps at 8`() {
        var list = emptyList<String>()
        for (i in 1..10) list = NewSessionLogic.pushRecent(list, "/p$i")
        assertEquals(8, list.size)
        assertEquals("/p10", list.first())
        assertEquals("/p3", list.last())

        list = NewSessionLogic.pushRecent(list, "/p5")
        assertEquals("/p5", list.first())
        assertEquals(8, list.size)
        assertEquals(list.toSet().size, list.size)

        assertEquals(list, NewSessionLogic.pushRecent(list, "   "))
    }

    @Test
    fun `worktree name validation`() {
        assertNull(NewSessionLogic.worktreeNameError(""))
        assertNull(NewSessionLogic.worktreeNameError("feature-x"))
        assertNull(NewSessionLogic.worktreeNameError("Fix Bug #42"))
        assertNotNull(NewSessionLogic.worktreeNameError("---"))
        assertNotNull(NewSessionLogic.worktreeNameError("!!!"))
    }

    @Test
    fun `codex fast tier detection follows the active model`() {
        val models = listOf(
            CodexModelSummary(id = "gpt-5.2-codex", displayName = "GPT-5.2", isDefault = true, serviceTiers = listOf("standard", "fast")),
            CodexModelSummary(id = "gpt-5.2-mini", displayName = "Mini", isDefault = false, serviceTiers = listOf("standard")),
        )
        assertTrue(NewSessionLogic.codexModelAdvertisesFastTier("auto", models))
        assertTrue(NewSessionLogic.codexModelAdvertisesFastTier("gpt-5.2-codex", models))
        assertFalse(NewSessionLogic.codexModelAdvertisesFastTier("gpt-5.2-mini", models))
        assertFalse(NewSessionLogic.codexModelAdvertisesFastTier("auto", emptyList()))
    }

    @Test
    fun `draft sanitization coerces uncreatable agent and stale permission mode`() {
        val gemini = NewSessionLogic.sanitizeDraft(
            NewSessionForm(agent = "gemini", model = "gemini-2.5-pro", directory = "/repo"),
        )
        assertEquals("claude", gemini.agent)
        assertEquals("auto", gemini.model)
        assertEquals("/repo", gemini.directory)

        val badMode = NewSessionLogic.sanitizeDraft(
            NewSessionForm(agent = "codex", permissionMode = "bypassPermissions"),
        )
        assertEquals("default", badMode.permissionMode)

        val goodMode = NewSessionLogic.sanitizeDraft(
            NewSessionForm(agent = "codex", permissionMode = "safe-yolo"),
        )
        assertEquals("safe-yolo", goodMode.permissionMode)
    }
}

// ---------------------------------------------------------- view model flow --

class NewSessionViewModelTest {

    /**
     * VM scope on the test scheduler as FOREGROUND work: `advanceUntilIdle`
     * only advances background tasks alongside foreground ones, so a
     * `backgroundScope`-hosted VM would never run under pure virtual-time
     * control (needed for the debounce assertions).
     */
    private fun kotlinx.coroutines.test.TestScope.newVmScope(): CoroutineScope =
        CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler))

    private fun kotlinx.coroutines.test.TestScope.buildViewModel(
        gateway: FakeGateway,
        machines: FakeMachineStore,
        prefs: FakePrefs,
        initialMachineId: String? = null,
        scope: CoroutineScope = newVmScope(),
    ): NewSessionViewModel = NewSessionViewModel(
        gateway = gateway,
        machineStore = machines,
        prefs = prefs,
        scope = scope,
        initialMachineId = initialMachineId,
    )

    @Test
    fun `directory autocomplete debounces, lists parent once and reuses the cache`() = runTest {
        val gateway = FakeGateway().apply {
            entries = listOf(dir("github"), dir("gists"), dir("go"))
        }
        val vm = buildViewModel(gateway, FakeMachineStore(listOf(machine("m1"))), FakePrefs())
        advanceUntilIdle()
        assertEquals("m1", vm.uiState.value.form.machineId)

        vm.setDirectory("/data/g")
        advanceTimeBy(100) // below the 250 ms debounce — no request yet
        assertEquals(0, gateway.listDirectoryCalls.size)
        vm.setDirectory("/data/gi")
        advanceUntilIdle()

        assertEquals(listOf("m1" to "/data"), gateway.listDirectoryCalls)
        assertEquals(listOf("/data/github", "/data/gists"), vm.uiState.value.suggestions)

        // Same parent, longer prefix: served from the cache — still one call.
        vm.setDirectory("/data/gith")
        advanceUntilIdle()
        assertEquals(1, gateway.listDirectoryCalls.size)
        assertEquals(listOf("/data/github"), vm.uiState.value.suggestions)

        // New parent → second listing.
        vm.setDirectory("/data/github/ha")
        advanceUntilIdle()
        assertEquals(listOf("m1" to "/data", "m1" to "/data/github"), gateway.listDirectoryCalls)

        // Existence probes rode the same debounce (one per settled input).
        assertEquals(
            listOf("/data/gi", "/data/gith", "/data/github/ha"),
            gateway.pathsExistCalls.map { it.second.single() },
        )
    }

    @Test
    fun `stale autocomplete response cannot replace newer suggestions`() = runTest {
        val gateway = FakeGateway()
        var staleContinuation: Continuation<MachineListDirectoryResponse>? = null
        gateway.listDirectoryHandler = { path, _ ->
            when (path) {
                "/old" -> suspendCoroutine { staleContinuation = it }
                "/new" -> MachineListDirectoryResponse(success = true, entries = listOf(dir("beta")))
                else -> MachineListDirectoryResponse(success = true, entries = emptyList())
            }
        }
        val vm = buildViewModel(gateway, FakeMachineStore(listOf(machine("m1"))), FakePrefs())
        advanceUntilIdle()

        vm.setDirectory("/old/a")
        advanceTimeBy(250)
        runCurrent()
        assertNotNull(staleContinuation)

        vm.setDirectory("/new/b")
        advanceUntilIdle()
        assertEquals(listOf("/new/beta"), vm.uiState.value.suggestions)

        staleContinuation!!.resumeWith(
            Result.success(MachineListDirectoryResponse(success = true, entries = listOf(dir("alpha")))),
        )
        advanceUntilIdle()
        assertEquals(listOf("/new/beta"), vm.uiState.value.suggestions)
    }

    @Test
    fun `picking a suggestion suppresses the dropdown but keeps the exists probe`() = runTest {
        val gateway = FakeGateway().apply { entries = listOf(dir("github")) }
        val vm = buildViewModel(gateway, FakeMachineStore(listOf(machine("m1"))), FakePrefs())
        advanceUntilIdle()

        vm.setDirectory("/data/gi")
        advanceUntilIdle()
        assertEquals(listOf("/data/github"), vm.uiState.value.suggestions)

        vm.pickSuggestion("/data/github")
        advanceUntilIdle()
        assertEquals(emptyList(), vm.uiState.value.suggestions)
        assertEquals("/data/github", vm.uiState.value.form.directory)
        assertEquals("/data/github", gateway.pathsExistCalls.last().second.single())
    }

    @Test
    fun `spawn success persists prefs, clears draft and emits the session id`() = runTest {
        val gateway = FakeGateway()
        val prefs = FakePrefs(
            stored = NewSessionPrefsData(recentPaths = mapOf("m1" to listOf("/old"))),
        )
        val vmScope = newVmScope()
        val vm = buildViewModel(gateway, FakeMachineStore(listOf(machine("m1"))), prefs, scope = vmScope)
        advanceUntilIdle()

        val spawnedIds = mutableListOf<String>()
        vmScope.launch { vm.spawned.collect(spawnedIds::add) }

        vm.setDirectory("/data/github/hapi")
        advanceUntilIdle()
        assertTrue(vm.uiState.value.canCreate)

        vm.create()
        advanceUntilIdle()

        assertEquals(listOf("s-new"), spawnedIds)
        assertEquals("m1", gateway.spawnCalls.single().first)
        assertEquals("/data/github/hapi", gateway.spawnCalls.single().second.directory)
        assertEquals("m1", prefs.stored.lastMachineId)
        assertEquals(listOf("/data/github/hapi", "/old"), prefs.stored.recentPaths["m1"])
        assertTrue(prefs.draftCleared)
        assertNull(prefs.draft)
    }

    @Test
    fun `spawn error lands inline and keeps the draft`() = runTest {
        val gateway = FakeGateway().apply {
            spawnResult = SpawnResponse(type = "error", message = "No runner")
        }
        val prefs = FakePrefs()
        val vm = buildViewModel(gateway, FakeMachineStore(listOf(machine("m1"))), prefs)
        advanceUntilIdle()

        vm.setDirectory("/repo")
        advanceUntilIdle()
        vm.create()
        advanceUntilIdle()

        assertEquals("No runner", vm.uiState.value.spawnError)
        assertFalse(vm.uiState.value.isSpawning)
        assertFalse(prefs.draftCleared)
        assertNotNull(prefs.draft) // edits persisted for back-out
    }

    @Test
    fun `availability hides unavailable agents and falls back to the first available agent`() = runTest {
        val gateway = FakeGateway().apply {
            availabilityResult = AgentAvailabilityResponse(
                listOf(
                    AgentAvailabilityEntry(agent = "claude", available = false, reason = "not_found"),
                    AgentAvailabilityEntry(agent = "codex", available = true),
                ),
            )
        }
        val vm = buildViewModel(gateway, FakeMachineStore(listOf(machine("m1"))), FakePrefs())
        advanceUntilIdle()

        assertEquals(listOf("codex"), vm.uiState.value.agents.map { it.value })
        assertEquals("codex", vm.uiState.value.form.agent)
        vm.setDirectory("/repo")
        advanceUntilIdle()
        assertTrue(vm.uiState.value.canCreate)
    }

    @Test
    fun `old runner availability failure blocks create and asks for upgrade`() = runTest {
        val gateway = FakeGateway().apply {
            availabilityThrows = ApiError(status = 409, code = "runner_upgrade_required", body = null)
        }
        val vm = buildViewModel(gateway, FakeMachineStore(listOf(machine("m1"))), FakePrefs())
        advanceUntilIdle()
        vm.setDirectory("/repo")
        advanceUntilIdle()

        assertFalse(vm.uiState.value.canCreate)
        assertEquals(NewSessionStrings().runnerUpgradeRequired, vm.uiState.value.agentAvailabilityError)
        vm.create()
        advanceUntilIdle()
        assertEquals(NewSessionStrings().runnerUpgradeRequired, vm.uiState.value.spawnError)
        assertTrue(gateway.spawnCalls.isEmpty())
    }

    @Test
    fun `create relies on runner preflight without refreshing availability`() = runTest {
        val gateway = FakeGateway().apply {
            spawnResult = SpawnResponse(
                type = "error",
                message = "claude is not installed or is not on PATH",
                code = "agent_unavailable",
                agent = "claude",
            )
        }
        val vm = buildViewModel(gateway, FakeMachineStore(listOf(machine("m1"))), FakePrefs())
        advanceUntilIdle()
        vm.setDirectory("/repo")
        advanceUntilIdle()
        assertTrue(vm.uiState.value.canCreate)

        val availabilityCallsBeforeCreate = gateway.availabilityCalls.size
        vm.create()
        advanceUntilIdle()

        assertEquals(NewSessionStrings().selectedAgentUnavailable, vm.uiState.value.spawnError)
        assertEquals(availabilityCallsBeforeCreate, gateway.availabilityCalls.size)
        assertEquals(1, gateway.spawnCalls.size)
    }

    @Test
    fun `outside workspace root is shown and refused before spawn`() = runTest {
        val gateway = FakeGateway().apply { outsideWorkspaceRoots = setOf("/outside/repo") }
        val vm = buildViewModel(
            gateway,
            FakeMachineStore(listOf(machine("m1", workspaceRoots = listOf("/workspace")))),
            FakePrefs(),
        )
        advanceUntilIdle()
        vm.setDirectory("/outside/repo")
        advanceUntilIdle()

        assertFalse(vm.uiState.value.canCreate)
        assertTrue(vm.uiState.value.directoryStatus!!.isError)
        assertEquals(NewSessionStrings().directoryOutsideWorkspaceRoots, vm.uiState.value.directoryStatus?.message)
        vm.create()
        advanceUntilIdle()
        assertEquals(NewSessionStrings().directoryOutsideWorkspaceRoots, vm.uiState.value.spawnError)
        assertTrue(gateway.spawnCalls.isEmpty())
    }

    @Test
    fun `missing simple directory needs a second create tap`() = runTest {
        val gateway = FakeGateway().apply { existsAnswer = { false } }
        val vm = buildViewModel(gateway, FakeMachineStore(listOf(machine("m1"))), FakePrefs())
        advanceUntilIdle()

        vm.setDirectory("/brand/new")
        advanceUntilIdle()
        assertEquals(
            NewSessionViewModel.MSG_DIRECTORY_MISSING,
            vm.uiState.value.directoryStatus?.message,
        )

        vm.create()
        advanceUntilIdle()
        assertEquals(0, gateway.spawnCalls.size)
        assertTrue(vm.uiState.value.confirmCreateDirectory)
        assertEquals(
            NewSessionViewModel.MSG_DIRECTORY_MISSING_CONFIRM,
            vm.uiState.value.directoryStatus?.message,
        )

        vm.create()
        advanceUntilIdle()
        assertEquals(1, gateway.spawnCalls.size)
    }

    @Test
    fun `missing worktree directory blocks the spawn`() = runTest {
        val gateway = FakeGateway().apply { existsAnswer = { false } }
        val vm = buildViewModel(gateway, FakeMachineStore(listOf(machine("m1"))), FakePrefs())
        advanceUntilIdle()

        vm.setSessionType(SESSION_TYPE_WORKTREE)
        vm.setDirectory("/missing/repo")
        advanceUntilIdle()

        val state = vm.uiState.value
        assertEquals(NewSessionViewModel.MSG_WORKTREE_MISSING, state.directoryStatus?.message)
        assertTrue(state.directoryStatus!!.isError)
        assertFalse(state.canCreate)

        vm.create() // canCreate=false, but a direct call must still refuse
        advanceUntilIdle()
        assertEquals(0, gateway.spawnCalls.size)
        assertEquals(NewSessionViewModel.MSG_WORKTREE_MISSING, vm.uiState.value.spawnError)
    }

    @Test
    fun `invalid worktree name blocks create`() = runTest {
        val gateway = FakeGateway()
        val vm = buildViewModel(gateway, FakeMachineStore(listOf(machine("m1"))), FakePrefs())
        advanceUntilIdle()

        vm.setDirectory("/repo")
        vm.setSessionType(SESSION_TYPE_WORKTREE)
        vm.setWorktreeName("!!!")
        advanceUntilIdle()

        assertNotNull(vm.uiState.value.worktreeNameError)
        assertFalse(vm.uiState.value.canCreate)
        vm.create()
        advanceUntilIdle()
        assertEquals(0, gateway.spawnCalls.size)
    }

    @Test
    fun `machine preselect prefers last used and seeds the recent path`() = runTest {
        val prefs = FakePrefs(
            stored = NewSessionPrefsData(
                lastMachineId = "m2",
                recentPaths = mapOf("m2" to listOf("/work/repo")),
            ),
        )
        val vm = buildViewModel(
            FakeGateway(),
            FakeMachineStore(listOf(machine("m1"), machine("m2"))),
            prefs,
        )
        advanceUntilIdle()

        assertEquals("m2", vm.uiState.value.form.machineId)
        assertEquals("/work/repo", vm.uiState.value.form.directory)
        assertEquals(listOf("/work/repo"), vm.uiState.value.recentPaths)
    }

    @Test
    fun `default directory uses valid recent path then workspace root or home`() = runTest {
        val gateway = FakeGateway().apply { outsideWorkspaceRoots = setOf("/outside") }
        val prefs = FakePrefs(
            stored = NewSessionPrefsData(
                recentPaths = mapOf("m1" to listOf("/outside", "/workspace/recent")),
            ),
        )
        val vm = buildViewModel(
            gateway,
            FakeMachineStore(listOf(machine("m1", homeDir = "/home/dev", workspaceRoots = listOf("/workspace")))),
            prefs,
        )
        advanceUntilIdle()
        assertEquals("/workspace/recent", vm.uiState.value.form.directory)

        val homeVm = buildViewModel(
            FakeGateway(),
            FakeMachineStore(listOf(machine("home", homeDir = "/home/dev"))),
            FakePrefs(),
        )
        advanceUntilIdle()
        assertEquals("/home/dev", homeVm.uiState.value.form.directory)
        homeVm.openDirectoryBrowser()
        advanceUntilIdle()
        assertEquals(listOf("/home/dev"), homeVm.directoryBrowser.state.value.roots)
    }

    @Test
    fun `directory picker stays within roots and forwards hidden toggle`() = runTest {
        val gateway = FakeGateway().apply { entries = listOf(dir("repo"), dir("archive")) }
        val vm = buildViewModel(
            gateway,
            FakeMachineStore(listOf(machine("m1", workspaceRoots = listOf("/workspace", "/other")))),
            FakePrefs(),
        )
        advanceUntilIdle()

        vm.openDirectoryBrowser()
        advanceUntilIdle()
        assertEquals("/workspace", vm.directoryBrowser.state.value.path)
        val callsBeforeEscape = gateway.listDirectoryCalls.size
        vm.directoryBrowser.navigate("/workspace-other")
        advanceUntilIdle()
        assertEquals(callsBeforeEscape, gateway.listDirectoryCalls.size)

        vm.directoryBrowser.navigateEntry("repo")
        advanceUntilIdle()
        assertEquals("/workspace/repo", vm.directoryBrowser.state.value.path)
        assertTrue(vm.directoryBrowser.state.value.canGoUp)
        vm.directoryBrowser.setIncludeHidden(true)
        advanceUntilIdle()
        assertTrue(gateway.includeHiddenCalls.last())
        vm.directoryBrowser.navigateUp()
        advanceUntilIdle()
        assertEquals("/workspace", vm.directoryBrowser.state.value.path)
        vm.selectBrowsedDirectory(vm.directoryBrowser.state.value.path)
        advanceUntilIdle()
        assertFalse(vm.directoryBrowser.state.value.open)
        assertEquals("/workspace", vm.uiState.value.form.directory)
    }

    @Test
    fun `restored draft survives and initial machine mismatch clears it`() = runTest {
        val draft = NewSessionForm(
            machineId = "m1",
            directory = "/drafted",
            agent = "codex",
            permissionMode = "yolo",
            sessionType = SESSION_TYPE_WORKTREE,
            worktreeName = "wip",
        )
        val vm = buildViewModel(
            FakeGateway(),
            FakeMachineStore(listOf(machine("m1"))),
            FakePrefs(draft = draft),
        )
        advanceUntilIdle()
        val form = vm.uiState.value.form
        assertEquals("/drafted", form.directory)
        assertEquals("codex", form.agent)
        assertEquals("yolo", form.permissionMode)
        assertEquals("wip", form.worktreeName)

        // A different preselected machine invalidates the draft (web parity).
        val prefs2 = FakePrefs(draft = draft.copy(machineId = "m1"))
        val vm2 = buildViewModel(
            FakeGateway(),
            FakeMachineStore(listOf(machine("m1"), machine("m9"))),
            prefs2,
            initialMachineId = "m9",
        )
        advanceUntilIdle()
        assertEquals("m9", vm2.uiState.value.form.machineId)
        assertEquals("", vm2.uiState.value.form.directory)
    }

    @Test
    fun `codex models load reconciles stale selections and unsupported runner hides picker`() = runTest {
        val gateway = FakeGateway().apply {
            codexResult = CodexModelsResponse(
                success = true,
                models = listOf(
                    CodexModelSummary(
                        id = "gpt-5.2-codex",
                        displayName = "GPT-5.2 Codex",
                        isDefault = true,
                        supportedReasoningEfforts = listOf("low", "medium", "high"),
                        serviceTiers = listOf("standard"),
                    ),
                ),
            )
        }
        val draft = NewSessionForm(
            machineId = "m1",
            agent = "codex",
            model = "removed-model",
            modelReasoningEffort = "xhigh",
            serviceTier = "fast",
        )
        val vm = buildViewModel(gateway, FakeMachineStore(listOf(machine("m1"))), FakePrefs(draft = draft))
        advanceUntilIdle()

        assertEquals(listOf("m1"), gateway.codexCalls)
        val state = vm.uiState.value
        assertEquals("auto", state.form.model)
        assertEquals("default", state.form.modelReasoningEffort)
        assertEquals("standard", state.form.serviceTier)
        assertEquals(
            listOf("auto", "gpt-5.2-codex"),
            state.modelOptions!!.map { it.value },
        )
        assertEquals(
            listOf("default", "low", "medium", "high"),
            state.reasoningEffortOptions!!.map { it.value },
        )
        assertFalse(state.showFastMode)

        // Old runner: rpc_target_missing hides the codex model picker.
        val unsupported = FakeGateway().apply {
            codexThrows = ApiError(status = 503, code = "rpc_target_missing", body = null)
        }
        val vm2 = buildViewModel(unsupported, FakeMachineStore(listOf(machine("m1"))), FakePrefs())
        advanceUntilIdle()
        vm2.setAgent("codex")
        advanceUntilIdle()
        assertNull(vm2.uiState.value.modelOptions)
        assertNull(vm2.uiState.value.reasoningEffortOptions)
    }

    @Test
    fun `agent switch resets dependent options but keeps yolo`() = runTest {
        val vm = buildViewModel(FakeGateway(), FakeMachineStore(listOf(machine("m1"))), FakePrefs())
        advanceUntilIdle()

        vm.setYolo(true)
        vm.setModel("opus")
        vm.setEffort("high")
        vm.setAgent("codex")
        advanceUntilIdle()

        val form = vm.uiState.value.form
        assertEquals("codex", form.agent)
        assertEquals("auto", form.model)
        assertEquals("auto", form.effort)
        assertEquals("default", form.permissionMode)
        assertTrue(form.yolo)
        assertTrue(vm.uiState.value.permission is PermissionUi.NativeSelect)

        vm.setAgent("pi")
        advanceUntilIdle()
        assertTrue(vm.uiState.value.permission is PermissionUi.Managed)

        vm.setAgent("claude")
        advanceUntilIdle()
        val toggle = vm.uiState.value.permission
        assertTrue(toggle is PermissionUi.YoloToggle)
        assertEquals("Yolo", (toggle as PermissionUi.YoloToggle).nativeModeLabel)
    }
}

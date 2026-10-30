@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package app.hapi.companion.feature.newsession

import app.hapi.data.api.ApiError
import app.hapi.data.store.MachineListStore
import app.hapi.protocol.catalog.AgentFlavor
import app.hapi.protocol.wire.AgentAvailabilityEntry
import app.hapi.protocol.wire.AgentAvailabilityResponse
import app.hapi.protocol.wire.CodexDesktopScriptResponse
import app.hapi.protocol.wire.CodexDesktopSyncRequest
import app.hapi.protocol.wire.CodexLocalSessionSummary
import app.hapi.protocol.wire.CodexLocalSessionsResponse
import app.hapi.protocol.wire.CodexModelSummary
import app.hapi.protocol.wire.CodexModelsResponse
import app.hapi.protocol.wire.GrokModelsResponse
import app.hapi.protocol.wire.HapiJson
import app.hapi.protocol.wire.Machine
import app.hapi.protocol.wire.MachineDirectoryEntry
import app.hapi.protocol.wire.MachineListDirectoryResponse
import app.hapi.protocol.wire.MachineMetadata
import app.hapi.protocol.wire.MachinePathsExistsResponse
import app.hapi.protocol.wire.ResumeSessionResponse
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
    val grokCalls = mutableListOf<Pair<String, String>>()
    val includeHiddenCalls = mutableListOf<Boolean>()
    val codexSessionsCalls = mutableListOf<Pair<String?, String?>>()
    val syncCalls = mutableListOf<CodexDesktopSyncRequest>()
    val resumeCalls = mutableListOf<Pair<String, String?>>()

    var entries: List<MachineDirectoryEntry> = emptyList()
    var existsAnswer: (String) -> Boolean? = { true }
    var spawnResult: SpawnResponse = SpawnResponse(type = "success", sessionId = "s-new")
    var codexResult: CodexModelsResponse = CodexModelsResponse(success = true, models = emptyList())
    var codexThrows: Exception? = null
    var grokResult = GrokModelsResponse(success = true)
    var grokThrows: Exception? = null
    var codexSessionsResult: CodexLocalSessionsResponse =
        CodexLocalSessionsResponse(success = true, sessions = emptyList())
    var codexSessionsThrows: Exception? = null
    var syncResult: CodexDesktopScriptResponse = CodexDesktopScriptResponse(success = true)
    var syncThrows: Exception? = null
    var resumeResult: ResumeSessionResponse = ResumeSessionResponse(sessionId = "s-resumed")
    var resumeThrows: Exception? = null
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

    override suspend fun grokModels(machineId: String, cwd: String): GrokModelsResponse {
        grokCalls.add(machineId to cwd)
        grokThrows?.let { throw it }
        return grokResult
    }

    override suspend fun getCodexSessions(
        cwd: String?,
        machineId: String?,
    ): CodexLocalSessionsResponse {
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
    fun `claude simple session with model, effort and permission mode`() {
        val body = encode(
            NewSessionLogic.buildSpawnRequest(
                NewSessionForm(
                    machineId = "m1",
                    directory = " /data/github/hapi ",
                    agent = "claude",
                    model = "opus",
                    effort = "high",
                    permissionMode = "plan",
                    yolo = true,
                ),
                codexFastTierVisible = false,
            ),
        )
        // Exact SpawnSessionRequestSchema field set — claude is on the native
        // permission select now, so permissionMode IS sent (even a picked
        // non-default mode) and yolo is absent, even when set on the form (a
        // stale toggle value from before the flavor switch).
        assertEquals(
            setOf("directory", "agent", "model", "effort", "permissionMode", "sessionType"),
            body.keys,
        )
        assertEquals("/data/github/hapi", body["directory"]!!.jsonPrimitive.content)
        assertEquals("claude", body["agent"]!!.jsonPrimitive.content)
        assertEquals("opus", body["model"]!!.jsonPrimitive.content)
        assertEquals("high", body["effort"]!!.jsonPrimitive.content)
        assertEquals("plan", body["permissionMode"]!!.jsonPrimitive.content)
        assertEquals("simple", body["sessionType"]!!.jsonPrimitive.content)
        assertNull(body["yolo"])
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
                    permissionMode = "read-only",
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
        assertEquals("read-only", body["permissionMode"]!!.jsonPrimitive.content)
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

        val staleMode = NewSessionLogic.sanitizeDraft(
            NewSessionForm(agent = "codex", permissionMode = "safe-yolo"),
        )
        assertEquals("default", staleMode.permissionMode)
        assertEquals(listOf("default", "read-only", "autoReview", "yolo"), app.hapi.protocol.catalog.PermissionModes.forFlavor("codex").map { it.wireId })
        assertEquals("safe-yolo", NewSessionLogic.sanitizeDraft(NewSessionForm(agent = "kimi", permissionMode = "safe-yolo")).permissionMode)
    }

    @Test
    fun `launch preference capture maps the form and gates permissionMode on shared-mode flavors`() {
        // Claude is a shared-mode flavor: the picked mode is remembered.
        assertEquals(
            PreferredLaunchSettings(model = "opus", effort = "high", permissionMode = "plan"),
            NewSessionLogic.launchPreferenceFrom(
                NewSessionForm(agent = "claude", model = "opus", effort = "high", permissionMode = "plan"),
            ),
        )
        // Grok renders the same native select but is NOT remembered.
        assertEquals(
            PreferredLaunchSettings(),
            NewSessionLogic.launchPreferenceFrom(
                NewSessionForm(agent = "grok", model = "auto", permissionMode = "plan"),
            ),
        )
        // YOLO-toggle flavors (cursor) never carry a remembered mode either.
        assertEquals(
            PreferredLaunchSettings(),
            NewSessionLogic.launchPreferenceFrom(
                NewSessionForm(agent = "cursor", yolo = true, permissionMode = "plan"),
            ),
        )
        // Codex remembers its model/reasoning pair.
        assertEquals(
            PreferredLaunchSettings(model = "gpt-5.2-codex", modelReasoningEffort = "high", permissionMode = "read-only"),
            NewSessionLogic.launchPreferenceFrom(
                NewSessionForm(
                    agent = "codex",
                    model = "gpt-5.2-codex",
                    modelReasoningEffort = "high",
                    permissionMode = "read-only",
                ),
            ),
        )
    }

    @Test
    fun `resolve preferred launch settings validates static lists and coerces stale values`() {
        // Nothing stored → sentinels (shared-mode flavors resolve 'default').
        assertEquals(
            PreferredLaunchSettings(permissionMode = "default"),
            NewSessionLogic.resolvePreferredLaunchSettings("claude", null),
        )

        // Claude: valid static ids survive; stale ids fall back to sentinels.
        assertEquals(
            PreferredLaunchSettings(model = "opus", effort = "high", permissionMode = "plan"),
            NewSessionLogic.resolvePreferredLaunchSettings(
                "claude",
                PreferredLaunchSettings(model = "opus", effort = "high", permissionMode = "plan"),
            ),
        )
        assertEquals(
            PreferredLaunchSettings(permissionMode = "default"),
            NewSessionLogic.resolvePreferredLaunchSettings(
                "claude",
                PreferredLaunchSettings(model = "removed-model", effort = "ultra", permissionMode = "bogus"),
            ),
        )

        // Codex: the model comes from a dynamic machine catalog, so it passes
        // through untouched (the settled-catalog reconciliation re-validates);
        // a permission mode outside the launch list coerces to default.
        assertEquals(
            PreferredLaunchSettings(model = "gpt-5.2-codex", modelReasoningEffort = "high", permissionMode = "read-only"),
            NewSessionLogic.resolvePreferredLaunchSettings(
                "codex",
                PreferredLaunchSettings(model = "gpt-5.2-codex", modelReasoningEffort = "high", permissionMode = "read-only"),
            ),
        )
        assertEquals(
            PreferredLaunchSettings(model = "gpt-5.2-codex", permissionMode = "default"),
            NewSessionLogic.resolvePreferredLaunchSettings(
                "codex",
                PreferredLaunchSettings(model = "gpt-5.2-codex", permissionMode = "safe-yolo"),
            ),
        )

        // Opencode's reasoning effort drops `xhigh` (web parity); opencode is a
        // shared-mode flavor, so its mode resolves to the default.
        assertEquals(
            PreferredLaunchSettings(modelReasoningEffort = "default", permissionMode = "default"),
            NewSessionLogic.resolvePreferredLaunchSettings(
                "opencode",
                PreferredLaunchSettings(modelReasoningEffort = "xhigh"),
            ),
        )

        // Grok / cursor never resolve a remembered mode, even if one leaked in.
        assertEquals(
            PreferredLaunchSettings(),
            NewSessionLogic.resolvePreferredLaunchSettings(
                "grok",
                PreferredLaunchSettings(permissionMode = "plan"),
            ),
        )
        assertEquals(
            PreferredLaunchSettings(),
            NewSessionLogic.resolvePreferredLaunchSettings(
                "cursor",
                PreferredLaunchSettings(permissionMode = "yolo"),
            ),
        )
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
    fun `grok auto gate disables the option, resets selection and shows hint when unsupported`() = runTest {
        val gateway = FakeGateway().apply {
            grokResult = GrokModelsResponse(success = true, autoPermissionModeSupported = false)
        }
        val vm = buildViewModel(gateway, FakeMachineStore(listOf(machine("m1", homeDir = "/home/dev"))), FakePrefs())
        advanceUntilIdle()
        vm.setAgent("grok")
        vm.setPermissionMode("auto")
        advanceUntilIdle()

        // Probe fires once for the seeded, existing directory.
        assertEquals(listOf("m1" to "/home/dev"), gateway.grokCalls)
        val state = vm.uiState.value
        val options = (state.permission as PermissionUi.NativeSelect).options
        assertEquals(listOf("default", "auto", "plan", "bypassPermissions"), options.map { it.value })
        val auto = options.single { it.value == "auto" }
        assertFalse(auto.enabled)
        assertEquals("Auto (unavailable)", auto.label)
        assertTrue(options.filter { it.value != "auto" }.all { it.enabled })
        assertTrue(state.grokAutoUnavailable)
        // The `auto` selection the user made before the probe landed is reset.
        assertEquals("default", state.form.permissionMode)

        // A new directory re-probes: the capability is cwd-scoped.
        vm.setDirectory("/home/dev/proj")
        advanceUntilIdle()
        assertEquals(listOf("m1" to "/home/dev", "m1" to "/home/dev/proj"), gateway.grokCalls)
    }

    @Test
    fun `grok auto stays available when supported, unknown, failed or falsy payload`() = runTest {
        fun vmWith(result: GrokModelsResponse, failure: Exception? = null): Pair<NewSessionViewModel, FakeGateway> {
            val gateway = FakeGateway().apply {
                grokResult = result
                grokThrows = failure
            }
            val vm = buildViewModel(gateway, FakeMachineStore(listOf(machine("m1", homeDir = "/home/dev"))), FakePrefs())
            return vm to gateway
        }

        for ((label, result, failure) in listOf(
            Triple("supported", GrokModelsResponse(success = true, autoPermissionModeSupported = true), null as Exception?),
            // Field omitted: only a literal false gates (web `=== false`).
            Triple("omitted", GrokModelsResponse(success = true), null),
            Triple("falsy payload", GrokModelsResponse(success = false), null),
            Triple("probe failure", GrokModelsResponse(success = true), RuntimeException("probe boom")),
        )) {
            val (vm, gateway) = vmWith(result, failure)
            advanceUntilIdle()
            vm.setAgent("grok")
            vm.setPermissionMode("auto")
            advanceUntilIdle()

            assertEquals(listOf("m1" to "/home/dev"), gateway.grokCalls, label)
            val state = vm.uiState.value
            val auto = (state.permission as PermissionUi.NativeSelect).options.single { it.value == "auto" }
            assertTrue(auto.enabled, label)
            assertEquals("Auto", auto.label, label)
            assertFalse(state.grokAutoUnavailable, label)
            assertEquals("auto", state.form.permissionMode, label)
        }
    }

    @Test
    fun `grok probe is gated on agent and existing directory, claude auto never gates`() = runTest {
        // Default claude agent with an existing directory: no probe, and the
        // claude Auto option (same wire value) stays fully available.
        val gateway = FakeGateway()
        val vm = buildViewModel(gateway, FakeMachineStore(listOf(machine("m1", homeDir = "/home/dev"))), FakePrefs())
        advanceUntilIdle()
        vm.setPermissionMode("auto")
        advanceUntilIdle()
        assertEquals(emptyList(), gateway.grokCalls)
        val claudeState = vm.uiState.value
        val claudeAuto = (claudeState.permission as PermissionUi.NativeSelect).options.single { it.value == "auto" }
        assertTrue(claudeAuto.enabled)
        assertFalse(claudeState.grokAutoUnavailable)
        assertEquals("auto", claudeState.form.permissionMode)

        // Grok on a non-existent directory: positive-existence gate blocks the probe.
        val missing = FakeGateway().apply { existsAnswer = { false } }
        val vm2 = buildViewModel(missing, FakeMachineStore(listOf(machine("m1", homeDir = "/gone"))), FakePrefs())
        advanceUntilIdle()
        vm2.setAgent("grok")
        advanceUntilIdle()
        assertEquals(emptyList(), missing.grokCalls)
        val missingState = vm2.uiState.value
        assertTrue((missingState.permission as PermissionUi.NativeSelect).options.single { it.value == "auto" }.enabled)
        assertFalse(missingState.grokAutoUnavailable)
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
        // Claude is on the native select now; the YOLO toggle only remains for
        // the flavors still carrying it (cursor here).
        assertTrue(vm.uiState.value.permission is PermissionUi.NativeSelect)

        vm.setAgent("cursor")
        advanceUntilIdle()
        val toggle = vm.uiState.value.permission
        assertTrue(toggle is PermissionUi.YoloToggle)
        assertEquals("Yolo", (toggle as PermissionUi.YoloToggle).nativeModeLabel)
    }

    @Test
    fun `spawn success remembers launch settings for the machine and agent dimension`() = runTest {
        val gateway = FakeGateway()
        val prefs = FakePrefs()
        val vm = buildViewModel(gateway, FakeMachineStore(listOf(machine("m1"))), prefs)
        advanceUntilIdle()

        vm.setModel("opus")
        vm.setEffort("high")
        vm.setPermissionMode("plan")
        vm.setDirectory("/repo")
        advanceUntilIdle()
        vm.create()
        advanceUntilIdle()

        assertEquals(
            mapOf(
                "m1" to mapOf(
                    "claude" to PreferredLaunchSettings(model = "opus", effort = "high", permissionMode = "plan"),
                ),
            ),
            prefs.stored.launchSettings,
        )
    }

    @Test
    fun `remembered launch settings prefill a fresh form`() = runTest {
        val prefs = FakePrefs(
            stored = NewSessionPrefsData(
                launchSettings = mapOf(
                    "m1" to mapOf(
                        "claude" to PreferredLaunchSettings(model = "opus", effort = "high", permissionMode = "plan"),
                    ),
                ),
            ),
        )
        val vm = buildViewModel(FakeGateway(), FakeMachineStore(listOf(machine("m1"))), prefs)
        advanceUntilIdle()

        val form = vm.uiState.value.form
        assertEquals("m1", form.machineId)
        assertEquals("opus", form.model)
        assertEquals("high", form.effort)
        assertEquals("plan", form.permissionMode)
    }

    @Test
    fun `same machine heartbeat preserves manual launch choices while directory is blank`() = runTest {
        val machines = FakeMachineStore(listOf(machine("m1")))
        val prefs = FakePrefs(stored = NewSessionPrefsData(launchSettings = mapOf(
            "m1" to mapOf("claude" to PreferredLaunchSettings(
                model = "opus", effort = "high", permissionMode = "bypassPermissions",
            )),
        )))
        val vm = buildViewModel(FakeGateway(), machines, prefs)
        advanceUntilIdle()
        assertEquals("opus", vm.uiState.value.form.model)
        vm.setModel("sonnet")
        vm.setEffort("low")
        vm.setPermissionMode("plan")
        advanceUntilIdle()
        val edited = vm.uiState.value.form
        assertEquals("", edited.directory)

        machines.backing.value = listOf(machine("m1").copy(activeAt = 2))
        advanceUntilIdle()
        assertEquals(edited, vm.uiState.value.form)

        // A later directory hint may fill the blank without restoring defaults.
        machines.backing.value = listOf(machine("m1", homeDir = "/home/dev"))
        advanceUntilIdle()
        assertEquals(edited.copy(directory = "/home/dev"), vm.uiState.value.form)
    }

    @Test
    fun `same machine heartbeat keeps codex reasoning effort and a stricter permission mode`() = runTest {
        val machines = FakeMachineStore(listOf(machine("m1")))
        val gateway = FakeGateway().apply {
            codexResult = CodexModelsResponse(success = true, models = listOf(
                CodexModelSummary(
                    id = "codex-model", displayName = "Codex", isDefault = true,
                    supportedReasoningEfforts = listOf("low", "high"), serviceTiers = listOf("standard"),
                ),
            ))
        }
        val prefs = FakePrefs(stored = NewSessionPrefsData(launchSettings = mapOf(
            "m1" to mapOf("codex" to PreferredLaunchSettings(
                model = "codex-model", modelReasoningEffort = "high", permissionMode = "yolo",
            )),
        )))
        val vm = buildViewModel(gateway, machines, prefs)
        advanceUntilIdle()
        vm.setAgent("codex")
        advanceUntilIdle()
        assertEquals("yolo", vm.uiState.value.form.permissionMode)
        vm.setModel("auto")
        vm.setModelReasoningEffort("low")
        vm.setPermissionMode("read-only")
        advanceUntilIdle()
        val edited = vm.uiState.value.form
        assertEquals("", edited.directory)

        machines.backing.value = listOf(machine("m1").copy(activeAt = 2))
        advanceUntilIdle()
        assertEquals(edited, vm.uiState.value.form)
    }

    @Test
    fun `initial machine selection restores launch defaults before seeding its directory`() = runTest {
        val prefs = FakePrefs(stored = NewSessionPrefsData(launchSettings = mapOf(
            "m1" to mapOf("claude" to PreferredLaunchSettings(model = "opus", effort = "high", permissionMode = "plan")),
        )))
        val vm = buildViewModel(
            FakeGateway(), FakeMachineStore(listOf(machine("m1", homeDir = "/home/dev"))), prefs,
            initialMachineId = "m1",
        )
        advanceUntilIdle()
        assertEquals("/home/dev", vm.uiState.value.form.directory)
        assertEquals("opus", vm.uiState.value.form.model)
        assertEquals("high", vm.uiState.value.form.effort)
        assertEquals("plan", vm.uiState.value.form.permissionMode)
    }

    @Test
    fun `a restored draft with a blank directory keeps its launch choices`() = runTest {
        val draft = NewSessionForm(
            machineId = "m1", model = "sonnet", effort = "low", permissionMode = "plan",
        )
        val prefs = FakePrefs(draft = draft)
        val vm = buildViewModel(
            FakeGateway(), FakeMachineStore(listOf(machine("m1", homeDir = "/home/dev"))), prefs,
        )
        advanceUntilIdle()
        assertEquals(draft.copy(directory = "/home/dev"), vm.uiState.value.form)
    }

    @Test
    fun `switching machine or agent re-applies each dimension's remembered defaults`() = runTest {
        val gateway = FakeGateway().apply {
            // Catalog contains the remembered codex model, so the settled
            // catalog keeps it (an empty catalog would reconcile to auto).
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
        val prefs = FakePrefs(
            stored = NewSessionPrefsData(
                launchSettings = mapOf(
                    "m1" to mapOf(
                        "claude" to PreferredLaunchSettings(model = "opus", effort = "high", permissionMode = "plan"),
                        "codex" to PreferredLaunchSettings(
                            model = "gpt-5.2-codex",
                            modelReasoningEffort = "high",
                            permissionMode = "read-only",
                        ),
                    ),
                ),
            ),
        )
        val vm = buildViewModel(gateway, FakeMachineStore(listOf(machine("m1"), machine("m2"))), prefs)
        advanceUntilIdle()

        // Fresh form, m1 preselected → the m1×claude defaults prefill.
        assertEquals("opus", vm.uiState.value.form.model)
        assertEquals("high", vm.uiState.value.form.effort)
        assertEquals("plan", vm.uiState.value.form.permissionMode)

        // Agent dimension: codex on m1 recalls its own model/effort/mode.
        vm.setAgent("codex")
        advanceUntilIdle()
        val codexForm = vm.uiState.value.form
        assertEquals("gpt-5.2-codex", codexForm.model)
        assertEquals("high", codexForm.modelReasoningEffort)
        assertEquals("read-only", codexForm.permissionMode)
        assertEquals("auto", codexForm.effort)

        // Machine dimension: m2 has nothing remembered → sentinels.
        vm.setMachine("m2")
        advanceUntilIdle()
        val m2Form = vm.uiState.value.form
        assertEquals("auto", m2Form.model)
        assertEquals("default", m2Form.modelReasoningEffort)
        assertEquals("default", m2Form.permissionMode)

        // Switching back to m1 recalls the m1×codex defaults again.
        vm.setMachine("m1")
        advanceUntilIdle()
        assertEquals("gpt-5.2-codex", vm.uiState.value.form.model)
        assertEquals("read-only", vm.uiState.value.form.permissionMode)

        // Grok is a native-select flavor but never remembers a mode: even a
        // leaked stored entry leaves the reset default in place.
        vm.setAgent("grok")
        advanceUntilIdle()
        assertEquals("auto", vm.uiState.value.form.model)
        assertEquals("default", vm.uiState.value.form.permissionMode)
    }

    @Test
    fun `restored draft wins over remembered launch settings until the user switches`() = runTest {
        val prefs = FakePrefs(
            stored = NewSessionPrefsData(
                launchSettings = mapOf(
                    "m1" to mapOf(
                        "claude" to PreferredLaunchSettings(model = "opus", effort = "high", permissionMode = "plan"),
                    ),
                ),
            ),
            draft = NewSessionForm(
                machineId = "m1",
                directory = "/wip",
                agent = "claude",
                model = "sonnet",
                effort = "low",
                permissionMode = "acceptEdits",
            ),
        )
        val vm = buildViewModel(FakeGateway(), FakeMachineStore(listOf(machine("m1"))), prefs)
        advanceUntilIdle()

        // The draft's in-progress selections are not clobbered by prefs.
        val form = vm.uiState.value.form
        assertEquals("sonnet", form.model)
        assertEquals("low", form.effort)
        assertEquals("acceptEdits", form.permissionMode)

        // First user agent switch drops the draft protection → sentinels
        // (nothing remembered for m1×grok), not the draft's stale values.
        vm.setAgent("grok")
        advanceUntilIdle()
        assertEquals("auto", vm.uiState.value.form.model)
        assertEquals("default", vm.uiState.value.form.permissionMode)
    }

    // ------------------------------------------------- codex import (A) --

    private fun codexSession(
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

    @Test
    fun `codex import at create replaces spawn, resumes and emits the resumed id`() = runTest {
        val gateway = FakeGateway().apply {
            codexSessionsResult = CodexLocalSessionsResponse(
                success = true,
                sessions = listOf(codexSession("thread-1")),
            )
            syncResult = CodexDesktopScriptResponse(
                success = true,
                syncedCount = 1,
                sessionIds = listOf("thread-1"),
                hapiSessionIds = listOf("h-1"),
            )
        }
        val prefs = FakePrefs()
        val vmScope = newVmScope()
        val vm = buildViewModel(gateway, FakeMachineStore(listOf(machine("m1"))), prefs, scope = vmScope)
        advanceUntilIdle()

        val spawnedIds = mutableListOf<String>()
        vmScope.launch { vm.spawned.collect(spawnedIds::add) }

        vm.setAgent("codex")
        vm.setDirectory("/data/github/hapi")
        advanceUntilIdle()
        assertTrue(vm.uiState.value.canCreate)

        vm.openCodexImportDialog()
        advanceUntilIdle()
        assertEquals(listOf<Pair<String?, String?>>("/data/github/hapi" to "m1"), gateway.codexSessionsCalls)

        vm.codexImport.toggleSession("thread-1")
        vm.codexImport.confirm() // exactly one checked row → inline select + close
        advanceUntilIdle()
        assertFalse(vm.codexImport.state.value.open)
        assertEquals("thread-1", vm.codexImport.state.value.selectedSessionId)
        // Selecting inline adopts the session cwd as the form directory.
        assertEquals("/repo", vm.uiState.value.form.directory)
        assertTrue(vm.uiState.value.canCreate)

        vm.create()
        advanceUntilIdle()

        assertEquals(0, gateway.spawnCalls.size, "import replaces the spawn call")
        val sync = gateway.syncCalls.single()
        assertEquals(listOf("thread-1"), sync.sessionIds)
        assertEquals("/repo", sync.cwd, "session cwd wins over the form directory")
        assertEquals("m1", sync.machineId, "listing machine id backfilled from the load")
        assertNull(sync.model, "model=auto is omitted")
        assertNull(sync.modelReasoningEffort, "default effort is omitted")
        assertNull(sync.serviceTier, "fast tier not visible")
        assertEquals("default", sync.collaborationMode, "collaborationMode always sent")
        assertEquals(false, sync.yolo)
        assertEquals(listOf<Pair<String, String?>>("h-1" to null), gateway.resumeCalls, "default permission mode omits resume permissionMode")
        assertEquals(listOf("s-resumed"), spawnedIds)
        assertEquals(setOf("thread-1"), vm.codexImport.state.value.importedMarkers.keys)
        assertEquals("m1", prefs.stored.lastMachineId)
        assertTrue(prefs.draftCleared)
    }

    @Test
    fun `codex import soft failure lands raw in the create error`() = runTest {
        val gateway = FakeGateway().apply {
            codexSessionsResult = CodexLocalSessionsResponse(
                success = true,
                sessions = listOf(codexSession("thread-1", cwd = null)),
            )
            syncResult = CodexDesktopScriptResponse(success = false, error = "boom")
        }
        val vm = buildViewModel(gateway, FakeMachineStore(listOf(machine("m1"))), FakePrefs())
        advanceUntilIdle()

        vm.setAgent("codex")
        vm.setDirectory("/data/work")
        advanceUntilIdle()

        vm.openCodexImportDialog()
        advanceUntilIdle()
        vm.codexImport.toggleSession("thread-1")
        vm.codexImport.confirm()
        advanceUntilIdle()
        assertEquals("thread-1", vm.codexImport.state.value.selectedSessionId)

        vm.create()
        advanceUntilIdle()

        assertEquals(1, gateway.syncCalls.size)
        assertEquals(0, gateway.resumeCalls.size)
        assertEquals("boom", vm.uiState.value.spawnError, "soft failure error is raw, not normalized")
    }

    @Test
    fun `codex load failure surfaces on the inline section and clears context`() = runTest {
        val gateway = FakeGateway().apply {
            codexSessionsThrows = RuntimeException("rpc down")
        }
        val vm = buildViewModel(gateway, FakeMachineStore(listOf(machine("m1"))), FakePrefs())
        advanceUntilIdle()

        vm.setAgent("codex")
        vm.setDirectory("/data/work")
        vm.openCodexImportDialog()
        advanceUntilIdle()

        val state = vm.codexImport.state.value
        assertTrue(state.open)
        assertTrue(state.sessions.isEmpty())
        assertNull(state.machineId)
        assertEquals("rpc down", state.error)
        assertEquals("rpc down", vm.uiState.value.codexImport.error)
    }

    @Test
    fun `switching away from codex clears import state`() = runTest {
        val gateway = FakeGateway().apply {
            codexSessionsResult = CodexLocalSessionsResponse(
                success = true,
                sessions = listOf(codexSession("thread-1")),
            )
        }
        val vm = buildViewModel(gateway, FakeMachineStore(listOf(machine("m1"))), FakePrefs())
        advanceUntilIdle()

        vm.setAgent("codex")
        vm.setDirectory("/data/work")
        vm.openCodexImportDialog()
        advanceUntilIdle()
        vm.codexImport.toggleSession("thread-1")
        vm.codexImport.confirm()
        advanceUntilIdle()
        assertEquals("thread-1", vm.codexImport.state.value.selectedSessionId)

        vm.setAgent("claude")
        advanceUntilIdle()

        val state = vm.codexImport.state.value
        assertFalse(state.open)
        assertTrue(state.sessions.isEmpty())
        assertNull(state.selectedSessionId)
        assertNull(state.error)
        assertNull(state.machineId)
    }

    @Test
    fun `machine change drops the codex listing context`() = runTest {
        val gateway = FakeGateway().apply {
            codexSessionsResult = CodexLocalSessionsResponse(
                success = true,
                sessions = listOf(codexSession("thread-1")),
                machineId = "m1",
            )
        }
        val vm = buildViewModel(
            gateway,
            FakeMachineStore(listOf(machine("m1", workspaceRoots = listOf("/data")), machine("m2"))),
            FakePrefs(),
        )
        advanceUntilIdle()

        vm.setAgent("codex")
        vm.setDirectory("/data/work")
        vm.openCodexImportDialog()
        advanceUntilIdle()
        assertEquals("m1", vm.codexImport.state.value.machineId)

        vm.setMachine("m2")
        advanceUntilIdle()

        val state = vm.codexImport.state.value
        assertTrue(state.sessions.isEmpty())
        assertNull(state.machineId)
        assertNull(state.selectedSessionId)
    }
}

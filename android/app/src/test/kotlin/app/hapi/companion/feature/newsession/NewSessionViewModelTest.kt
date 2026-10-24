@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package app.hapi.companion.feature.newsession

import app.hapi.data.api.ApiError
import app.hapi.data.store.MachineListStore
import app.hapi.protocol.catalog.AgentFlavor
import app.hapi.protocol.wire.AgentAvailabilityEntry
import app.hapi.protocol.wire.AgentAvailabilityResponse
import app.hapi.protocol.wire.AgyModelSummary
import app.hapi.protocol.wire.AgyModelsResponse
import app.hapi.protocol.wire.CodexModelSummary
import app.hapi.protocol.wire.CodexModelsResponse
import app.hapi.protocol.wire.CopilotModelSummary
import app.hapi.protocol.wire.CopilotModelsResponse
import app.hapi.protocol.wire.CursorModelsResponse
import app.hapi.protocol.wire.GrokModelSummary
import app.hapi.protocol.wire.GrokModelsResponse
import app.hapi.protocol.wire.GrokReasoningEffortOption
import app.hapi.protocol.wire.HapiJson
import app.hapi.protocol.wire.KimiModelSummary
import app.hapi.protocol.wire.KimiModelsResponse
import app.hapi.protocol.wire.Machine
import app.hapi.protocol.wire.MachineDirectoryEntry
import app.hapi.protocol.wire.MachineListDirectoryResponse
import app.hapi.protocol.wire.MachineMetadata
import app.hapi.protocol.wire.MachinePathsExistsResponse
import app.hapi.protocol.wire.OpencodeModelSummary
import app.hapi.protocol.wire.OpencodeModelVariantsResponse
import app.hapi.protocol.wire.OpencodeModelsResponse
import app.hapi.protocol.wire.PiModelSummary
import app.hapi.protocol.wire.PiModelsResponse
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

    // Flavor catalogs: every call recorded (args included) with a queue of
    // scripted results — dequeue per call, last entry repeats.
    val agyCalls = mutableListOf<Pair<String, Boolean>>()
    val piCalls = mutableListOf<String>()
    val cursorCalls = mutableListOf<String>()
    val opencodeModelsCalls = mutableListOf<Pair<String, String>>()
    val opencodeVariantsCalls = mutableListOf<Pair<String, String?>>()
    val grokCalls = mutableListOf<Pair<String, String>>()
    val copilotCalls = mutableListOf<Pair<String, String>>()
    val kimiCalls = mutableListOf<Pair<String, String>>()

    var agyResults = mutableListOf<AgyModelsResponse>()
    var piResults = mutableListOf<PiModelsResponse>()
    var cursorResults = mutableListOf<CursorModelsResponse>()
    var opencodeModelsResults = mutableListOf<OpencodeModelsResponse>()
    var opencodeVariantsResults = mutableListOf<OpencodeModelVariantsResponse>()
    var grokResults = mutableListOf<GrokModelsResponse>()
    var copilotResults = mutableListOf<CopilotModelsResponse>()
    var kimiResults = mutableListOf<KimiModelsResponse>()

    /** Optional suspending intercepts to park a fetch in Loading. */
    var agyHandler: (suspend (String, Boolean) -> AgyModelsResponse)? = null
    var cursorHandler: (suspend (String) -> CursorModelsResponse)? = null
    var grokHandler: (suspend (String, String) -> GrokModelsResponse)? = null

    private fun <T> dequeue(queue: MutableList<T>, fallback: T): T =
        synchronized(queue) {
            if (queue.size > 1) queue.removeAt(0) else queue.firstOrNull() ?: fallback
        }

    override suspend fun agyModels(machineId: String, refresh: Boolean): AgyModelsResponse {
        agyCalls.add(machineId to refresh)
        agyHandler?.let { return it(machineId, refresh) }
        return dequeue(agyResults, AgyModelsResponse(success = true))
    }

    override suspend fun cursorModels(machineId: String): CursorModelsResponse {
        cursorCalls.add(machineId)
        cursorHandler?.let { return it(machineId) }
        return dequeue(cursorResults, CursorModelsResponse(success = true))
    }

    override suspend fun grokModels(machineId: String, cwd: String): GrokModelsResponse {
        grokCalls.add(machineId to cwd)
        grokHandler?.let { return it(machineId, cwd) }
        return dequeue(grokResults, GrokModelsResponse(success = true))
    }

    override suspend fun piModels(machineId: String): PiModelsResponse {
        piCalls.add(machineId)
        return dequeue(piResults, PiModelsResponse(success = true))
    }

    override suspend fun opencodeModels(machineId: String, cwd: String): OpencodeModelsResponse {
        opencodeModelsCalls.add(machineId to cwd)
        return dequeue(opencodeModelsResults, OpencodeModelsResponse(success = true))
    }

    override suspend fun opencodeModelVariants(machineId: String, cwd: String?): OpencodeModelVariantsResponse {
        opencodeVariantsCalls.add(machineId to cwd)
        return dequeue(opencodeVariantsResults, OpencodeModelVariantsResponse(success = true))
    }

    override suspend fun copilotModels(machineId: String, cwd: String): CopilotModelsResponse {
        copilotCalls.add(machineId to cwd)
        return dequeue(copilotResults, CopilotModelsResponse(success = true))
    }

    override suspend fun kimiModels(machineId: String, cwd: String): KimiModelsResponse {
        kimiCalls.add(machineId to cwd)
        return dequeue(kimiResults, KimiModelsResponse(success = true))
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
        // Cursor ALWAYS pins the wire model (`auto` or the exact id — the CLI
        // needs the explicit flag, web `resolvedModel` for cursor).
        assertEquals(setOf("directory", "agent", "model", "yolo", "sessionType"), cursor.keys)
        assertEquals("sonic", cursor["model"]!!.jsonPrimitive.content)
        assertEquals(true, cursor["yolo"]!!.jsonPrimitive.boolean)

        val cursorAuto = encode(
            NewSessionLogic.buildSpawnRequest(
                NewSessionForm(directory = "/repo", agent = "cursor"),
                codexFastTierVisible = false,
            ),
        )
        assertEquals("auto", cursorAuto["model"]!!.jsonPrimitive.content)
    }

    @Test
    fun `flavor spawn bodies map model, effort and permission fields per flavor`() {
        // agy: catalog model when picked, omitted when auto; yolo (no native select).
        val agy = encode(
            NewSessionLogic.buildSpawnRequest(
                NewSessionForm(directory = "/repo", agent = "agy", model = "gemini-3.7-flash-high", yolo = true),
                codexFastTierVisible = false,
            ),
        )
        assertEquals(setOf("directory", "agent", "model", "yolo", "sessionType"), agy.keys)
        assertEquals("gemini-3.7-flash-high", agy["model"]!!.jsonPrimitive.content)
        val agyAuto = encode(
            NewSessionLogic.buildSpawnRequest(
                NewSessionForm(directory = "/repo", agent = "agy"),
                codexFastTierVisible = false,
            ),
        )
        assertEquals(setOf("directory", "agent", "yolo", "sessionType"), agyAuto.keys)

        // opencode: model + modelReasoningEffort + native permissionMode, never yolo.
        val opencode = encode(
            NewSessionLogic.buildSpawnRequest(
                NewSessionForm(
                    directory = "/repo",
                    agent = "opencode",
                    model = "glm-5.3",
                    modelReasoningEffort = "high",
                    yolo = true,
                ),
                codexFastTierVisible = false,
            ),
        )
        assertEquals(
            setOf("directory", "agent", "model", "modelReasoningEffort", "permissionMode", "sessionType"),
            opencode.keys,
        )
        assertEquals("default", opencode["permissionMode"]!!.jsonPrimitive.content)

        // grok: catalog model + launch effort + permissionMode (auto honored).
        val grok = encode(
            NewSessionLogic.buildSpawnRequest(
                NewSessionForm(directory = "/repo", agent = "grok", model = "grok-4", effort = "high"),
                codexFastTierVisible = false,
            ),
        )
        assertEquals(setOf("directory", "agent", "model", "effort", "permissionMode", "sessionType"), grok.keys)
        assertEquals("high", grok["effort"]!!.jsonPrimitive.content)

        // pi: provider-qualified model + launch effort; managed permission → no permissionMode.
        val pi = encode(
            NewSessionLogic.buildSpawnRequest(
                NewSessionForm(directory = "/repo", agent = "pi", model = "anthropic/claude", effort = "low"),
                codexFastTierVisible = false,
            ),
        )
        assertEquals(setOf("directory", "agent", "model", "effort", "yolo", "sessionType"), pi.keys)

        // copilot/kimi: catalog model + native permissionMode, no effort.
        val copilot = encode(
            NewSessionLogic.buildSpawnRequest(
                NewSessionForm(directory = "/repo", agent = "copilot", model = "gpt-5.2"),
                codexFastTierVisible = false,
            ),
        )
        assertEquals(setOf("directory", "agent", "model", "permissionMode", "copilotAgentMode", "sessionType"), copilot.keys)
        val kimi = encode(
            NewSessionLogic.buildSpawnRequest(
                NewSessionForm(directory = "/repo", agent = "kimi", model = "k2", effort = "high"),
                codexFastTierVisible = false,
            ),
        )
        assertEquals(setOf("directory", "agent", "model", "permissionMode", "sessionType"), kimi.keys)
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
    fun `pre-slice drafts without cursorSelectedBase decode with the auto default`() {
        // Draft JSON written before the cursor base picker existed: the new
        // additive field must default instead of failing the restore.
        val legacy = HapiJson.decodeFromString(
            NewSessionForm.serializer(),
            """
            {"machineId":"m1","directory":"/repo","agent":"cursor","model":"sonic",
             "effort":"auto","modelReasoningEffort":"default","permissionMode":"default",
             "yolo":false,"sessionType":"simple","worktreeName":"",
             "serviceTier":"standard","collaborationMode":"default","copilotAgentMode":"interactive"}
            """.trimIndent(),
        )
        assertEquals("cursor", legacy.agent)
        assertEquals("sonic", legacy.model)
        assertEquals("auto", legacy.cursorSelectedBase)
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

    // -------------------------------------------------- flavor model pickers --

    private fun agySuccess(vararg models: AgyModelSummary, warning: String? = null) =
        AgyModelsResponse(
            success = true,
            availableModels = models.toList(),
            currentModelId = null,
            error = warning,
        )

    @Test
    fun `agy catalog renders rows, keeps picked unlisted models and spends refresh on retry`() = runTest {
        val gateway = FakeGateway().apply {
            agyResults = mutableListOf(
                agySuccess(AgyModelSummary(modelId = "gemini-3.7-flash-high", name = "Gemini 3.7 Flash (High)")),
            )
        }
        val vm = buildViewModel(gateway, FakeMachineStore(listOf(machine("m1"))), FakePrefs())
        advanceUntilIdle()
        assertEquals(0, gateway.agyCalls.size) // machine-scoped gate: claude fetches nothing

        vm.setAgent("agy")
        advanceUntilIdle()
        assertEquals(listOf("m1" to false), gateway.agyCalls)
        val ready = vm.uiState.value.agy
        assertTrue(ready is AgyUi.Ready)
        assertEquals(listOf("auto", "gemini-3.7-flash-high"), ready.options.map { it.value })
        assertEquals("Gemini 3.7 Flash (High)", ready.options[1].label)
        assertEquals("auto", ready.selected)
        assertNull(ready.warning)

        vm.setModel("gemini-3.6-flash-low") // picked by the user
        advanceUntilIdle()

        // Catalog swap drops the picked model — Retry refetches with refresh.
        gateway.agyResults = mutableListOf(agySuccess(AgyModelSummary(modelId = "gemini-3.7-flash-high", name = "Gemini 3.7 Flash (High)")))
        vm.retryAgyModels()
        advanceUntilIdle()
        assertEquals(listOf("m1" to false, "m1" to true), gateway.agyCalls)
        val kept = vm.uiState.value.agy
        assertTrue(kept is AgyUi.Ready)
        // Synthetic "(no longer listed)" row keeps the picked selection visible.
        assertEquals("gemini-3.6-flash-low", kept.selected)
        assertEquals(
            listOf("auto", "gemini-3.6-flash-low", "gemini-3.7-flash-high"),
            kept.options.map { it.value },
        )
        assertEquals("Gemini 3.6 Flash (Low) (no longer listed)", kept.options[1].label)
    }

    @Test
    fun `agy auth failure renders the error wall and Retry recovers`() = runTest {
        val gateway = FakeGateway().apply {
            agyResults = mutableListOf(
                AgyModelsResponse(success = false, error = "Please run agy to sign in"),
            )
        }
        val vm = buildViewModel(gateway, FakeMachineStore(listOf(machine("m1"))), FakePrefs())
        advanceUntilIdle()
        vm.setAgent("agy")
        advanceUntilIdle()
        val error = vm.uiState.value.agy
        assertTrue(error is AgyUi.Error)
        assertEquals("Please run agy to sign in", error.message)

        gateway.agyResults = mutableListOf(
            agySuccess(AgyModelSummary(modelId = "gemini-3.7-flash-high", name = null), warning = "stale sign-in"),
        )
        vm.retryAgyModels()
        advanceUntilIdle()
        val ready = vm.uiState.value.agy
        assertTrue(ready is AgyUi.Ready)
        assertEquals("stale sign-in", ready.warning) // amber banner over a usable list

        gateway.agyResults = mutableListOf(agySuccess())
        vm.retryAgyModels()
        advanceUntilIdle()
        assertTrue(vm.uiState.value.agy is AgyUi.NoModels)
    }

    @Test
    fun `agy draft restore reconciles an unpicked stale selection to default`() = runTest {
        val gateway = FakeGateway().apply {
            agyResults = mutableListOf(agySuccess(AgyModelSummary(modelId = "gemini-3.7-flash-high", name = null)))
        }
        val prefs = FakePrefs(
            draft = NewSessionForm(machineId = "m1", directory = "/repo", agent = "agy", model = "stale-model"),
        )
        val vm = buildViewModel(gateway, FakeMachineStore(listOf(machine("m1"))), prefs)
        advanceUntilIdle()
        // Restored selection is NOT user-picked: the catalog reconcile drops it.
        assertEquals("auto", vm.uiState.value.form.model)
        val ready = vm.uiState.value.agy
        assertTrue(ready is AgyUi.Ready)
        assertEquals("auto", ready.selected)
    }

    @Test
    fun `grok coerces unsupported auto permission, disables the row and reconciles efforts`() = runTest {
        val gateway = FakeGateway().apply {
            grokResults = mutableListOf(
                GrokModelsResponse(
                    success = true,
                    availableModels = listOf(
                        GrokModelSummary(
                            modelId = "grok-4",
                            name = "Grok 4",
                            reasoningEfforts = listOf(GrokReasoningEffortOption(value = "low"), GrokReasoningEffortOption(value = "high")),
                        ),
                    ),
                    currentModelId = null,
                    autoPermissionModeSupported = false,
                ),
            )
        }
        val vm = buildViewModel(gateway, FakeMachineStore(listOf(machine("m1"))), FakePrefs())
        advanceUntilIdle()
        vm.setAgent("grok")
        vm.setDirectory("/repo")
        advanceUntilIdle()
        assertEquals(listOf("m1" to "/repo"), gateway.grokCalls)
        assertEquals(
            listOf(OptionItem("auto", "Default"), OptionItem("grok-4", "Grok 4")),
            vm.uiState.value.modelOptions,
        )

        // Click-time guard: the machine proved Auto unsupported → default.
        vm.setPermissionMode("auto")
        runCurrent()
        assertEquals("default", vm.uiState.value.form.permissionMode)
        val permission = vm.uiState.value.permission
        assertTrue(permission is PermissionUi.NativeSelect)
        assertEquals(setOf("auto"), permission.disabledValues)
        assertTrue(permission.options.first { it.value == "auto" }.label.endsWith("(unavailable)"))
        assertFalse(permission.options.first { it.value == "auto" }.enabled)
        assertEquals("Grok did not enable Auto permissions for this account or CLI build.", permission.hint)

        // A ready catalog with permissionMode=auto coerces on arrival too.
        vm.setDirectory("/repo2")
        advanceUntilIdle()
        assertEquals("default", vm.uiState.value.form.permissionMode)

        // Effort off the effective model's advertised list resets on refetch.
        vm.setModel("grok-4")
        vm.setEffort("medium") // not in [auto, low, high]
        vm.setDirectory("/repo3")
        advanceUntilIdle()
        assertEquals("auto", vm.uiState.value.form.effort)
        // The advertised list drives the rendered options.
        assertEquals(
            listOf("auto", "low", "high"),
            vm.uiState.value.effortOptions?.map { it.value },
        )
    }

    @Test
    fun `opencode adopts the backend default, keeps explicit Default and validates effort against variants`() = runTest {
        val gateway = FakeGateway().apply {
            opencodeModelsResults = mutableListOf(
                OpencodeModelsResponse(
                    success = true,
                    availableModels = listOf(
                        OpencodeModelSummary(modelId = "a-model", name = null),
                        OpencodeModelSummary(modelId = "b-model", name = null),
                    ),
                    currentModelId = "b-model",
                ),
            )
            opencodeVariantsResults = mutableListOf(
                OpencodeModelVariantsResponse(
                    success = true,
                    variants = mapOf("a-model" to listOf("a-low"), "b-model" to emptyList()),
                ),
            )
        }
        val vm = buildViewModel(gateway, FakeMachineStore(listOf(machine("m1"))), FakePrefs())
        advanceUntilIdle()
        vm.setAgent("opencode")
        vm.setDirectory("/repo")
        advanceUntilIdle()
        assertEquals(listOf("m1" to "/repo"), gateway.opencodeModelsCalls)
        assertEquals(listOf("m1"), gateway.opencodeVariantsCalls.map { it.first })

        // Uninitialized selection adopts the backend default row.
        assertEquals("b-model", vm.uiState.value.form.model)
        val ready = vm.uiState.value.opencode
        assertTrue(ready is OpencodeUi.Ready)
        assertEquals(listOf("auto", "a-model", "b-model"), ready.options.map { it.value })
        assertEquals("b-model (Default)", ready.options[2].label) // (default) annotation
        assertEquals("b-model", ready.selected)

        // Explicit Default is a settled choice — a refetch must not re-adopt.
        vm.setModel("auto")
        gateway.opencodeModelsResults = mutableListOf(
            OpencodeModelsResponse(
                success = true,
                availableModels = listOf(OpencodeModelSummary(modelId = "b-model", name = null)),
                currentModelId = "b-model",
            ),
        )
        vm.retryOpencodeModels()
        advanceUntilIdle()
        assertEquals("auto", vm.uiState.value.form.model)

        // b-model has no variants → any non-default effort is invalid → reset;
        // the effort field hides for a variant-less dynamic model.
        vm.setModel("b-model")
        vm.setModelReasoningEffort("high")
        vm.retryOpencodeModels()
        advanceUntilIdle()
        assertEquals("default", vm.uiState.value.form.modelReasoningEffort)
        assertNull(vm.uiState.value.reasoningEffortOptions)

        // A model with variants renders the dynamic effort list.
        vm.setModel("a-model")
        runCurrent()
        assertEquals(
            listOf("default", "a-low"),
            vm.uiState.value.reasoningEffortOptions?.map { it.value },
        )
    }

    @Test
    fun `cursor dual picker defers a base pick while loading, flushes it and guards create`() = runTest {
        val gateway = FakeGateway()
        var parked: Continuation<CursorModelsResponse>? = null
        gateway.cursorHandler = { _ -> suspendCoroutine { parked = it } }
        val vm = buildViewModel(gateway, FakeMachineStore(listOf(machine("m1"))), FakePrefs())
        advanceUntilIdle()
        vm.setAgent("cursor")
        advanceUntilIdle()
        assertTrue(vm.uiState.value.cursor is CursorUi.Loading)

        // Base picked while the catalog is still loading → deferred.
        vm.setCursorBase("composer-2.5")
        runCurrent()
        assertEquals("composer-2.5", vm.uiState.value.form.cursorSelectedBase)

        parked!!.resumeWith(
            Result.success(
                CursorModelsResponse(
                    success = true,
                    availableModels = listOf(
                        OpencodeModelSummary(modelId = "composer-2.5[fast=true]", name = null),
                        OpencodeModelSummary(modelId = "composer-2.5[smart=true]", name = null),
                    ),
                    cliModelSkus = emptyList(),
                ),
            ),
        )
        advanceUntilIdle()
        // Flush applied the deferred base: multi-variant → wire stays Auto.
        val ready = vm.uiState.value.cursor
        assertTrue(ready is CursorUi.Ready)
        assertEquals(CursorModels.PickerMode.DUAL, ready.mode)
        assertEquals(listOf("auto", "composer-2.5"), ready.modelOptions.map { it.value })
        assertEquals("composer-2.5", ready.selectedModel)
        assertTrue(ready.showVariantPicker)
        assertEquals("auto", ready.selectedVariant) // placeholder while no wire picked

        // Create without a variant pick is blocked with the guard message.
        vm.setDirectory("/repo")
        advanceUntilIdle()
        assertTrue(vm.uiState.value.canCreate)
        vm.create()
        advanceUntilIdle()
        assertEquals(0, gateway.spawnCalls.size)
        assertEquals("Select variant", vm.uiState.value.spawnError)

        // Variant pick sends the exact wire id.
        vm.setCursorVariant("composer-2.5[smart=true]")
        vm.create()
        advanceUntilIdle()
        assertEquals(1, gateway.spawnCalls.size)
        assertEquals("composer-2.5[smart=true]", gateway.spawnCalls.single().second.model)
    }

    @Test
    fun `cursor flat picker sends the wire and reconciles unlisted selections`() = runTest {
        val gateway = FakeGateway()
        val machines = FakeMachineStore(listOf(machine("m1"), machine("m2")))
        val vm = buildViewModel(gateway, machines, FakePrefs())
        advanceUntilIdle()
        gateway.cursorResults = mutableListOf(
            CursorModelsResponse(
                success = true,
                availableModels = listOf(OpencodeModelSummary(modelId = "alpha-2", name = null)),
                cliModelSkus = emptyList(),
            ),
        )
        vm.setAgent("cursor")
        advanceUntilIdle()
        val ready = vm.uiState.value.cursor
        assertTrue(ready is CursorUi.Ready)
        assertEquals(CursorModels.PickerMode.FLAT, ready.mode)
        assertEquals(listOf("auto", "alpha-2"), ready.modelOptions.map { it.value })
        assertFalse(ready.showVariantPicker)

        // Flat pick routes through setModel; the base row tracks the wire.
        vm.setModel("alpha-2")
        runCurrent()
        assertEquals("alpha-2", vm.uiState.value.form.model)
        assertEquals("alpha-2", vm.uiState.value.form.cursorSelectedBase)

        // A machine switch refetches (per-machine key); a catalog that no
        // longer lists the wire resets model + base to Auto.
        gateway.cursorResults = mutableListOf(
            CursorModelsResponse(
                success = true,
                availableModels = listOf(OpencodeModelSummary(modelId = "beta-1", name = null)),
                cliModelSkus = emptyList(),
            ),
        )
        vm.setMachine("m2")
        advanceUntilIdle()
        assertEquals(listOf("m1", "m2"), gateway.cursorCalls)
        assertEquals("auto", vm.uiState.value.form.model)
        assertEquals("auto", vm.uiState.value.form.cursorSelectedBase)
    }

    @Test
    fun `copilot and kimi reconcile unlisted selections and label their rows`() = runTest {
        val gateway = FakeGateway().apply {
            copilotResults = mutableListOf(
                CopilotModelsResponse(
                    success = true,
                    availableModels = listOf(CopilotModelSummary(modelId = "gpt-5.2", name = "GPT-5.2")),
                ),
            )
            kimiResults = mutableListOf(
                KimiModelsResponse(
                    success = true,
                    availableModels = listOf(KimiModelSummary(modelId = "glm-5.3", name = "GLM-5.3", provider = "TheHive")),
                ),
            )
        }
        val vm = buildViewModel(gateway, FakeMachineStore(listOf(machine("m1"))), FakePrefs())
        advanceUntilIdle()

        vm.setAgent("copilot")
        vm.setDirectory("/repo")
        advanceUntilIdle()
        assertEquals(listOf("m1" to "/repo"), gateway.copilotCalls)
        assertEquals(
            listOf(OptionItem("auto", "Auto"), OptionItem("gpt-5.2", "GPT-5.2")),
            vm.uiState.value.modelOptions,
        )
        vm.setModel("gpt-5.2")
        gateway.copilotResults = mutableListOf(CopilotModelsResponse(success = true, availableModels = emptyList()))
        vm.setDirectory("/repo2") // new cwd key → refetch → reconcile
        advanceUntilIdle()
        assertEquals("auto", vm.uiState.value.form.model)

        vm.setAgent("kimi")
        vm.setDirectory("/repo")
        advanceUntilIdle()
        assertEquals(listOf("m1" to "/repo"), gateway.kimiCalls)
        assertEquals(
            listOf(OptionItem("auto", "Default"), OptionItem("glm-5.3", "TheHive — GLM-5.3")),
            vm.uiState.value.modelOptions,
        )
    }

    @Test
    fun `pi resolves provider-qualified picks and drops unsupported effort or unlisted models`() = runTest {
        val gateway = FakeGateway().apply {
            piResults = mutableListOf(
                PiModelsResponse(
                    success = true,
                    availableModels = listOf(
                        PiModelSummary(
                            provider = "anthropic",
                            modelId = "claude",
                            name = "Claude",
                            reasoning = true,
                            thinkingLevelMap = mapOf("low" to "low", "high" to null),
                        ),
                        PiModelSummary(provider = "local", modelId = "nr-model", name = null, reasoning = false),
                    ),
                ),
            )
        }
        val vm = buildViewModel(gateway, FakeMachineStore(listOf(machine("m1"))), FakePrefs())
        advanceUntilIdle()
        vm.setAgent("pi")
        advanceUntilIdle()
        assertEquals(listOf("m1"), gateway.piCalls)
        assertEquals(
            listOf(OptionItem("auto", "Default"), OptionItem("anthropic/claude", "Claude"), OptionItem("local/nr-model", "nr-model")),
            vm.uiState.value.modelOptions,
        )

        // Unsupported thinking level (high mapped to null) resets with the pick.
        vm.setEffort("high")
        vm.setModel("anthropic/claude")
        runCurrent()
        assertEquals("auto", vm.uiState.value.form.effort)
        // The supported dynamic options come from the model's map: the
        // null-mapped high drops, xhigh/max lack explicit entries.
        assertEquals(listOf("auto", "off", "minimal", "low", "medium"), vm.uiState.value.effortOptions?.map { it.value })

        // A non-reasoning model hides the effort field entirely.
        vm.setModel("local/nr-model")
        runCurrent()
        assertNull(vm.uiState.value.effortOptions)
        assertEquals("auto", vm.uiState.value.form.effort)

        // Unlisted pick → model + effort reset.
        vm.setModel("openai/gpt")
        advanceUntilIdle()
        assertEquals("auto", vm.uiState.value.form.model)
    }

    @Test
    fun `flavor catalog loading gates Create until the selection resolves`() = runTest {
        val gateway = FakeGateway()
        var parked: Continuation<GrokModelsResponse>? = null
        gateway.grokHandler = { _, _ -> suspendCoroutine { parked = it } }
        val vm = buildViewModel(gateway, FakeMachineStore(listOf(machine("m1"))), FakePrefs())
        advanceUntilIdle()
        vm.setAgent("grok")
        vm.setDirectory("/repo")
        advanceUntilIdle()
        vm.setModel("grok-4") // non-default pick while the catalog is pending
        runCurrent()
        assertFalse(vm.uiState.value.canCreate)
        assertTrue(vm.uiState.value.modelsLoading)

        // Auto picked while the catalog is pending: the arrival of a catalog
        // that proves Auto unsupported coerces the permission mode.
        vm.setPermissionMode("auto")
        runCurrent()
        assertEquals("auto", vm.uiState.value.form.permissionMode)

        parked!!.resumeWith(
            Result.success(
                GrokModelsResponse(
                    success = true,
                    availableModels = listOf(GrokModelSummary(modelId = "grok-4", name = null)),
                    autoPermissionModeSupported = false,
                ),
            ),
        )
        advanceUntilIdle()
        assertTrue(vm.uiState.value.canCreate)
        assertEquals("grok-4", vm.uiState.value.form.model)
        assertEquals("default", vm.uiState.value.form.permissionMode)
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

}

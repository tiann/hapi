package app.hapi.companion.feature.newsession

import app.hapi.companion.feature.directorybrowser.RemoteDirectoryBrowserController
import app.hapi.companion.feature.directorybrowser.RemoteDirectoryPath
import app.hapi.companion.feature.newsession.NewSessionLogic.buildSpawnRequest
import app.hapi.companion.feature.newsession.NewSessionLogic.parentQuery
import app.hapi.companion.feature.newsession.NewSessionLogic.pushRecent
import app.hapi.companion.feature.newsession.NewSessionLogic.usesNativePermissionSelect
import app.hapi.companion.feature.newsession.NewSessionLogic.worktreeNameError
import app.hapi.data.api.ApiError
import app.hapi.data.store.MachineListStore
import app.hapi.protocol.catalog.AgentFlavor
import app.hapi.protocol.catalog.CodexCollaborationMode
import app.hapi.protocol.catalog.CopilotAgentMode
import app.hapi.protocol.catalog.Flavors
import app.hapi.protocol.catalog.PermissionMode
import app.hapi.protocol.catalog.PermissionModes
import app.hapi.protocol.wire.CodexModelSummary
import app.hapi.protocol.wire.AgentAvailabilityEntry
import app.hapi.protocol.wire.Machine
import app.hapi.protocol.wire.MachineDirectoryEntry
import app.hapi.protocol.wire.objOrNull
import app.hapi.protocol.wire.longOrNull
import app.hapi.protocol.wire.stringOrNull
import java.text.DateFormat
import java.util.Date
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

// ------------------------------------------------------------- UI models --

data class MachineOptionUi(
    val id: String,
    /** `displayName || host || id.take(8)` plus ` (platform)` and CLI version. */
    val label: String,
    /** e.g. `CPU 12% · Mem 45%`; null when the runner reports no health. */
    val healthLabel: String?,
)

/** Directory hint under the input (web `directoryStatusMessage` + tone). */
data class DirectoryStatusUi(val message: String, val isError: Boolean)

/**
 * User-facing strings the form ViewModel needs (B-M5a Strings seam): defaults
 * are the pre-i18n English (JVM tests construct without arguments; the MSG_*
 * companion constants they assert against alias these defaults); production
 * passes resource-resolved values from the Navigation holder.
 */
class NewSessionStrings(
    val worktreeMissing: String = NewSessionViewModel.MSG_WORKTREE_MISSING,
    val directoryMissing: String = NewSessionViewModel.MSG_DIRECTORY_MISSING,
    val directoryMissingConfirm: String = NewSessionViewModel.MSG_DIRECTORY_MISSING_CONFIRM,
    val createFailed: String = "Failed to create session",
    val codexModelsFailed: String = "Failed to load Codex models",
    /** `%1$s` = failure detail. */
    val modelsFailedDetail: String = "Failed to load models: %1\$s",
    val worktreeNameInvalid: String = "Name needs at least one letter or digit",
    val directoryOutsideWorkspaceRoots: String = "Directory must be inside one of this machine's workspace roots.",
    val directoryLookupFailed: String = "Failed to browse directories",
    val agentAvailabilityFailed: String = "Failed to check installed Agents",
    val runnerUpgradeRequired: String = "Upgrade and restart this machine's HAPI runner before creating sessions.",
    val noAvailableAgents: String = "No supported Agents are installed on this machine.",
    val selectedAgentUnavailable: String = "The selected Agent is not available on this machine.",
)

/** Which permission control the current flavor renders (web `PermissionField`). */
sealed interface PermissionUi {
    /** Native permission-mode picker (grok + codex-family). */
    data class NativeSelect(val options: List<OptionItem>) : PermissionUi

    /** HAPI YOLO toggle (claude/agy/cursor) with the native mode it maps to. */
    data class YoloToggle(val nativeModeLabel: String?) : PermissionUi

    /** Pi: the agent manages its own permissions. */
    data object Managed : PermissionUi
}

/** Machine codex-models catalog state (web `useCodexModels`). */
sealed interface CodexModelsUi {
    data object Hidden : CodexModelsUi
    data object Loading : CodexModelsUi
    data class Loaded(val models: List<CodexModelSummary>) : CodexModelsUi

    /** Runner has no machine RPC (`rpc_target_missing`) — hide the picker. */
    data object Unsupported : CodexModelsUi
    data class Failed(val message: String) : CodexModelsUi
}

sealed interface AgentAvailabilityUi {
    data object Loading : AgentAvailabilityUi
    data class Loaded(val agents: List<AgentAvailabilityEntry>) : AgentAvailabilityUi
    data class Failed(val message: String, val upgradeRequired: Boolean = false) : AgentAvailabilityUi
}

data class NewSessionUiState(
    val form: NewSessionForm,
    val machines: List<MachineOptionUi>,
    val machinesLoading: Boolean,
    /** `runnerState.lastSpawnError` of the selected machine, formatted. */
    val runnerSpawnError: String?,
    val suggestions: List<String>,
    val recentPaths: List<String>,
    val directoryStatus: DirectoryStatusUi?,
    /** Creatable flavors (value = flavor id, label from the catalog). */
    val agents: List<OptionItem>,
    val agentAvailabilityLoading: Boolean,
    val agentAvailabilityError: String?,
    /** Null hides the model picker (v1: only claude + supported codex). */
    val modelOptions: List<OptionItem>?,
    val modelsLoading: Boolean,
    val modelsError: String?,
    /** Claude launch-effort options; null hides the field. */
    val effortOptions: List<OptionItem>?,
    /** Codex reasoning-effort options; null hides the field. */
    val reasoningEffortOptions: List<OptionItem>?,
    val permission: PermissionUi,
    val showCollaborationMode: Boolean,
    val collaborationModeOptions: List<OptionItem>,
    val showFastMode: Boolean,
    val showCopilotAgentMode: Boolean,
    val copilotAgentModeOptions: List<OptionItem>,
    val worktreeNameError: String?,
    val isSpawning: Boolean,
    val spawnError: String?,
    val canCreate: Boolean,
    /** Armed after the first Create tap on a missing simple directory. */
    val confirmCreateDirectory: Boolean,
)

/**
 * New-session state machine (B-M3d): machine → directory → agent/options →
 * spawn. Plain constructor over fake-able seams ([NewSessionGateway],
 * [MachineListStore], [NewSessionPrefs]) so JVM tests drive the whole flow.
 * Web reference: `web/src/components/NewSession/index.tsx`.
 *
 * v1 notes (deliberate cuts, mirrored in the option matrix):
 * - model pickers: claude (static presets) + codex (machine catalog; hidden
 *   when the runner lacks the RPC). agy/opencode/grok/copilot/cursor/pi model
 *   discovery is TODO — spawn omits `model` so the agent default applies.
 * - effort: claude static levels; codex reasoning effort from the catalog.
 *   grok/pi effort ships with their model discovery.
 * - grok's `auto` availability probe (directory-scoped grok-models) is
 *   deferred; all catalog modes are offered.
 * - `startingMode` stays unset → the runner spawns `'remote'` (pty deferred).
 */
class NewSessionViewModel(
    private val gateway: NewSessionGateway,
    private val machineStore: MachineListStore,
    private val prefs: NewSessionPrefs,
    private val scope: CoroutineScope,
    initialMachineId: String? = null,
    private val debounceMs: Long = 250L,
    private val strings: NewSessionStrings = NewSessionStrings(),
) {
    private val form = MutableStateFlow(NewSessionForm())
    private val prefsData = MutableStateFlow(NewSessionPrefsData())
    private val codexModels = MutableStateFlow<CodexModelsUi>(CodexModelsUi.Hidden)
    private val agentAvailability = MutableStateFlow<AgentAvailabilityUi>(AgentAvailabilityUi.Loading)
    private val suggestions = MutableStateFlow<List<String>>(emptyList())
    private val pathExistence = MutableStateFlow<Map<String, Boolean>>(emptyMap())
    private val outsideWorkspaceRoots = MutableStateFlow<Set<String>>(emptySet())
    private val directoryLookupError = MutableStateFlow<String?>(null)
    private val isSpawning = MutableStateFlow(false)
    private val spawnError = MutableStateFlow<String?>(null)
    private val confirmCreateDirectory = MutableStateFlow(false)
    private val machinesRefreshSettled = MutableStateFlow(false)

    private val _spawned = MutableSharedFlow<String>(extraBufferCapacity = 1)

    /** Emits the new session id once — navigate-replace to `chat/{id}`. */
    val spawned: SharedFlow<String> = _spawned.asSharedFlow()
    val directoryBrowser = RemoteDirectoryBrowserController(
        scope = scope,
        listDirectory = gateway::listDirectory,
        fallbackError = strings.directoryLookupFailed,
    )

    private var directoryJob: Job? = null
    private var codexJob: Job? = null
    private var availabilityJob: Job? = null
    private var defaultDirectoryJob: Job? = null
    private var codexFetchedForMachine: String? = null
    private var suppressSuggestions = false
    private var spawnInFlight = false
    private var directoryRequestVersion = 0L

    /** Parent-listing cache: retyping within the same parent re-filters locally. */
    private var cachedListing: Pair<Pair<String, String>, List<MachineDirectoryEntry>>? = null

    init {
        scope.launch {
            prefsData.value = runCatching { prefs.readPrefs() }.getOrDefault(NewSessionPrefsData())
            val draft = runCatching { prefs.readDraft() }.getOrNull()?.let(NewSessionLogic::sanitizeDraft)
            var initial = draft ?: NewSessionForm()
            if (initialMachineId != null) {
                if (draft?.machineId != null && draft.machineId != initialMachineId) {
                    // Draft belongs to another machine (web `newSessionDraftMatchesMachine`).
                    initial = NewSessionForm(machineId = initialMachineId)
                    runCatching { prefs.clearDraft() }
                } else {
                    initial = initial.copy(machineId = initialMachineId)
                }
            }
            form.value = initial
            refreshAgentAvailability()
            refreshCodexModelsIfNeeded()
            // A restored directory should probe existence but not pop the
            // autocomplete dropdown — suggestions belong to typing.
            suppressSuggestions = true
            scheduleDirectoryWork()

            // Draft persistence: every later edit lands in DataStore so
            // backing out never loses input (web `newSessionFormDraft.ts`).
            launch {
                form.drop(1).collectLatest { current ->
                    runCatching { prefs.writeDraft(current) }
                }
            }

            // Machine preselect once the (snapshot or fetched) roster is in:
            // keep a still-online selection; otherwise last-used, else first.
            launch {
                machineStore.machines.collect { machines ->
                    if (machines.isEmpty()) return@collect
                    val current = form.value.machineId
                    if (current != null && machines.any { it.id == current }) {
                        if (form.value.directory.isBlank()) applyMachineSelection(current, resetDirectory = true)
                        return@collect
                    }
                    val lastUsed = prefsData.value.lastMachineId
                    val target = machines.firstOrNull { it.id == lastUsed } ?: machines.first()
                    applyMachineSelection(target.id, resetDirectory = form.value.directory.isBlank())
                }
            }
        }
        scope.launch {
            try {
                machineStore.refresh()
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (_: Exception) {
                // Snapshot (if any) keeps serving; the picker shows what it has.
            } finally {
                machinesRefreshSettled.value = true
            }
        }
    }

    // -------------------------------------------------------------- state --

    val uiState: StateFlow<NewSessionUiState> = combine(
        form,
        machineStore.machines,
        combine(codexModels, agentAvailability) { codex, availability -> CatalogState(codex, availability) },
        combine(suggestions, pathExistence, prefsData, outsideWorkspaceRoots, directoryLookupError) {
                s, exists, stored, outside, lookupError ->
            DirectoryData(s, exists, stored, outside, lookupError)
        },
        combine(isSpawning, spawnError, confirmCreateDirectory, machinesRefreshSettled) {
            spawning, error, confirmed, settled ->
            SpawnFlags(spawning, error, confirmed, settled)
        },
    ) { currentForm, machines, catalogs, directoryData, flags ->
        buildUiState(currentForm, machines, catalogs, directoryData, flags)
    }.stateIn(
        scope = scope,
        started = SharingStarted.Eagerly,
        initialValue = buildUiState(
            form.value,
            machineStore.machines.value,
            CatalogState(codexModels.value, agentAvailability.value),
            DirectoryData(emptyList(), emptyMap(), prefsData.value, emptySet(), null),
            SpawnFlags(isSpawning = false, spawnError = null, confirmed = false, machinesSettled = false),
        ),
    )

    private data class SpawnFlags(
        val isSpawning: Boolean,
        val spawnError: String?,
        val confirmed: Boolean,
        val machinesSettled: Boolean,
    )

    private data class CatalogState(
        val codex: CodexModelsUi,
        val availability: AgentAvailabilityUi,
    )

    private data class DirectoryData(
        val suggestions: List<String>,
        val exists: Map<String, Boolean>,
        val stored: NewSessionPrefsData,
        val outsideWorkspaceRoots: Set<String>,
        val lookupError: String?,
    )

    // ------------------------------------------------------------ actions --

    fun setMachine(machineId: String) {
        if (machineId == form.value.machineId) return
        applyMachineSelection(machineId, resetDirectory = true)
    }

    fun setDirectory(value: String) {
        suppressSuggestions = false
        confirmCreateDirectory.value = false
        form.update { it.copy(directory = value) }
        scheduleDirectoryWork()
    }

    fun pickSuggestion(path: String) = pickPath(path)

    fun pickRecentPath(path: String) = pickPath(path)

    fun openDirectoryBrowser() {
        val machine = machineStore.machines.value.firstOrNull { it.id == form.value.machineId } ?: return
        directoryBrowser.open(
            machineId = machine.id,
            roots = RemoteDirectoryPath.browseRoots(machine),
            initialPath = form.value.trimmedDirectory,
        )
    }

    fun selectBrowsedDirectory(path: String) {
        if (path.isNotBlank()) pickPath(path)
        directoryBrowser.close()
    }

    fun setAgent(agent: String) {
        if (agent == form.value.agent) return
        // Web parity: switching agents resets every agent-dependent field
        // (yolo is a cross-flavor preference and survives).
        form.update {
            it.copy(
                agent = agent,
                model = "auto",
                effort = "auto",
                modelReasoningEffort = "default",
                permissionMode = "default",
                serviceTier = "standard",
                collaborationMode = "default",
                copilotAgentMode = "interactive",
            )
        }
        refreshCodexModelsIfNeeded()
    }

    fun setModel(model: String) {
        form.update { current ->
            val next = current.copy(model = model)
            if (current.agent == "codex") reconcileCodexSelections(next) else next
        }
    }

    fun setEffort(effort: String) = form.update { it.copy(effort = effort) }

    fun setModelReasoningEffort(value: String) = form.update { it.copy(modelReasoningEffort = value) }

    fun setPermissionMode(mode: String) = form.update { it.copy(permissionMode = mode) }

    fun setYolo(enabled: Boolean) = form.update { it.copy(yolo = enabled) }

    fun setSessionType(sessionType: String) {
        confirmCreateDirectory.value = false
        form.update { it.copy(sessionType = sessionType) }
    }

    fun setWorktreeName(name: String) = form.update { it.copy(worktreeName = name) }

    fun setServiceTier(tier: String) = form.update { it.copy(serviceTier = tier) }

    fun setCollaborationMode(mode: String) = form.update { it.copy(collaborationMode = mode) }

    fun setCopilotAgentMode(mode: String) = form.update { it.copy(copilotAgentMode = mode) }

    fun retryCodexModels() {
        codexFetchedForMachine = null
        refreshCodexModelsIfNeeded()
    }

    fun retryAgentAvailability() = refreshAgentAvailability(force = true)

    /**
     * Spawn. Directory existence is re-checked server-side first (web
     * `handleCreate`): a missing worktree base is an error; a missing simple
     * directory arms a second-tap confirmation, after which the hub creates
     * it. Success emits [spawned]; failure lands in the inline error.
     */
    fun create() {
        val current = form.value
        val machineId = current.machineId ?: return
        if (current.trimmedDirectory.isEmpty() || spawnInFlight) return
        if (worktreeNameBlocks(current)) return
        when (val availability = agentAvailability.value) {
            AgentAvailabilityUi.Loading -> return
            is AgentAvailabilityUi.Failed -> {
                spawnError.value = availability.message
                return
            }
            is AgentAvailabilityUi.Loaded -> {
                if (availability.agents.none {
                    it.agent == current.agent && it.available
                }) {
                    spawnError.value = strings.selectedAgentUnavailable
                    return
                }
            }
        }
        spawnInFlight = true
        isSpawning.value = true
        spawnError.value = null
        scope.launch {
            try {
                val directory = current.trimmedDirectory
                val pathResult = gateway.pathsExist(machineId, listOf(directory))
                val exists = pathResult.exists[directory]
                outsideWorkspaceRoots.update { currentOutside ->
                    (currentOutside - directory) + pathResult.outsideWorkspaceRoots.orEmpty()
                }
                if (exists != null) {
                    pathExistence.update { it + (directory to exists) }
                }
                if (directory in pathResult.outsideWorkspaceRoots.orEmpty()) {
                    spawnError.value = strings.directoryOutsideWorkspaceRoots
                    return@launch
                }
                if (current.sessionType == SESSION_TYPE_WORKTREE && exists == false) {
                    spawnError.value = strings.worktreeMissing
                    return@launch
                }
                if (current.sessionType == SESSION_TYPE_SIMPLE && exists == false && !confirmCreateDirectory.value) {
                    confirmCreateDirectory.value = true
                    return@launch
                }

                val request = buildSpawnRequest(current, codexFastTierVisible(current))
                val result = gateway.spawn(machineId, request)
                if (result.type == "success" && result.sessionId != null) {
                    persistOnSuccess(machineId, directory)
                    _spawned.tryEmit(result.sessionId!!)
                } else {
                    spawnError.value = when (result.code) {
                        "runner_upgrade_required" -> strings.runnerUpgradeRequired
                        "agent_unavailable" -> strings.selectedAgentUnavailable
                        "outside_workspace_roots" -> strings.directoryOutsideWorkspaceRoots
                        else -> result.message ?: strings.createFailed
                    }
                }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: ApiError) {
                spawnError.value = when (error.code) {
                    "runner_upgrade_required" -> strings.runnerUpgradeRequired
                    "agent_unavailable" -> strings.selectedAgentUnavailable
                    "outside_workspace_roots" -> strings.directoryOutsideWorkspaceRoots
                    else -> error.message ?: strings.createFailed
                }
            } catch (error: Exception) {
                spawnError.value = error.message ?: strings.createFailed
            } finally {
                spawnInFlight = false
                isSpawning.value = false
            }
        }
    }

    // ---------------------------------------------------------- internals --

    private fun pickPath(path: String) {
        suppressSuggestions = true
        confirmCreateDirectory.value = false
        suggestions.value = emptyList()
        form.update { it.copy(directory = path) }
        scheduleDirectoryWork()
    }

    private fun recentPathsFor(machineId: String?): List<String> =
        machineId?.let { prefsData.value.recentPaths[it] }.orEmpty()

    private fun resolveDefaultDirectory(machineId: String, fallback: String) {
        defaultDirectoryJob?.cancel()
        val recent = recentPathsFor(machineId)
        if (recent.isEmpty()) return
        defaultDirectoryJob = scope.launch {
            val result = try {
                gateway.pathsExist(machineId, recent)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (_: Exception) {
                return@launch
            }
            val outside = result.outsideWorkspaceRoots.orEmpty().toSet()
            val valid = recent.firstOrNull { result.exists[it] == true && it !in outside } ?: return@launch
            if (form.value.machineId == machineId && form.value.directory == fallback) {
                suppressSuggestions = true
                form.update { it.copy(directory = valid) }
                scheduleDirectoryWork()
            }
        }
    }

    private fun applyMachineSelection(machineId: String, resetDirectory: Boolean) {
        directoryBrowser.close()
        pathExistence.value = emptyMap()
        outsideWorkspaceRoots.value = emptySet()
        directoryLookupError.value = null
        suggestions.value = emptyList()
        cachedListing = null
        confirmCreateDirectory.value = false
        // The seeded recent path is a pick, not typing — no dropdown.
        suppressSuggestions = true
        val machine = machineStore.machines.value.firstOrNull { it.id == machineId }
        val fallback = machine?.let(RemoteDirectoryPath::browseRoots)?.firstOrNull().orEmpty()
        form.update { current ->
            current.copy(
                machineId = machineId,
                model = "auto",
                directory = if (resetDirectory) {
                    fallback
                } else {
                    current.directory
                },
            )
        }
        if (resetDirectory) resolveDefaultDirectory(machineId, fallback)
        refreshAgentAvailability(force = true)
        refreshCodexModelsIfNeeded()
        scheduleDirectoryWork()
    }

    /** Debounced directory work: parent listing for autocomplete + exists probe. */
    private fun scheduleDirectoryWork() {
        directoryJob?.cancel()
        val requestVersion = ++directoryRequestVersion
        val machineId = form.value.machineId
        if (machineId == null) {
            suggestions.value = emptyList()
            return
        }
        directoryJob = scope.launch {
            delay(debounceMs)
            if (directoryRequestVersion != requestVersion || form.value.machineId != machineId) return@launch
            val text = form.value.directory
            val trimmed = text.trim()

            val query = if (suppressSuggestions) null else parentQuery(text)
            if (query == null) {
                suggestions.value = emptyList()
                directoryLookupError.value = null
            } else {
                val cacheKey = machineId to query.parent
                val cached = cachedListing?.takeIf { it.first == cacheKey }?.second
                val response = if (cached == null) try {
                    gateway.listDirectory(machineId, query.parent)
                } catch (cancellation: CancellationException) {
                    throw cancellation
                } catch (error: Exception) {
                    if (directoryRequestVersion == requestVersion && form.value.machineId == machineId) {
                        directoryLookupError.value = error.message ?: strings.directoryLookupFailed
                    }
                    null
                } else {
                    null
                }
                if (directoryRequestVersion != requestVersion || form.value.machineId != machineId) return@launch
                val entries = when {
                    cached != null -> cached
                    response?.success == true -> response.entries.orEmpty().also {
                        cachedListing = cacheKey to it
                        directoryLookupError.value = null
                    }
                    response != null -> emptyList<MachineDirectoryEntry>().also {
                        directoryLookupError.value = response.error ?: strings.directoryLookupFailed
                    }
                    else -> emptyList()
                }
                // Never suggest the path already typed verbatim.
                suggestions.value = NewSessionLogic.buildSuggestions(query, entries)
                    .filter { it != trimmed }
            }

            if (trimmed.isNotEmpty()) {
                val result = try {
                    gateway.pathsExist(machineId, listOf(trimmed))
                } catch (cancellation: CancellationException) {
                    throw cancellation
                } catch (_: Exception) {
                    null
                }
                if (result != null && directoryRequestVersion == requestVersion && form.value.machineId == machineId) {
                    pathExistence.update { it + result.exists }
                    outsideWorkspaceRoots.update { currentOutside ->
                        (currentOutside - trimmed) + result.outsideWorkspaceRoots.orEmpty()
                    }
                }
            }
        }
    }

    private fun refreshAgentAvailability(force: Boolean = false) {
        val machineId = form.value.machineId
        if (machineId == null) {
            availabilityJob?.cancel()
            agentAvailability.value = AgentAvailabilityUi.Loading
            return
        }
        if (!force && availabilityJob?.isActive == true) return
        availabilityJob?.cancel()
        agentAvailability.value = AgentAvailabilityUi.Loading
        availabilityJob = scope.launch {
            val state = try {
                AgentAvailabilityUi.Loaded(gateway.agentAvailability(machineId).agents)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: ApiError) {
                if (error.code == "runner_upgrade_required") {
                    AgentAvailabilityUi.Failed(strings.runnerUpgradeRequired, upgradeRequired = true)
                } else {
                    AgentAvailabilityUi.Failed(error.message ?: strings.agentAvailabilityFailed)
                }
            } catch (error: Exception) {
                AgentAvailabilityUi.Failed(error.message ?: strings.agentAvailabilityFailed)
            }
            if (form.value.machineId != machineId) return@launch
            agentAvailability.value = state
            val available = (state as? AgentAvailabilityUi.Loaded)
                ?.agents
                ?.filter { it.available && AgentFlavor.CREATABLE.any { flavor -> flavor.id == it.agent } }
                ?.map { it.agent }
                .orEmpty()
            if (available.isNotEmpty() && form.value.agent !in available) {
                setAgent(available.first())
            }
        }
    }

    private fun refreshCodexModelsIfNeeded() {
        val current = form.value
        if (current.agent != "codex") {
            codexJob?.cancel()
            codexFetchedForMachine = null
            codexModels.value = CodexModelsUi.Hidden
            return
        }
        val machineId = current.machineId
        if (machineId == null) {
            codexModels.value = CodexModelsUi.Hidden
            return
        }
        if (codexFetchedForMachine == machineId && codexModels.value !is CodexModelsUi.Hidden) return
        codexFetchedForMachine = machineId
        codexJob?.cancel()
        codexModels.value = CodexModelsUi.Loading
        codexJob = scope.launch {
            val state = try {
                val response = gateway.codexModels(machineId)
                if (response.success) {
                    CodexModelsUi.Loaded(response.models.orEmpty())
                } else {
                    CodexModelsUi.Failed(response.error ?: strings.codexModelsFailed)
                }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: ApiError) {
                if (error.code == "rpc_target_missing") {
                    CodexModelsUi.Unsupported
                } else {
                    CodexModelsUi.Failed(error.message ?: strings.codexModelsFailed)
                }
            } catch (error: Exception) {
                CodexModelsUi.Failed(error.message ?: strings.codexModelsFailed)
            }
            codexModels.value = state
            if (state is CodexModelsUi.Loaded) {
                // Reconcile restored selections with the live catalog (web
                // validation effects): unknown model → auto; unsupported
                // effort → default; no fast tier → standard.
                form.update { reconcileCodexSelections(it) }
            }
        }
    }

    private fun reconcileCodexSelections(current: NewSessionForm): NewSessionForm {
        val loaded = codexModels.value as? CodexModelsUi.Loaded ?: return current
        var next = current
        if (next.model != "auto" && loaded.models.none { it.id == next.model }) {
            next = next.copy(model = "auto")
        }
        val supported = NewSessionLogic.codexReasoningEfforts(loaded.models, next.model)
        if (next.modelReasoningEffort != "default" && supported != null && next.modelReasoningEffort !in supported) {
            next = next.copy(modelReasoningEffort = "default")
        }
        if (!NewSessionLogic.codexModelAdvertisesFastTier(next.model, loaded.models) && next.serviceTier != "standard") {
            next = next.copy(serviceTier = "standard")
        }
        return next
    }

    private fun codexFastTierVisible(current: NewSessionForm): Boolean {
        if (current.agent != "codex") return false
        val loaded = codexModels.value as? CodexModelsUi.Loaded ?: return false
        return NewSessionLogic.codexModelAdvertisesFastTier(current.model, loaded.models)
    }

    private fun worktreeNameBlocks(current: NewSessionForm): Boolean =
        current.sessionType == SESSION_TYPE_WORKTREE && worktreeNameError(current.worktreeName) != null

    private suspend fun persistOnSuccess(machineId: String, directory: String) {
        val updated = prefsData.value.let { stored ->
            stored.copy(
                lastMachineId = machineId,
                recentPaths = stored.recentPaths + (machineId to pushRecent(stored.recentPaths[machineId].orEmpty(), directory)),
            )
        }
        prefsData.value = updated
        runCatching { prefs.writePrefs(updated) }
        runCatching { prefs.clearDraft() }
    }

    // ------------------------------------------------------------ mapping --

    private fun buildUiState(
        currentForm: NewSessionForm,
        machines: List<Machine>,
        catalogs: CatalogState,
        directoryData: DirectoryData,
        flags: SpawnFlags,
    ): NewSessionUiState {
        val codex = catalogs.codex
        val availability = catalogs.availability
        val currentSuggestions = directoryData.suggestions
        val exists = directoryData.exists
        val stored = directoryData.stored
        val agent = currentForm.agent
        val selectedMachine = machines.firstOrNull { it.id == currentForm.machineId }
        val trimmed = currentForm.trimmedDirectory
        val directoryExists = if (trimmed.isEmpty()) null else exists[trimmed]
        val directoryOutsideRoots = trimmed in directoryData.outsideWorkspaceRoots

        val missingWorktreeDirectory =
            !directoryOutsideRoots && currentForm.sessionType == SESSION_TYPE_WORKTREE && trimmed.isNotEmpty() && directoryExists == false
        val needsCreationWarning =
            !directoryOutsideRoots && currentForm.sessionType == SESSION_TYPE_SIMPLE && trimmed.isNotEmpty() && directoryExists == false
        val directoryStatus = when {
            directoryOutsideRoots -> DirectoryStatusUi(strings.directoryOutsideWorkspaceRoots, isError = true)
            missingWorktreeDirectory -> DirectoryStatusUi(strings.worktreeMissing, isError = true)
            needsCreationWarning -> DirectoryStatusUi(
                if (flags.confirmed) strings.directoryMissingConfirm else strings.directoryMissing,
                isError = false,
            )
            directoryData.lookupError != null -> DirectoryStatusUi(directoryData.lookupError, isError = true)
            else -> null
        }

        val availableAgentIds = (availability as? AgentAvailabilityUi.Loaded)
            ?.agents
            ?.filter { entry -> entry.available && AgentFlavor.CREATABLE.any { it.id == entry.agent } }
            ?.map { it.agent }
            .orEmpty()
        val availabilityError = when (availability) {
            AgentAvailabilityUi.Loading -> null
            is AgentAvailabilityUi.Failed -> availability.message
            is AgentAvailabilityUi.Loaded -> if (availableAgentIds.isEmpty()) strings.noAvailableAgents else null
        }

        val modelOptions: List<OptionItem>? = when {
            agent == "claude" -> NewSessionCatalogs.CLAUDE_MODELS
            agent == "codex" && codex is CodexModelsUi.Loaded -> {
                listOf(OptionItem("auto", "Default")) + codex.models.map { OptionItem(it.id, it.displayName) }
            }
            agent == "codex" && (codex is CodexModelsUi.Loading || codex is CodexModelsUi.Failed) ->
                listOf(OptionItem("auto", "Default"))
            // codex Unsupported (old runner) and every other flavor: hidden.
            else -> null
        }

        val reasoningEffortOptions: List<OptionItem>? = if (agent == "codex" && codex !is CodexModelsUi.Unsupported) {
            val advertised = (codex as? CodexModelsUi.Loaded)
                ?.let { NewSessionLogic.codexReasoningEfforts(it.models, currentForm.model) }
            advertised?.let { efforts ->
                listOf(OptionItem("default", "Default")) +
                    efforts.map { OptionItem(it, NewSessionCatalogs.effortLabel(it)) }
            } ?: NewSessionCatalogs.CODEX_REASONING_EFFORTS
        } else {
            null
        }

        val permission: PermissionUi = when {
            agent == "pi" || agent == "dsh" -> PermissionUi.Managed
            usesNativePermissionSelect(agent) -> PermissionUi.NativeSelect(
                PermissionModes.forFlavor(agent).map { OptionItem(it.wireId, it.label) },
            )
            else -> PermissionUi.YoloToggle(hapiYoloNativeMode(agent)?.label)
        }

        val showFastMode = agent == "codex" && codex is CodexModelsUi.Loaded &&
            NewSessionLogic.codexModelAdvertisesFastTier(currentForm.model, codex.models)

        // Web `isLaunchPreferenceValidationPending` (codex slice): a restored
        // codex model/effort must not spawn before the catalog validated it.
        val codexValidationPending = agent == "codex" && codex is CodexModelsUi.Loading &&
            (currentForm.model != "auto" || currentForm.modelReasoningEffort != "default" || currentForm.serviceTier == "fast")

        val nameError = if (currentForm.sessionType == SESSION_TYPE_WORKTREE) {
            worktreeNameError(currentForm.worktreeName)?.let { strings.worktreeNameInvalid }
        } else {
            null
        }

        return NewSessionUiState(
            form = currentForm,
            machines = machines.map { machineOption(it) },
            machinesLoading = machines.isEmpty() && !flags.machinesSettled,
            runnerSpawnError = formatRunnerSpawnError(selectedMachine),
            suggestions = currentSuggestions,
            recentPaths = currentForm.machineId?.let { stored.recentPaths[it] }.orEmpty(),
            directoryStatus = directoryStatus,
            agents = availableAgentIds.map { OptionItem(it, Flavors.label(it)) },
            agentAvailabilityLoading = availability is AgentAvailabilityUi.Loading,
            agentAvailabilityError = availabilityError,
            modelOptions = modelOptions,
            modelsLoading = agent == "codex" && codex is CodexModelsUi.Loading,
            modelsError = (codex as? CodexModelsUi.Failed)?.message?.let { strings.modelsFailedDetail.format(it) },
            effortOptions = if (agent == "claude") NewSessionCatalogs.CLAUDE_EFFORTS else null,
            reasoningEffortOptions = reasoningEffortOptions,
            permission = permission,
            showCollaborationMode = agent == "codex",
            collaborationModeOptions = CodexCollaborationMode.entries.map { OptionItem(it.wireId, it.label) },
            showFastMode = showFastMode,
            showCopilotAgentMode = agent == "copilot",
            copilotAgentModeOptions = CopilotAgentMode.entries.map { OptionItem(it.wireId, it.label) },
            worktreeNameError = nameError,
            isSpawning = flags.isSpawning,
            spawnError = flags.spawnError,
            canCreate = currentForm.machineId != null &&
                trimmed.isNotEmpty() &&
                !flags.isSpawning &&
                !missingWorktreeDirectory &&
                !directoryOutsideRoots &&
                availability is AgentAvailabilityUi.Loaded &&
                currentForm.agent in availableAgentIds &&
                nameError == null &&
                !codexValidationPending,
            confirmCreateDirectory = flags.confirmed && needsCreationWarning,
        )
    }

    companion object {
        const val MSG_WORKTREE_MISSING = "Worktree sessions require an existing repository directory."
        const val MSG_DIRECTORY_MISSING = "Directory does not exist. Creating the session will create it automatically."
        const val MSG_DIRECTORY_MISSING_CONFIRM = "Directory does not exist. Tap Create again to create it automatically."

        /** `resolveHapiYoloPermissionMode` (`shared/src/agentConfig.ts`). */
        fun hapiYoloNativeMode(flavor: String?): PermissionMode? = when (flavor) {
            "claude", "grok" -> PermissionMode.BypassPermissions
            "agy" -> PermissionMode.AlwaysProceed
            "codex", "copilot", "cursor", "gemini", "kimi", "opencode" -> PermissionMode.Yolo
            else -> null
        }

        /** `getMachineOptionLabel` (web `MachineSelector`), minus capability-skew (TODO). */
        fun machineOption(machine: Machine): MachineOptionUi {
            val metadata = machine.metadata
            val title = metadata?.displayName?.takeIf { it.isNotBlank() }
                ?: metadata?.host
                ?: machine.id.take(8)
            val platform = metadata?.platform?.let { " ($it)" }.orEmpty()
            val version = metadata?.happyCliVersion?.let { " · CLI $it" }.orEmpty()
            val health = machine.health?.let { health ->
                listOfNotNull(
                    health.cpuPercent?.let { "CPU ${it.toInt()}%" },
                    health.memoryPercent?.let { "Mem ${it.toInt()}%" },
                ).joinToString(" · ").ifEmpty { null }
            }
            return MachineOptionUi(id = machine.id, label = "$title$platform$version", healthLabel = health)
        }

        /** `formatRunnerSpawnError` (`web/src/utils/formatRunnerSpawnError.ts`). */
        fun formatRunnerSpawnError(machine: Machine?): String? {
            val lastSpawnError = machine?.runnerState?.lastSpawnError.objOrNull ?: return null
            val message = lastSpawnError["message"].stringOrNull?.takeIf { it.isNotEmpty() } ?: return null
            val at = lastSpawnError["at"].longOrNull
            return if (at != null) {
                "$message (${DateFormat.getDateTimeInstance().format(Date(at))})"
            } else {
                message
            }
        }
    }
}

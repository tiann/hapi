package app.hapi.companion.feature.newsession

import app.hapi.companion.feature.directorybrowser.RemoteDirectoryBrowserController
import app.hapi.companion.feature.directorybrowser.RemoteDirectoryPath
import app.hapi.companion.feature.newsession.NewSessionLogic.buildSpawnRequest
import app.hapi.companion.feature.newsession.NewSessionLogic.launchPreferenceFrom
import app.hapi.companion.feature.newsession.NewSessionLogic.parentQuery
import app.hapi.companion.feature.newsession.NewSessionLogic.pushRecent
import app.hapi.companion.feature.newsession.NewSessionLogic.resolvePreferredLaunchSettings
import app.hapi.companion.feature.newsession.NewSessionLogic.usesNativePermissionSelect
import app.hapi.companion.feature.newsession.NewSessionLogic.usesSharedPermissionModeState
import app.hapi.companion.feature.newsession.NewSessionLogic.worktreeNameError
import app.hapi.data.api.ApiError
import app.hapi.data.store.MachineListStore
import app.hapi.protocol.catalog.AgentFlavor
import app.hapi.protocol.catalog.CodexCollaborationMode
import app.hapi.protocol.catalog.CopilotAgentMode
import app.hapi.protocol.catalog.Flavors
import app.hapi.protocol.catalog.PermissionMode
import app.hapi.protocol.catalog.PermissionModes
import app.hapi.protocol.wire.AgentAvailabilityEntry
import app.hapi.protocol.wire.AgyModelSummary
import app.hapi.protocol.wire.AgyModelsResponse
import app.hapi.protocol.wire.CodexModelSummary
import app.hapi.protocol.wire.CodexModelsResponse
import app.hapi.protocol.wire.CopilotModelSummary
import app.hapi.protocol.wire.CopilotModelsResponse
import app.hapi.protocol.wire.CursorModelsResponse
import app.hapi.protocol.wire.GrokModelSummary
import app.hapi.protocol.wire.GrokModelsResponse
import app.hapi.protocol.wire.KimiModelSummary
import app.hapi.protocol.wire.KimiModelsResponse
import app.hapi.protocol.wire.Machine
import app.hapi.protocol.wire.MachineDirectoryEntry
import app.hapi.protocol.wire.OpencodeModelSummary
import app.hapi.protocol.wire.OpencodeModelsResponse
import app.hapi.protocol.wire.OpencodeModelVariantsResponse
import app.hapi.protocol.wire.PiModelSummary
import app.hapi.protocol.wire.PiModelsResponse
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
    // Flavor model pickers (web `newSession.agyModel.*`, `newSession.model.*`,
    // `newSession.opencodeModel.*`, `newSession.grokAutoUnavailable*`).
    /** Agy synthetic row suffix for a selection the catalog no longer lists. */
    val agyNotListed: String = "no longer listed",
    /** Transport fallback when the server error string is empty (web hook fallbacks). */
    val agyLoadFailed: String = "Failed to load Agy models",
    val cursorLoadFailed: String = "Failed to load Cursor models",
    val opencodeLoadFailed: String = "Failed to load OpenCode models",
    val opencodeLoadFailedDetail: String = "Failed to load OpenCode models: %1\$s",
    /** `newSession.opencodeModel.default` — the ` (default)` row annotation. */
    val opencodeDefaultLabel: String = "Default",
    val grokLoadFailed: String = "Failed to load Grok models",
    val copilotLoadFailed: String = "Failed to load Copilot models",
    val kimiLoadFailed: String = "Failed to load Kimi models",
    val piLoadFailed: String = "Failed to load Pi models",
    /** Variant-picker placeholder + the create-time variant guard error. */
    val selectVariant: String = "Select variant",
    /** Grok `auto` permission row suffix when the account/CLI lacks Auto. */
    val grokAutoUnavailable: String = "unavailable",
    val grokAutoUnavailableDesc: String = "Grok did not enable Auto permissions for this account or CLI build.",
)

/** Which permission control the current flavor renders (web `PermissionField`). */
sealed interface PermissionUi {
    /**
     * Native permission-mode picker (claude, grok, codex-family —
     * [NewSessionLogic.usesNativePermissionSelect]). [disabledValues] marks
     * rows the machine proved unavailable (grok `auto` without Auto
     * permission support); [hint] renders below the dropdown (web
     * `newSession.grokAutoUnavailableDesc`).
     */
    data class NativeSelect(
        val options: List<OptionItem>,
        val disabledValues: Set<String> = emptySet(),
        val hint: String? = null,
    ) : PermissionUi

    /** HAPI YOLO toggle (agy/cursor) with the native mode it maps to. */
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

/**
 * Agy model-picker section (web `useAgyModels` + `AgyModelSelector`): the
 * flavor renders its own selector instead of the generic model dropdown.
 */
sealed interface AgyUi {
    data object Hidden : AgyUi
    data object Loading : AgyUi

    /** `success:false` or a transport failure — the auth-required wall. */
    data class Error(val message: String, val fetching: Boolean = false) : AgyUi
    data object NoModels : AgyUi

    /** Usable catalog; [warning] is the raw server text of a stale sign-in check. */
    data class Ready(
        val options: List<OptionItem>,
        val selected: String,
        val warning: String?,
        val fetching: Boolean,
    ) : AgyUi
}

/** OpenCode model-picker section (web `OpencodeModelSelector`, cwd-scoped). */
sealed interface OpencodeUi {
    data object Hidden : OpencodeUi
    data object Loading : OpencodeUi
    data class Error(val message: String) : OpencodeUi
    data object Empty : OpencodeUi
    data class Ready(val options: List<OptionItem>, val selected: String) : OpencodeUi
}

/**
 * Cursor model-picker section (web dual base/variant or flat wire pickers).
 * [variantOptions] already carries the leading "Select variant" placeholder;
 * [selectedModel] is the base value in dual mode, the wire id in flat mode.
 */
sealed interface CursorUi {
    data object Hidden : CursorUi
    data object Loading : CursorUi
    data class Error(val message: String) : CursorUi
    data class Ready(
        val mode: CursorModels.PickerMode,
        val modelOptions: List<OptionItem>,
        val selectedModel: String,
        val variantOptions: List<OptionItem>,
        val selectedVariant: String,
        val showVariantPicker: Boolean,
        /** Catalog loaded but no picker-eligible rows (start a session once). */
        val unavailable: Boolean,
    ) : CursorUi
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
    /** Dedicated agy/cursor/opencode picker sections (null-agent flavors hide). */
    val agy: AgyUi = AgyUi.Hidden,
    val opencode: OpencodeUi = OpencodeUi.Hidden,
    val cursor: CursorUi = CursorUi.Hidden,
)

/**
 * New-session state machine (B-M3d): machine → directory → agent/options →
 * spawn. Plain constructor over fake-able seams ([NewSessionGateway],
 * [MachineListStore], [NewSessionPrefs]) so JVM tests drive the whole flow.
 * Web reference: `web/src/components/NewSession/index.tsx`.
 *
 * Flavor model pickers (full parity): claude static presets; codex machine
 * catalog (hidden on runners without the RPC); agy/cursor machine catalogs
 * with dedicated selector sections; opencode/grok/copilot/kimi cwd-scoped
 * catalogs gated on positive directory existence; pi machine catalog. Each
 * catalog reconciles restored selections exactly like the web validation
 * effects, and `isLaunchPreferenceValidationPending` gates Create while a
 * restored selection awaits its catalog.
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

    /** Load state of one flavor catalog slot ([Load.Idle] = not applicable). */
    private sealed interface Load<out T> {
        data object Idle : Load<Nothing>
        data object Loading : Load<Nothing>
        data class Ready<T>(val value: T) : Load<T>
        data class Failed(val message: String) : Load<Nothing>
    }

    private data class AgyCatalog(
        val models: List<AgyModelSummary>,
        val currentModelId: String?,
        /** `success:true` with a non-null `error` — stale sign-in banner text. */
        val warning: String?,
    )

    private data class CursorCatalog(
        val models: List<OpencodeModelSummary>,
        val cliSkus: List<OpencodeModelSummary>,
    )

    private data class OpencodeModelsCatalog(
        val models: List<OpencodeModelSummary>,
        val currentModelId: String?,
    )

    private data class GrokCatalog(
        val models: List<GrokModelSummary>,
        val currentModelId: String?,
        val autoPermissionSupported: Boolean?,
    )

    private data class CopilotCatalog(val models: List<CopilotModelSummary>)
    private data class KimiCatalog(val models: List<KimiModelSummary>)
    private data class PiCatalog(val models: List<PiModelSummary>)

    /** All flavor catalog slots in one flow (one slice per fetch). */
    private data class FlavorCatalogs(
        val agy: Load<AgyCatalog> = Load.Idle,
        val cursor: Load<CursorCatalog> = Load.Idle,
        val opencodeModels: Load<OpencodeModelsCatalog> = Load.Idle,
        val opencodeVariants: Load<Map<String, List<String>>> = Load.Idle,
        val grok: Load<GrokCatalog> = Load.Idle,
        val copilot: Load<CopilotCatalog> = Load.Idle,
        val kimi: Load<KimiCatalog> = Load.Idle,
        val pi: Load<PiCatalog> = Load.Idle,
        /** An agy Retry probe is in flight over an already-loaded catalog. */
        val agyFetching: Boolean = false,
    )

    private val flavorCatalogs = MutableStateFlow(FlavorCatalogs())

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

    // Flavor catalog fetch bookkeeping: one job + dedupe key per slot (same
    // shape as codexFetchedForMachine — same key and a non-idle state skips).
    private var agyJob: Job? = null
    private var agyKey: String? = null
    private var cursorJob: Job? = null
    private var cursorKey: String? = null
    private var opencodeModelsJob: Job? = null
    private var opencodeModelsKey: String? = null
    private var opencodeVariantsJob: Job? = null
    private var opencodeVariantsKey: String? = null
    private var grokJob: Job? = null
    private var grokKey: String? = null
    private var copilotJob: Job? = null
    private var copilotKey: String? = null
    private var kimiJob: Job? = null
    private var kimiKey: String? = null
    private var piJob: Job? = null
    private var piKey: String? = null

    /**
     * Selection keys the web reset effects watch: agy = agent+machine,
     * opencode = agent+machine+directory. A key change resets the flavor's
     * selection state (web `preserveRestoredDraftRef` guards the first pass
     * after a draft restore).
     */
    private var agySelectionKey: String? = null
    private var opencodeSelectionKey: String? = null
    private var preserveRestoredDraft = false

    /** Web `agyModelPickedByUserRef` — a user pick survives a catalog swap. */
    private var agyModelPickedByUser = false

    /**
     * Web `opencodeSelectedModel` tri-state: `undefined` (probe again) maps to
     * `false`, `null` (explicit Default) + concrete ids map to `true`.
     */
    private var opencodeModelSettled = false

    /** Web `pendingCursorBaseRef` — base picked while the catalog was loading. */
    private var pendingCursorBase: String? = null

    private var suppressSuggestions = false
    private var spawnInFlight = false
    private var directoryRequestVersion = 0L

    /**
     * A restored draft outranks the remembered launch defaults until the
     * user switches agent or machine (web `preserveRestoredDraftRef`).
     */
    private var draftRestored = false

    /** Parent-listing cache: retyping within the same parent re-filters locally. */
    private var cachedListing: Pair<Pair<String, String>, List<MachineDirectoryEntry>>? = null

    init {
        scope.launch {
            prefsData.value = runCatching { prefs.readPrefs() }.getOrDefault(NewSessionPrefsData())
            val draft = runCatching { prefs.readDraft() }.getOrNull()?.let(NewSessionLogic::sanitizeDraft)
            var initial = draft ?: NewSessionForm()
            draftRestored = draft != null
            if (initialMachineId != null) {
                if (draft?.machineId != null && draft.machineId != initialMachineId) {
                    // Draft belongs to another machine (web `newSessionDraftMatchesMachine`).
                    initial = NewSessionForm(machineId = initialMachineId)
                    draftRestored = false
                    runCatching { prefs.clearDraft() }
                } else {
                    initial = initial.copy(machineId = initialMachineId)
                }
            }
            form.value = initial
            if (!draftRestored) applyPreferredLaunchSettings(initial.machineId, initial.agent)
            // Web `preserveRestoredDraftRef`: the first flavor pass after a
            // draft restore must not run the agent/machine/directory resets.
            preserveRestoredDraft = draft != null
            // A restored opencode draft is an explicit choice (web maps the
            // draft model to concrete-or-null, never `undefined`).
            if (draft?.agent == "opencode") opencodeModelSettled = true
            refreshAgentAvailability()
            refreshCodexModelsIfNeeded()
            refreshFlavorCatalogs()
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
                        if (form.value.directory.isBlank()) initializeMachineDirectory(current)
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
        combine(codexModels, agentAvailability, flavorCatalogs) { codex, availability, flavors ->
            CatalogState(codex, availability, flavors)
        },
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
            CatalogState(codexModels.value, agentAvailability.value, flavorCatalogs.value),
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
        val flavors: FlavorCatalogs = FlavorCatalogs(),
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
        draftRestored = false
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
        // A user (or availability-coerced) agent switch ends draft preservation
        // (web `handleAgentChange` clears `preserveRestoredDraftRef`).
        preserveRestoredDraft = false
        // Web parity: switching agents resets every agent-dependent field
        // (yolo is a cross-flavor preference and survives), then the
        // remembered launch defaults for the new (machine, agent) dimension
        // prefill the reset fields.
        draftRestored = false
        form.update {
            it.copy(
                agent = agent,
                model = "auto",
                cursorSelectedBase = "auto",
                effort = "auto",
                modelReasoningEffort = "default",
                permissionMode = "default",
                serviceTier = "standard",
                collaborationMode = "default",
                copilotAgentMode = "interactive",
            )
        }
        applyPreferredLaunchSettings(form.value.machineId, agent)
        pendingCursorBase = null
        refreshCodexModelsIfNeeded()
        refreshFlavorCatalogs()
    }

    fun setModel(model: String) {
        form.update { current ->
            val next = current.copy(model = model)
            if (current.agent == "codex") reconcileCodexSelections(next) else next
        }
        when (form.value.agent) {
            "agy" -> agyModelPickedByUser = model != "auto"
            "opencode" -> {
                // A dropdown pick is an explicit choice (web concrete/null, never undefined).
                opencodeModelSettled = true
                reconcileOpencodeEffort()
            }
            "grok" -> reconcileGrokSelections()
            "pi" -> reconcilePiSelections()
            "cursor" -> reconcileCursorSelections()
        }
    }

    fun setEffort(effort: String) = form.update { it.copy(effort = effort) }

    fun setModelReasoningEffort(value: String) = form.update { it.copy(modelReasoningEffort = value) }

    fun setPermissionMode(mode: String) {
        form.update { current ->
            // Grok `auto` is offered only while the machine supports it (web
            // permission reconcile effect applied at click time too).
            val effective = if (
                current.agent == "grok" &&
                mode == "auto" &&
                (flavorCatalogs.value.grok as? Load.Ready)?.value?.autoPermissionSupported == false
            ) {
                "default"
            } else {
                mode
            }
            current.copy(permissionMode = effective)
        }
    }

    /**
     * Cursor dual picker base row (web `handleCursorBaseChange`): Auto clears
     * the wire; a multi-variant base stays on Auto until a variant is picked,
     * deferred via [pendingCursorBase] while the catalog is still loading.
     */
    fun setCursorBase(baseKey: String) {
        if (baseKey == "auto") {
            pendingCursorBase = null
            form.update { it.copy(cursorSelectedBase = "auto", model = "auto") }
            return
        }
        val catalog = cursorCatalogOrNull()
        form.update { current ->
            current.copy(
                cursorSelectedBase = baseKey,
                model = if (catalog != null && catalog.variantsByBase.isNotEmpty()) {
                    CursorModels.resolveWireIdForBaseChange(baseKey, catalog) ?: "auto"
                } else {
                    current.model
                },
            )
        }
        if (catalog == null || catalog.variantsByBase.isEmpty()) {
            pendingCursorBase = baseKey
        } else {
            pendingCursorBase = null
        }
    }

    /** Cursor variant row (web `handleCursorEffortChange`) — the wire itself. */
    fun setCursorVariant(wireId: String) {
        val current = form.value
        if (current.agent != "cursor") return
        if (wireId == "auto") {
            form.update { it.copy(model = "auto") }
            return
        }
        val catalog = cursorCatalogOrNull() ?: return
        val baseKey = if (current.cursorSelectedBase != "auto") {
            current.cursorSelectedBase
        } else {
            CursorModels.resolveBaseKey(current.model, catalog)
        }
        if (baseKey != null && baseKey != "auto" &&
            !CursorModels.isEffortWireAllowed(wireId, catalog, baseKey)
        ) {
            return
        }
        form.update { it.copy(model = wireId) }
    }

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

    /** Agy Retry: spend the machine's catalog cache (`?refresh=true`). */
    fun retryAgyModels() {
        if (form.value.agent != "agy") return
        val machineId = form.value.machineId ?: return
        agyKey = null
        flavorCatalogs.update { it.copy(agyFetching = true) }
        refreshAgyModels(machineId, refresh = true)
    }

    /** OpenCode Retry (web `opencodeModelsState.refetch`). */
    fun retryOpencodeModels() {
        if (form.value.agent != "opencode") return
        val machineId = form.value.machineId ?: return
        val cwd = form.value.trimmedDirectory
        if (cwd.isEmpty()) return
        opencodeModelsKey = null
        refreshOpencodeModels(machineId, cwd)
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

                // Cursor dual picker: a multi-variant base needs an explicit
                // variant pick before spawning (web create-time guard). The
                // variant rows are the PICKED BASE's (a multi-variant base
                // keeps model at `auto` until the pick), not the model's.
                if (current.agent == "cursor") {
                    val ready = flavorCatalogs.value.cursor as? Load.Ready
                    if (ready != null) {
                        val picker = CursorModels.buildNewSessionPickerState(
                            ready.value.models,
                            current.model,
                            ready.value.cliSkus,
                        )
                        val baseValue = CursorModels.baseSelectValue(picker, current.cursorSelectedBase)
                        if (picker.mode == CursorModels.PickerMode.DUAL && baseValue != "auto") {
                            val variantBase = if (baseValue != "auto") baseValue else picker.baseKey
                            val variants = CursorModels.resolveVariantOptions(variantBase, picker.catalog)
                            if (variants.size > 1 && variants.none { it.wireId == current.model }) {
                                spawnError.value = strings.selectVariant
                                return@launch
                            }
                        }
                    }
                }

                val request = buildSpawnRequest(current, codexFastTierVisible(current))
                val result = gateway.spawn(machineId, request)
                if (result.type == "success" && result.sessionId != null) {
                    persistOnSuccess(machineId, directory, current)
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

    /**
     * Launch-preference restore (web restore effect on agent/machineId
     * change): refills the agent-dependent defaults from the remembered
     * `(machine, agent)` entry — or the sentinels when nothing is stored.
     * The codex model/effort are validated again once the live catalog
     * settles ([reconcileCodexSelections]); grok keeps its form field out of
     * the remembered settings entirely.
     */
    private fun applyPreferredLaunchSettings(machineId: String?, agent: String) {
        if (machineId == null) return
        val resolved = resolvePreferredLaunchSettings(
            agent,
            prefsData.value.launchSettings[machineId]?.get(agent),
        )
        form.update { current ->
            current.copy(
                model = resolved.model,
                effort = resolved.effort,
                modelReasoningEffort = resolved.modelReasoningEffort,
                permissionMode = if (usesSharedPermissionModeState(agent)) {
                    resolved.permissionMode ?: "default"
                } else {
                    current.permissionMode
                },
            )
        }
    }

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
        form.update { current ->
            current.copy(
                machineId = machineId,
                model = "auto",
                cursorSelectedBase = "auto",
            )
        }
        pendingCursorBase = null
        preserveRestoredDraft = false
        // Remembered launch defaults follow the machine dimension too (web
        // restore effect re-runs on machineId change) — unless a restored
        // draft still owns the form.
        if (!draftRestored) applyPreferredLaunchSettings(machineId, form.value.agent)
        refreshAgentAvailability(force = true)
        refreshCodexModelsIfNeeded()
        refreshFlavorCatalogs()
        if (resetDirectory) initializeMachineDirectory(machineId) else scheduleDirectoryWork()
    }

    /** Roster updates may seed a directory without replacing current launch choices. */
    private fun initializeMachineDirectory(machineId: String) {
        val machine = machineStore.machines.value.firstOrNull { it.id == machineId }
        val fallback = machine?.let(RemoteDirectoryPath::browseRoots)?.firstOrNull().orEmpty()
        suppressSuggestions = true
        form.update { it.copy(directory = fallback) }
        resolveDefaultDirectory(machineId, fallback)
        scheduleDirectoryWork()
    }

    /** Debounced directory work: parent listing for autocomplete + exists probe. */
    private fun scheduleDirectoryWork() {
        directoryJob?.cancel()
        val requestVersion = ++directoryRequestVersion
        // Re-evaluate the cwd-scoped flavor gates immediately (web deferred
        // value): a typed path loses its positive existence until re-probed.
        refreshFlavorCatalogs()
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
                    // Positive existence may open the cwd-scoped flavor gates.
                    refreshFlavorCatalogs()
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

    // ------------------------------------------------- flavor model catalogs --

    /** Reconcile view of the cursor catalog (form selection judged, not injected). */
    private fun cursorCatalogOrNull(): CursorModels.Catalog? =
        (flavorCatalogs.value.cursor as? Load.Ready)?.value
            ?.let { CursorModels.buildNewSessionCatalog(it.models, it.cliSkus) }

    /**
     * Fan out the per-flavor catalog fetches for the current form state — the
     * Android shape of the web query `enabled` gates: machine-scoped for
     * agy/cursor/pi; cwd-scoped with a *positive* existence gate for opencode
     * (models + variants)/grok/kimi; copilot checks existence only. Off-gate
     * slots return to [Load.Idle] (web: disabled query with no data).
     */
    private fun refreshFlavorCatalogs() {
        val current = form.value
        maybeResetFlavorSelections(current)
        val machineId = current.machineId
        val agent = current.agent

        if (agent == "agy" && machineId != null) {
            refreshAgyModels(machineId, refresh = false)
        } else {
            agyJob?.cancel()
            agyKey = null
            flavorCatalogs.update { it.copy(agy = Load.Idle, agyFetching = false) }
        }

        if (agent == "cursor" && machineId != null) {
            refreshCursorModels(machineId)
        } else {
            cursorJob?.cancel()
            cursorKey = null
            flavorCatalogs.update { it.copy(cursor = Load.Idle) }
        }

        val cwd = current.trimmedDirectory
        val cwdExists = pathExistence.value[cwd]
        val cwdGateOpen = cwd.isNotEmpty() && cwdExists == true
        if (agent == "opencode" && machineId != null && cwdGateOpen) {
            refreshOpencodeModels(machineId, cwd)
            refreshOpencodeVariants(machineId, cwd)
        } else {
            opencodeModelsJob?.cancel()
            opencodeModelsKey = null
            opencodeVariantsJob?.cancel()
            opencodeVariantsKey = null
            flavorCatalogs.update { it.copy(opencodeModels = Load.Idle, opencodeVariants = Load.Idle) }
        }

        if (agent == "grok" && machineId != null && cwdGateOpen) {
            refreshGrokModels(machineId, cwd)
        } else {
            grokJob?.cancel()
            grokKey = null
            flavorCatalogs.update { it.copy(grok = Load.Idle) }
        }

        if (agent == "copilot" && machineId != null && cwdExists == true) {
            refreshCopilotModels(machineId, cwd)
        } else {
            copilotJob?.cancel()
            copilotKey = null
            flavorCatalogs.update { it.copy(copilot = Load.Idle) }
        }

        if (agent == "kimi" && machineId != null && cwdGateOpen) {
            refreshKimiModels(machineId, cwd)
        } else {
            kimiJob?.cancel()
            kimiKey = null
            flavorCatalogs.update { it.copy(kimi = Load.Idle) }
        }

        if (agent == "pi" && machineId != null) {
            refreshPiModels(machineId)
        } else {
            piJob?.cancel()
            piKey = null
            flavorCatalogs.update { it.copy(pi = Load.Idle) }
        }
    }

    /**
     * Web reset effects on agent/machine/directory changes
     * (`preserveRestoredDraftRef` guards the first passes after a draft
     * restore until the user switches agent or machine):
     * - agy: picked flag + selection drop ([agent, machineId] deps);
     * - opencode: selection back to uninitialized ([agent, machineId, dir]).
     */
    private fun maybeResetFlavorSelections(current: NewSessionForm) {
        if (preserveRestoredDraft) return
        val agyKey = listOf(current.agent, current.machineId).joinToString("|")
        if (agySelectionKey != agyKey) {
            agySelectionKey = agyKey
            agyModelPickedByUser = false
            if (current.agent == "agy" && current.model != "auto") {
                form.update { it.copy(model = "auto") }
            }
        }
        val opencodeKey = listOf(current.agent, current.machineId, current.trimmedDirectory).joinToString("|")
        if (opencodeSelectionKey != opencodeKey) {
            opencodeSelectionKey = opencodeKey
            if (current.agent == "opencode") {
                opencodeModelSettled = false
                if (current.model != "auto") {
                    form.update { it.copy(model = "auto") }
                }
            }
        }
    }

    /**
     * `useAgyModels`: [refresh] spends the once-per-load cache skip (Retry);
     * a retry over a loaded catalog keeps the old rows while fetching.
     */
    private fun refreshAgyModels(machineId: String, refresh: Boolean) {
        if (!refresh && agyKey == machineId && flavorCatalogs.value.agy !is Load.Idle) return
        agyKey = machineId
        agyJob?.cancel()
        if (flavorCatalogs.value.agy !is Load.Ready) {
            flavorCatalogs.update { it.copy(agy = Load.Loading, agyFetching = false) }
        }
        agyJob = scope.launch {
            val state = try {
                val response = gateway.agyModels(machineId, refresh)
                if (response.success) {
                    Load.Ready(
                        AgyCatalog(
                            models = response.availableModels.orEmpty(),
                            currentModelId = response.currentModelId,
                            warning = response.error,
                        ),
                    )
                } else {
                    Load.Failed(response.error ?: strings.agyLoadFailed)
                }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                Load.Failed(error.message ?: strings.agyLoadFailed)
            }
            if (agyKey != machineId) return@launch
            flavorCatalogs.update { it.copy(agy = state, agyFetching = false) }
            if (state is Load.Ready) reconcileAgySelection(state.value)
        }
    }

    private fun refreshCursorModels(machineId: String) {
        if (cursorKey == machineId && flavorCatalogs.value.cursor !is Load.Idle) return
        cursorKey = machineId
        cursorJob?.cancel()
        flavorCatalogs.update { it.copy(cursor = Load.Loading) }
        cursorJob = scope.launch {
            val state = try {
                val response = gateway.cursorModels(machineId)
                if (response.success) {
                    Load.Ready(CursorCatalog(response.availableModels.orEmpty(), response.cliModelSkus.orEmpty()))
                } else {
                    Load.Failed(response.error ?: strings.cursorLoadFailed)
                }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                Load.Failed(error.message ?: strings.cursorLoadFailed)
            }
            if (cursorKey != machineId) return@launch
            flavorCatalogs.update { it.copy(cursor = state) }
            if (state is Load.Ready) reconcileCursorSelections()
        }
    }

    private fun refreshOpencodeModels(machineId: String, cwd: String) {
        val key = "$machineId|$cwd"
        if (opencodeModelsKey == key && flavorCatalogs.value.opencodeModels !is Load.Idle) return
        opencodeModelsKey = key
        opencodeModelsJob?.cancel()
        flavorCatalogs.update { it.copy(opencodeModels = Load.Loading) }
        opencodeModelsJob = scope.launch {
            val state = try {
                val response = gateway.opencodeModels(machineId, cwd)
                if (response.success) {
                    Load.Ready(
                        OpencodeModelsCatalog(
                            models = response.availableModels.orEmpty(),
                            currentModelId = response.currentModelId,
                        ),
                    )
                } else {
                    Load.Failed(response.error ?: strings.opencodeLoadFailed)
                }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                Load.Failed(error.message ?: strings.opencodeLoadFailed)
            }
            if (opencodeModelsKey != key) return@launch
            flavorCatalogs.update { it.copy(opencodeModels = state) }
            if (state is Load.Ready) {
                reconcileOpencodeSelection(state.value)
                reconcileOpencodeEffort()
            }
        }
    }

    private fun refreshOpencodeVariants(machineId: String, cwd: String) {
        val key = "$machineId|$cwd"
        if (opencodeVariantsKey == key && flavorCatalogs.value.opencodeVariants !is Load.Idle) return
        opencodeVariantsKey = key
        opencodeVariantsJob?.cancel()
        flavorCatalogs.update { it.copy(opencodeVariants = Load.Loading) }
        opencodeVariantsJob = scope.launch {
            val state = try {
                val response = gateway.opencodeModelVariants(machineId, cwd)
                if (response.success) {
                    Load.Ready(response.variants.orEmpty())
                } else {
                    Load.Failed(response.error ?: strings.opencodeLoadFailed)
                }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                Load.Failed(error.message ?: strings.opencodeLoadFailed)
            }
            if (opencodeVariantsKey != key) return@launch
            flavorCatalogs.update { it.copy(opencodeVariants = state) }
            if (state is Load.Ready) reconcileOpencodeEffort()
        }
    }

    private fun refreshGrokModels(machineId: String, cwd: String) {
        val key = "$machineId|$cwd"
        if (grokKey == key && flavorCatalogs.value.grok !is Load.Idle) return
        grokKey = key
        grokJob?.cancel()
        flavorCatalogs.update { it.copy(grok = Load.Loading) }
        grokJob = scope.launch {
            val state = try {
                val response = gateway.grokModels(machineId, cwd)
                if (response.success) {
                    Load.Ready(
                        GrokCatalog(
                            models = response.availableModels.orEmpty(),
                            currentModelId = response.currentModelId,
                            autoPermissionSupported = response.autoPermissionModeSupported,
                        ),
                    )
                } else {
                    Load.Failed(response.error ?: strings.grokLoadFailed)
                }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                Load.Failed(error.message ?: strings.grokLoadFailed)
            }
            if (grokKey != key) return@launch
            flavorCatalogs.update { it.copy(grok = state) }
            if (state is Load.Ready) {
                reconcileGrokSelections()
                // Auto permission may have just proven unsupported — coerce.
                val current = form.value
                if (current.agent == "grok" && current.permissionMode == "auto" &&
                    state.value.autoPermissionSupported == false
                ) {
                    form.update { it.copy(permissionMode = "default") }
                }
            }
        }
    }

    private fun refreshCopilotModels(machineId: String, cwd: String) {
        val key = "$machineId|$cwd"
        if (copilotKey == key && flavorCatalogs.value.copilot !is Load.Idle) return
        copilotKey = key
        copilotJob?.cancel()
        flavorCatalogs.update { it.copy(copilot = Load.Loading) }
        copilotJob = scope.launch {
            val state = try {
                val response = gateway.copilotModels(machineId, cwd)
                if (response.success) {
                    Load.Ready(CopilotCatalog(response.availableModels.orEmpty()))
                } else {
                    Load.Failed(response.error ?: strings.copilotLoadFailed)
                }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                Load.Failed(error.message ?: strings.copilotLoadFailed)
            }
            if (copilotKey != key) return@launch
            flavorCatalogs.update { it.copy(copilot = state) }
            if (state is Load.Ready) reconcileCopilotSelection(state.value)
        }
    }

    private fun refreshKimiModels(machineId: String, cwd: String) {
        val key = "$machineId|$cwd"
        if (kimiKey == key && flavorCatalogs.value.kimi !is Load.Idle) return
        kimiKey = key
        kimiJob?.cancel()
        flavorCatalogs.update { it.copy(kimi = Load.Loading) }
        kimiJob = scope.launch {
            val state = try {
                val response = gateway.kimiModels(machineId, cwd)
                if (response.success) {
                    Load.Ready(KimiCatalog(response.availableModels.orEmpty()))
                } else {
                    Load.Failed(response.error ?: strings.kimiLoadFailed)
                }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                Load.Failed(error.message ?: strings.kimiLoadFailed)
            }
            if (kimiKey != key) return@launch
            flavorCatalogs.update { it.copy(kimi = state) }
            if (state is Load.Ready) reconcileKimiSelection(state.value)
        }
    }

    private fun refreshPiModels(machineId: String) {
        if (piKey == machineId && flavorCatalogs.value.pi !is Load.Idle) return
        piKey = machineId
        piJob?.cancel()
        flavorCatalogs.update { it.copy(pi = Load.Loading) }
        piJob = scope.launch {
            val state = try {
                val response = gateway.piModels(machineId)
                if (response.success) {
                    Load.Ready(PiCatalog(response.availableModels.orEmpty()))
                } else {
                    Load.Failed(response.error ?: strings.piLoadFailed)
                }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                Load.Failed(error.message ?: strings.piLoadFailed)
            }
            if (piKey != machineId) return@launch
            flavorCatalogs.update { it.copy(pi = state) }
            if (state is Load.Ready) reconcilePiSelections()
        }
    }

    // --------------------------------------------------- flavor reconcilers --

    /** Agy: an unpicked selection that left the catalog drops to Default. */
    private fun reconcileAgySelection(catalog: AgyCatalog) {
        val current = form.value
        if (current.agent != "agy" || agyModelPickedByUser) return
        if (current.model != "auto" && catalog.models.none { it.modelId == current.model }) {
            form.update { it.copy(model = "auto") }
        }
    }

    /**
     * OpenCode adoption: `undefined` or a concrete-unlisted selection adopts
     * the backend default (`currentModelId` → first → Default); an explicit
     * Default (settled + `auto`) sticks.
     */
    private fun reconcileOpencodeSelection(catalog: OpencodeModelsCatalog) {
        val current = form.value
        if (current.agent != "opencode") return
        if (opencodeModelSettled &&
            (current.model == "auto" || catalog.models.any { it.modelId == current.model })
        ) {
            return
        }
        val adopted = catalog.currentModelId ?: catalog.models.firstOrNull()?.modelId
        form.update { it.copy(model = adopted ?: "auto") }
        opencodeModelSettled = true
    }

    /** Web `opencodeCatalogPending` — catalog inputs still resolving. */
    private fun opencodeCatalogPending(): Boolean {
        val current = form.value
        if (current.agent != "opencode" || current.trimmedDirectory.isEmpty()) return false
        val exists = pathExistence.value[current.trimmedDirectory]
        val slots = flavorCatalogs.value
        return exists == null ||
            (exists == true && (slots.opencodeModels is Load.Loading || slots.opencodeVariants is Load.Loading))
    }

    /**
     * Web `opencodeVariantOptions` memo — null = static fallback, non-null =
     * the effective model's real variant list (`[]` = model has none).
     */
    private fun opencodeVariantOptionsFor(current: NewSessionForm): List<String>? {
        if (current.agent != "opencode" || current.machineId == null) return null
        val slots = flavorCatalogs.value
        val models = (slots.opencodeModels as? Load.Ready)?.value
        val variants = slots.opencodeVariants as? Load.Ready ?: return null
        val effectiveModel = if (current.model == "auto") models?.currentModelId else current.model
        if (effectiveModel == null) return null
        return variants.value[effectiveModel].orEmpty()
    }

    /** OpenCode effort validity against the (possibly static) variant list. */
    private fun reconcileOpencodeEffort() {
        val current = form.value
        if (current.agent != "opencode" || current.modelReasoningEffort == "default") return
        if (opencodeCatalogPending()) return
        val dynamicVariants = opencodeVariantOptionsFor(current)
        if (!FlavorModelOptions.isOpencodeReasoningEffortValid(current.modelReasoningEffort, dynamicVariants)) {
            form.update { it.copy(modelReasoningEffort = "default") }
        }
    }

    /** Grok: unlisted model → auto; effort off the model's list → auto. */
    private fun reconcileGrokSelections() {
        val current = form.value
        if (current.agent != "grok") return
        val catalog = (flavorCatalogs.value.grok as? Load.Ready)?.value ?: return
        var next = current
        if (next.model != "auto" && catalog.models.none { it.modelId == next.model }) {
            next = next.copy(model = "auto")
        }
        val efforts = FlavorModelOptions.grokEffortOptions(catalog.models, next.model, catalog.currentModelId)
        if (next.effort != "auto" && efforts.none { it.value == next.effort }) {
            next = next.copy(effort = "auto")
        }
        if (next != current) form.value = next
    }

    private fun reconcileCopilotSelection(catalog: CopilotCatalog) {
        val current = form.value
        if (current.agent != "copilot") return
        if (current.model != "auto" && catalog.models.none { it.modelId == current.model }) {
            form.update { it.copy(model = "auto") }
        }
    }

    private fun reconcileKimiSelection(catalog: KimiCatalog) {
        val current = form.value
        if (current.agent != "kimi") return
        if (current.model != "auto" && catalog.models.none { it.modelId == current.model }) {
            form.update { it.copy(model = "auto") }
        }
    }

    /**
     * Pi: non-reasoning model or an unsupported thinking level drops the
     * effort; an unlisted model drops model + effort (web pi effects).
     */
    private fun reconcilePiSelections() {
        val current = form.value
        if (current.agent != "pi") return
        val slot = flavorCatalogs.value.pi
        val models = (slot as? Load.Ready)?.value?.models
        val selected = models?.let { FlavorModelOptions.resolvePiSelectedModel(it, current.model) }

        var next = current
        if (next.effort != "auto") {
            val effortReset = if (selected?.reasoning == false) {
                true
            } else {
                val settled = next.model == "auto" || selected != null || slot is Load.Failed
                settled && !FlavorModelOptions.isThinkingLevelSupported(next.effort, selected?.thinkingLevelMap)
            }
            if (effortReset) next = next.copy(effort = "auto")
        }
        if (models != null && next.model != "auto") {
            val listed = FlavorModelOptions.piModelOptions(models).any { it.value == next.model }
            if (!listed) next = next.copy(model = "auto", effort = "auto")
        }
        if (next != current) form.value = next
    }

    /**
     * Cursor: unlisted wire resets model + base; unlisted base resets to auto;
     * the base row tracks the selected wire; a deferred base pick flushes
     * once the catalog carries variants.
     */
    private fun reconcileCursorSelections() {
        val current = form.value
        if (current.agent != "cursor") return
        val slot = flavorCatalogs.value.cursor
        if (slot !is Load.Ready) return
        val catalog = cursorCatalogOrNull() ?: return

        var next = current
        if (next.model != "auto" && !catalog.wireToBase.containsKey(next.model)) {
            next = next.copy(model = "auto", cursorSelectedBase = "auto")
        } else {
            if (next.cursorSelectedBase != "auto" && !catalog.variantsByBase.containsKey(next.cursorSelectedBase)) {
                next = next.copy(cursorSelectedBase = "auto")
            }
            if (next.model != "auto") {
                val base = CursorModels.resolveBaseFromWire(next.model, catalog)
                if (next.cursorSelectedBase != base) next = next.copy(cursorSelectedBase = base)
            }
        }
        if (next != current) form.value = next

        val pending = pendingCursorBase
        if (pending != null && catalog.variantsByBase.isNotEmpty()) {
            pendingCursorBase = null
            setCursorBase(pending)
        }
    }

    private fun worktreeNameBlocks(current: NewSessionForm): Boolean =
        current.sessionType == SESSION_TYPE_WORKTREE && worktreeNameError(current.worktreeName) != null

    private suspend fun persistOnSuccess(machineId: String, directory: String, created: NewSessionForm) {
        val updated = prefsData.value.let { stored ->
            stored.copy(
                lastMachineId = machineId,
                recentPaths = stored.recentPaths + (machineId to pushRecent(stored.recentPaths[machineId].orEmpty(), directory)),
                // Remember this (machine, agent) dimension's launch defaults
                // for the next prefill (web `savePreferredLaunchSettings` on
                // every create-success path).
                launchSettings = stored.launchSettings + (
                    machineId to ((stored.launchSettings[machineId] ?: emptyMap()) +
                        (created.agent to launchPreferenceFrom(created)))
                    ),
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

        val flavors = catalogs.flavors
        val grokCatalog = (flavors.grok as? Load.Ready)?.value
        val copilotCatalog = (flavors.copilot as? Load.Ready)?.value
        val kimiCatalog = (flavors.kimi as? Load.Ready)?.value
        val piCatalog = (flavors.pi as? Load.Ready)?.value
        val piSelectedModel = piCatalog?.models
            ?.let { FlavorModelOptions.resolvePiSelectedModel(it, currentForm.model) }

        val modelOptions: List<OptionItem>? = when {
            agent == "claude" -> NewSessionCatalogs.CLAUDE_MODELS
            agent == "codex" && codex is CodexModelsUi.Loaded -> {
                listOf(OptionItem("auto", "Default")) + codex.models.map { OptionItem(it.id, it.displayName) }
            }
            agent == "codex" && (codex is CodexModelsUi.Loading || codex is CodexModelsUi.Failed) ->
                listOf(OptionItem("auto", "Default"))
            agent == "grok" ->
                FlavorModelOptions.grokModelOptions(grokCatalog?.models.orEmpty())
            agent == "copilot" ->
                FlavorModelOptions.copilotModelOptions(copilotCatalog?.models.orEmpty())
            agent == "kimi" ->
                FlavorModelOptions.kimiModelOptions(kimiCatalog?.models.orEmpty())
            agent == "pi" ->
                FlavorModelOptions.piModelOptions(piCatalog?.models.orEmpty())
            // agy/opencode/cursor render dedicated sections; codex Unsupported
            // (old runner) and the remaining flavors hide the picker.
            else -> null
        }

        val reasoningEffortOptions: List<OptionItem>? = when {
            agent == "codex" && codex !is CodexModelsUi.Unsupported -> {
                val advertised = (codex as? CodexModelsUi.Loaded)
                    ?.let { NewSessionLogic.codexReasoningEfforts(it.models, currentForm.model) }
                advertised?.let { efforts ->
                    listOf(OptionItem("default", "Default")) +
                        efforts.map { OptionItem(it, NewSessionCatalogs.effortLabel(it)) }
                } ?: NewSessionCatalogs.CODEX_REASONING_EFFORTS
            }
            agent == "opencode" -> when (val variants = opencodeVariantOptionsFor(currentForm)) {
                // Static fallback while the variant catalog resolves (or the
                // effective model is unknown); `[]` hides the field entirely.
                null -> FlavorModelOptions.OPENCODE_REASONING_EFFORTS
                else -> if (variants.isEmpty()) {
                    null
                } else {
                    listOf(OptionItem("default", "Default")) + variants.map { OptionItem(it, it) }
                }
            }
            else -> null
        }

        // Grok Auto is only selectable while the machine supports it (the row
        // stays visible, labeled unavailable, with the explanatory hint).
        val grokAutoUnsupported = agent == "grok" && grokCatalog?.autoPermissionSupported == false
        val permission: PermissionUi = when {
            agent == "pi" || agent == "dsh" -> PermissionUi.Managed
            usesNativePermissionSelect(agent) -> PermissionUi.NativeSelect(
                options = PermissionModes.forFlavor(agent).map { mode ->
                    if (mode.wireId == "auto" && grokAutoUnsupported) {
                        OptionItem(mode.wireId, "${mode.label} (${strings.grokAutoUnavailable})", enabled = false)
                    } else {
                        OptionItem(mode.wireId, mode.label)
                    }
                },
                disabledValues = if (grokAutoUnsupported) setOf("auto") else emptySet(),
                hint = if (grokAutoUnsupported) strings.grokAutoUnavailableDesc else null,
            )
            else -> PermissionUi.YoloToggle(hapiYoloNativeMode(agent)?.label)
        }

        val showFastMode = agent == "codex" && codex is CodexModelsUi.Loaded &&
            NewSessionLogic.codexModelAdvertisesFastTier(currentForm.model, codex.models)

        // Web `isLaunchPreferenceValidationPending` (codex slice): a restored
        // codex model/effort must not spawn before the catalog validated it.
        val codexValidationPending = agent == "codex" && codex is CodexModelsUi.Loading &&
            (currentForm.model != "auto" || currentForm.modelReasoningEffort != "default" || currentForm.serviceTier == "fast")

        // Web `isLaunchPreferenceValidationPending` (flavor slices): Create
        // stays disabled while a restored selection awaits its catalog.
        val opencodeCatalogPending = agent == "opencode" && trimmed.isNotEmpty() &&
            (
                directoryExists == null ||
                    (directoryExists == true &&
                        (flavors.opencodeModels is Load.Loading || flavors.opencodeVariants is Load.Loading))
                )
        val flavorValidationPending = when (agent) {
            "agy" -> currentForm.model != "auto" && flavors.agy is Load.Loading
            "cursor" -> (
                currentForm.model != "auto" || currentForm.cursorSelectedBase != "auto"
                ) && flavors.cursor is Load.Loading
            "grok" -> trimmed.isNotEmpty() &&
                (currentForm.model != "auto" || currentForm.effort != "auto") &&
                (
                    directoryExists == null ||
                        (directoryExists == true && flavors.grok is Load.Loading)
                    )
            "opencode" -> (
                trimmed.isNotEmpty() && currentForm.model != "auto" &&
                    (
                        directoryExists == null ||
                            (directoryExists == true && flavors.opencodeModels is Load.Loading)
                        )
                ) || (opencodeCatalogPending && currentForm.modelReasoningEffort != "default")
            "copilot" -> currentForm.model != "auto" &&
                (
                    directoryExists == null ||
                        (directoryExists == true && flavors.copilot is Load.Loading)
                    )
            "kimi" -> trimmed.isNotEmpty() && currentForm.model != "auto" &&
                (
                    directoryExists == null ||
                        (directoryExists == true && flavors.kimi is Load.Loading)
                    )
            "pi" -> currentForm.model != "auto" && flavors.pi is Load.Loading
            else -> false
        }

        val nameError = if (currentForm.sessionType == SESSION_TYPE_WORKTREE) {
            worktreeNameError(currentForm.worktreeName)?.let { strings.worktreeNameInvalid }
        } else {
            null
        }

        // ------------------------------------------------------ agy section --
        val agyUi: AgyUi = when (val agySlot = flavors.agy) {
            is Load.Ready -> {
                val catalog = agySlot.value
                if (catalog.models.isEmpty()) {
                    AgyUi.NoModels
                } else {
                    val selected = currentForm.model.takeIf { it != "auto" }
                    // A picked model that left the catalog stays listed,
                    // labeled "(no longer listed)" (web `withSelectedModel`).
                    val synthetic = selected
                        ?.takeIf { sel -> catalog.models.none { it.modelId == sel } }
                        ?.let { sel ->
                            listOf(
                                OptionItem(
                                    sel,
                                    "${FlavorModelOptions.agyModelLabel(sel) ?: sel} (${strings.agyNotListed})",
                                ),
                            )
                        }
                        .orEmpty()
                    AgyUi.Ready(
                        options = listOf(OptionItem("auto", "Default")) +
                            synthetic +
                            catalog.models.map { OptionItem(it.modelId, it.name ?: it.modelId) },
                        selected = selected ?: "auto",
                        warning = catalog.warning,
                        fetching = flavors.agyFetching,
                    )
                }
            }
            is Load.Loading -> AgyUi.Loading
            is Load.Failed -> AgyUi.Error(agySlot.message)
            Load.Idle -> AgyUi.Hidden
        }

        // -------------------------------------------------- opencode section --
        val opencodeUi: OpencodeUi = when {
            agent != "opencode" || currentForm.machineId == null || trimmed.isEmpty() -> OpencodeUi.Hidden
            flavors.opencodeModels is Load.Loading -> OpencodeUi.Loading
            flavors.opencodeModels is Load.Failed -> OpencodeUi.Error(
                strings.opencodeLoadFailedDetail.format((flavors.opencodeModels as Load.Failed).message),
            )
            flavors.opencodeModels is Load.Ready -> {
                val catalog = (flavors.opencodeModels as Load.Ready).value
                if (catalog.models.isEmpty()) {
                    OpencodeUi.Empty
                } else {
                    OpencodeUi.Ready(
                        options = listOf(OptionItem("auto", "Default")) + catalog.models.map { model ->
                            val suffix = if (model.modelId == catalog.currentModelId) {
                                " (${strings.opencodeDefaultLabel})"
                            } else {
                                ""
                            }
                            OptionItem(model.modelId, (model.name ?: model.modelId) + suffix)
                        },
                        selected = currentForm.model,
                    )
                }
            }
            // Gate closed by a *missing* directory (web: disabled query with
            // no data renders Empty); while existence is still probing the
            // section shows the loading state instead of a dead-end.
            directoryExists == false -> OpencodeUi.Empty
            else -> OpencodeUi.Loading
        }

        // ---------------------------------------------------- cursor section --
        val cursorUi: CursorUi = when (val cursorSlot = flavors.cursor) {
            is Load.Ready -> {
                val catalog = cursorSlot.value
                val picker = CursorModels.buildNewSessionPickerState(
                    catalog.models,
                    currentForm.model,
                    catalog.cliSkus,
                )
                val baseValue = CursorModels.baseSelectValue(picker, currentForm.cursorSelectedBase)
                val rawVariants = if (picker.mode == CursorModels.PickerMode.DUAL) {
                    val variantBase = if (baseValue != "auto") baseValue else picker.baseKey
                    CursorModels.resolveVariantOptions(variantBase, picker.catalog)
                } else {
                    emptyList()
                }
                val variantRows = rawVariants.map { OptionItem(it.wireId, it.label) }
                CursorUi.Ready(
                    mode = picker.mode,
                    modelOptions = picker.modelOptions,
                    selectedModel = baseValue,
                    variantOptions = if (rawVariants.isNotEmpty()) {
                        listOf(OptionItem("auto", strings.selectVariant)) + variantRows
                    } else {
                        emptyList()
                    },
                    selectedVariant = CursorModels.variantSelectValue(currentForm.model, variantRows),
                    showVariantPicker = rawVariants.size > 1,
                    unavailable = CursorModels.pickModelsForPicker(catalog.models).isEmpty(),
                )
            }
            is Load.Loading -> CursorUi.Loading
            is Load.Failed -> CursorUi.Error(strings.modelsFailedDetail.format(cursorSlot.message))
            Load.Idle -> CursorUi.Hidden
        }

        val modelsLoading = (agent == "codex" && codex is CodexModelsUi.Loading) ||
            (agent == "grok" && flavors.grok is Load.Loading) ||
            (agent == "copilot" && flavors.copilot is Load.Loading) ||
            (agent == "kimi" && flavors.kimi is Load.Loading) ||
            (agent == "pi" && flavors.pi is Load.Loading)
        val modelsError = when {
            codex is CodexModelsUi.Failed -> strings.modelsFailedDetail.format(codex.message)
            agent == "grok" && flavors.grok is Load.Failed ->
                strings.modelsFailedDetail.format((flavors.grok as Load.Failed).message)
            agent == "copilot" && flavors.copilot is Load.Failed ->
                strings.modelsFailedDetail.format((flavors.copilot as Load.Failed).message)
            agent == "kimi" && flavors.kimi is Load.Failed ->
                strings.modelsFailedDetail.format((flavors.kimi as Load.Failed).message)
            agent == "pi" && flavors.pi is Load.Failed ->
                strings.modelsFailedDetail.format((flavors.pi as Load.Failed).message)
            else -> null
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
            modelsLoading = modelsLoading,
            modelsError = modelsError,
            effortOptions = when {
                agent == "claude" -> NewSessionCatalogs.CLAUDE_EFFORTS
                agent == "grok" -> FlavorModelOptions.grokEffortOptions(
                    grokCatalog?.models.orEmpty(),
                    currentForm.model,
                    grokCatalog?.currentModelId,
                )
                // A non-reasoning Pi model has no thinking levels at all.
                agent == "pi" && piSelectedModel?.reasoning != false -> listOf(OptionItem("auto", "Default")) +
                    FlavorModelOptions.piThinkingLevelOptions(currentForm.effort, piSelectedModel?.thinkingLevelMap)
                else -> null
            },
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
                !codexValidationPending &&
                !flavorValidationPending,
            confirmCreateDirectory = flags.confirmed && needsCreationWarning,
            agy = agyUi,
            opencode = opencodeUi,
            cursor = cursorUi,
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

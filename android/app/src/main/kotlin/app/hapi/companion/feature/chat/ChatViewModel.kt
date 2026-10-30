package app.hapi.companion.feature.chat

import androidx.annotation.MainThread
import app.hapi.companion.feature.chat.attachments.ComposerAttachmentStatus
import app.hapi.companion.feature.chat.attachments.ComposerAttachments
import app.hapi.companion.feature.chat.attachments.PrepareResult
import app.hapi.companion.feature.chat.composer.appendSharedText
import app.hapi.companion.feature.share.PendingShare
import app.hapi.companion.feature.share.SharedFile
import app.hapi.companion.feature.share.SharedFileStatus
import app.hapi.companion.feature.chat.blocks.planProposalMarkdown
import app.hapi.companion.feature.chat.composer.AttachmentDrafts
import app.hapi.companion.feature.chat.composer.ChatDrafts
import app.hapi.companion.feature.chat.composer.ComposerDraftSnapshot
import app.hapi.companion.feature.chat.composer.ComposerDraftSnapshots
import app.hapi.companion.feature.chat.composer.SlashCommands
import app.hapi.companion.feature.chat.composer.appendTranscript
import app.hapi.companion.ui.markdown.MarkdownRenderCache
import app.hapi.protocol.chat.AgentTextBlock
import app.hapi.protocol.chat.AgentReasoningBlock
import app.hapi.companion.feature.sessions.SessionListViewModel
import app.hapi.companion.feature.sessions.formatReopenError
import app.hapi.companion.feature.newsession.CursorModels
import app.hapi.data.api.ApiError
import app.hapi.data.api.ChatSessionApi
import app.hapi.data.sse.SseEngine
import app.hapi.data.sse.SseSubscriptionKey
import app.hapi.data.sse.SyncEventRouter
import app.hapi.data.sse.SyncTargets
import app.hapi.data.store.LastSeenStore
import app.hapi.data.store.MachineListStore
import app.hapi.data.store.MessageWindowStore
import app.hapi.data.store.MessageWindowStores
import app.hapi.data.store.ChatHistoryPagingState
import app.hapi.data.store.ScratchlistCreateResult
import app.hapi.data.store.SessionDetailStore
import app.hapi.data.store.SessionScratchlist
import app.hapi.protocol.catalog.CatalogOption
import app.hapi.protocol.catalog.Flavors
import app.hapi.protocol.catalog.ModelCatalog
import app.hapi.protocol.catalog.PermissionMode
import app.hapi.protocol.catalog.PermissionModes
import app.hapi.protocol.chat.NormalizedMessage
import app.hapi.protocol.chat.ToolGroupBlock
import app.hapi.protocol.chat.ToolCallBlock
import app.hapi.protocol.chat.ToolGroupingOptions
import app.hapi.protocol.chat.VisibleChatBlock
import app.hapi.protocol.chat.buildVisibleChatBlocks
import app.hapi.protocol.chat.getInputStringAny
import app.hapi.protocol.chat.normalizeDecryptedMessage
import app.hapi.protocol.chat.reduceChatBlocks
import app.hapi.protocol.window.MessageStatus
import app.hapi.protocol.window.MessageWindowState
import app.hapi.protocol.window.MessageViewMode
import app.hapi.protocol.window.OlderLoadOutcome
import app.hapi.protocol.window.WindowMessage
import app.hapi.protocol.window.asWindowMessage
import app.hapi.protocol.wire.AgentState
import app.hapi.protocol.wire.ApprovePermissionRequest
import app.hapi.protocol.wire.AttachmentMetadata
import app.hapi.protocol.wire.CodexModelSummary
import app.hapi.protocol.wire.GrokReasoningEffortOption
import app.hapi.protocol.wire.HapiJson
import app.hapi.protocol.wire.Machine
import app.hapi.protocol.wire.OpencodeModelSummary
import app.hapi.protocol.wire.OpencodeReasoningEffortOption
import app.hapi.protocol.wire.PiModelSummary
import app.hapi.protocol.wire.SendMessageRequest
import app.hapi.protocol.wire.Session
import app.hapi.protocol.wire.SessionSummary
import app.hapi.protocol.wire.SlashCommand
import app.hapi.protocol.wire.arrayOrNull
import app.hapi.protocol.wire.objOrNull
import app.hapi.protocol.wire.stringOrNull
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.merge
import kotlinx.coroutines.flow.onSubscription
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.transform
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.yield
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Chat top-bar model: title cascade + status + meta line. */
data class ChatHeaderUi(
    val title: String,
    /** "Flavor · machine · worktree/path" meta line; null when nothing known. */
    val subtitle: String?,
    /** Raw `metadata.flavor` — drives the brand icon next to the meta line. */
    val flavor: String? = null,
    /** Raw custom `metadata.name` (rename-dialog prefill; the title cascade may show more). */
    val name: String? = null,
    val active: Boolean,
    val thinking: Boolean,
)

/** Optimistic-permission UI state layered over the reduced blocks (M3b). */
enum class PermissionRowOverride {
    /** Decision POSTed; waiting for the agentState patch to settle it. */
    Resolving,

    /** The hub said the request is no longer pending (404/409) — benign. */
    AlreadyHandled,
}

/** What [ChatScreen] renders. */
data class ChatUiState(
    val sessionId: String,
    val header: ChatHeaderUi,
    /** Raw agent flavor id (`claude`, `codex`, …); drives permission button sets. */
    val flavor: String?,
    /** Workspace root, for path display in tool cards. */
    val basePath: String?,
    val blocks: List<VisibleChatBlock>,
    /** Per-request optimistic permission state, keyed by request id. */
    val permissionOverrides: Map<String, PermissionRowOverride>,
    val hasMore: Boolean,
    val isLoadingOlder: Boolean,
    val isSyncingTail: Boolean,
    /** First sync still running and nothing (snapshot included) to show yet. */
    val isInitialLoading: Boolean,
    /** Initial load produced nothing and the last attempt failed → error state. */
    val loadFailed: Boolean,
    /** Tail sync warning — the connection/staleness banner. */
    val warning: String?,
    /** Bumps on tail-side content changes. */
    val tailRevision: Long,
    val historyVersion: Long = 0,
    val messagesVersion: Long = 0,
    val requiresLatestReset: Boolean = false,
    val processSteps: Map<String, Int> = emptyMap(),
)

/** Composer bar state (M3a). */
data class ComposerUiState(
    val text: String,
    /** A send (or its inactive-session resume) is in flight — spinner on the send button. */
    val isSending: Boolean,
    /** A turn is active: long-press send offers Steer; an empty draft shows Stop. */
    val canSteer: Boolean,
    /** Local focus intent; does not replace or send the draft. */
    val focusRequest: Long = 0,
    val isImportingShare: Boolean = false,
)

data class ShareImportFailure(val fileId: String, val status: SharedFileStatus)

/** One row of the queued-messages bar (uninvoked sends). */
data class QueuedRowUi(
    val id: String,
    val localId: String?,
    val text: String,
    val attachmentNames: List<String>,
    val scheduledAt: Long?,
    /**
     * Server echo has landed (`id != localId`) and no queued operation is in
     * flight — Cancel/Edit act only then (web `computeCanCancel`).
     */
    val canAct: Boolean,
    /** Steer offered: turn active, not future-scheduled, actionable. */
    val canSteer: Boolean,
    /** Native delivery outcome is unknown; show explicit retry instead of normal Steer. */
    val indeterminate: Boolean = false,
)

/** Session config sheet model (M3b switching; slice C adds the breadth sections). */
data class SessionConfigUi(
    val flavor: String?,
    val active: Boolean,
    /** Terminal-controlled sessions reject config posts with 409. */
    val controlledByUser: Boolean,
    /** Raw wire mode; may be outside [permissionModes] (render verbatim). */
    val permissionMode: String?,
    /** Catalog modes for this flavor; empty → hide the section (pi). */
    val permissionModes: List<PermissionMode>,
    val model: String?,
    /** null → hide the model section (flavor without a known catalog). */
    val modelOptions: List<CatalogOption>?,
    /** True while the codex model catalog loads (sheet shows a spinner row). */
    val modelOptionsLoading: Boolean,
    /**
     * Claude `effort`, codex/opencode `modelReasoningEffort`, grok/pi `effort`,
     * whichever applies.
     */
    val effort: String?,
    /** null → hide the effort section. */
    val effortOptions: List<CatalogOption>?,
    /** Codex service tier (Fast mode); null = no override (renders Standard). */
    val serviceTier: String? = null,
    /** Fast mode section gate: the active codex model advertises a fast tier. */
    val fastModeAvailable: Boolean = false,
    /** Cursor variant rows (exact wire ids); null → hide the section. */
    val variantOptions: List<CatalogOption>? = null,
)

/** One-shot side effects for the screen. */
sealed interface ChatEvent {
    /** Resume/reopen returned a different session id — renavigate to it. */
    data class SessionSuperseded(val sessionId: String) : ChatEvent

    /** The session was deleted — leave the chat screen. */
    data object SessionDeleted : ChatEvent

    /** Transient failure/notice for a snackbar (resolved to a string at the UI layer). */
    data class Notice(val notice: ChatNotice) : ChatEvent
}

/**
 * Semantic snackbar notices (B-M5a): the ViewModel stays string-free so the
 * UI layer localizes; `detail` carries server/exception text and, when
 * present, is shown verbatim (matching the previous `message ?: fallback`
 * behavior).
 */
sealed interface ChatNotice {
    data object DraftParked : ChatNotice
    data object ScratchlistFull : ChatNotice
    data object ScratchlistParkFailed : ChatNotice
    data object AttachmentsUploading : ChatNotice
    data object ResumeFailed : ChatNotice
    data object QueuedEditKeptDraft : ChatNotice
    data object QueuedAlreadyDelivered : ChatNotice
    data object PermissionAlreadyHandled : ChatNotice

    /** `DELETE` answered 409 — the session is still active (archive first). */
    data object DeleteConflictActive : ChatNotice

    data class AbortFailed(val detail: String?) : ChatNotice
    data class RenameFailed(val detail: String?) : ChatNotice
    data class DeleteFailed(val detail: String?) : ChatNotice
    data class ReopenFailed(val detail: String?) : ChatNotice
    data class CancelQueuedFailed(val detail: String?) : ChatNotice
    data class SteerFailed(val detail: String?) : ChatNotice
    data class PermissionRequestFailed(val detail: String?) : ChatNotice
    data class ModelsLoadFailed(val detail: String?) : ChatNotice
    data class ConfigUpdateFailed(val detail: String?) : ChatNotice
}

/** A permission decision the UI can request (bodies mirror `PermissionFooter.tsx`). */
sealed interface PermissionAction {
    /** Plain allow — `{}` (claude family) or `{"decision":"approved"}` (codex family). */
    data object Allow : PermissionAction

    /** Claude: `{"allowTools":[…]}`; everyone else: `{"decision":"approved_for_session"}`. */
    data object AllowForSession : PermissionAction

    /** Claude edit tools: `{"mode":"acceptEdits"}`. */
    data object AllowAllEdits : PermissionAction

    /** Plain deny — `{}`. */
    data object Deny : PermissionAction

    /** Codex family: deny with `{"decision":"abort"}`. */
    data object Abort : PermissionAction

    /** AskUserQuestion: flat `{"<key>": ["label", …]}`. */
    data class FlatAnswers(val answers: Map<String, List<String>>) : PermissionAction

    /** request_user_input: nested `{"<fieldId>": {"answers": […]}}`. */
    data class NestedAnswers(val answers: Map<String, List<String>>) : PermissionAction
}

/**
 * Per-session chat state machine. The M2 read-only slice (SSE pipe + window +
 * pipeline, see below) plus the B-M3ab interaction layer:
 *
 * - **Composer** ([composer]/[setComposerText]/[sendMessage]): optimistic send
 *   (`appendOptimistic` → POST → status settle), queue-by-default with an
 *   explicit steer intent, failed rows retried via [retryFailedMessage];
 *   `session_inactive` (409) auto-resumes once and retries, following a
 *   superseding session id with a window seed + draft move +
 *   [ChatEvent.SessionSuperseded]. Drafts persist per session via [ChatDrafts].
 * - **Queued bar** ([queuedRows]): uninvoked sends with Cancel (DELETE,
 *   invoked-race ingested), Edit (cancel + prefill) and Steer (POST steer).
 * - **Permissions** ([resolvePermission]): flavor-exact approve/deny bodies,
 *   optimistic [PermissionRowOverride]s settled by the agentState patch.
 * - **Config** ([config]/[setPermissionMode]/[setModel]/[setEffort]):
 *   catalog pickers with optimistic detail updates, rolled back to server
 *   truth on error; per-flavor catalogs fetched per session
 *   ([loadModelOptions]) — codex models+efforts, opencode/grok dynamic
 *   efforts, pi thinking levels, cursor variants.
 *
 * B-M3f adds:
 * - **Attachments** ([attachments], a [ComposerAttachments] tray): picks are
 *   prepared by the screen (ContentResolver read + image downscale) and
 *   uploaded immediately; [sendMessage] refuses while any chip is unsettled,
 *   then rides the Ready set as `SendMessageRequest.attachments` — the
 *   optimistic row carries them so the user bubble shows thumbnails at once,
 *   and [retryFailedMessage] re-extracts them from the row's wire content.
 *   Drafts v2: Ready chips persist as attachment references with the same
 *   lifecycle as text drafts (restore on visit, carry whole across a
 *   superseding resume/reopen, clear on send) — [draftRefs]/
 *   [restoreDraftAttachments] on the tray, persisted via [attachmentDrafts]
 *   and mirrored in the process-wide [draftSnapshots] live ring.
 *
 * B-M3ce adds:
 * - **Slash commands** ([slashSuggestions]/[selectSlashCommand]): `/token`
 *   composer input opens the dropdown; sources = `metadata.slashCommands`
 *   names + the lazily-fetched `GET /slash-commands` list (RPC wins dedupe).
 * - **Dictation hand-off** ([appendDictatedText]): the screen-owned
 *   `DictationController` emits transcripts; they append via `appendTranscript`.
 * - **Session ops** ([renameSession]/[deleteSession]/[reopenSession]):
 *   store-optimistic rename, delete (409-aware) with [ChatEvent.SessionDeleted],
 *   reopen reusing the supersede path (window seed + draft move +
 *   [ChatEvent.SessionSuperseded]) and [formatReopenError] for 422s.
 *
 * M2 core (unchanged): owns the session-scope SSE subscription while
 * [start]ed (dual-subscription model: `HubGraph` owns the global pipe) and
 * routes engine events into the shared [SyncTargets]; opens the
 * [MessageWindowStore], activates it, tail-syncs and reconciles queued state;
 * runs the normalize → reduce → toolGroups pipeline over the window + the
 * detail's `agentState` on [pipelineDispatcher], throttled to one run per
 * [pipelineIntervalMs]; stamps the [LastSeenStore] watermark.
 *
 * Plain constructor — JVM tests drive it with fake stores and a scripted
 * transport; Navigation hosts it behind a lifecycle-aware holder.
 */
class ChatViewModel(
    val sessionId: String,
    private val api: ChatSessionApi,
    private val sessionStore: SessionDetailStore,
    private val machineStore: MachineListStore,
    private val lastSeenStore: LastSeenStore,
    private val messageWindows: MessageWindowStores,
    private val sseEngine: SseEngine,
    syncTargets: SyncTargets,
    private val scope: CoroutineScope,
    private val drafts: ChatDrafts? = null,
    /** Attachment-reference drafts; null ⇒ tray never persists (tests/previews). */
    private val attachmentDrafts: AttachmentDrafts? = null,
    /** In-memory live snapshots (text + refs) shared across screens in this process. */
    private val draftSnapshots: ComposerDraftSnapshots? = null,
    /** null ⇒ scratchlist UI hidden (badge, park) — tests/previews without a store. */
    private val scratchlist: SessionScratchlist? = null,
    private val pipelineDispatcher: CoroutineDispatcher = Dispatchers.Default,
    private val pipelineIntervalMs: Long = PIPELINE_INTERVAL_MS,
    private val draftSaveDebounceMs: Long = DRAFT_SAVE_DEBOUNCE_MS,
    private val now: () -> Long = System::currentTimeMillis,
    /** Web `makeClientSideId('local')` twin; injectable for deterministic tests. */
    private val localIdGenerator: () -> String = { "local-${UUID.randomUUID()}" },
    /** Serialized UI event loop; JVM tests inject their UI dispatcher. */
    uiDispatcher: CoroutineDispatcher = Dispatchers.Main,
) {
    // The holder's scope is a Default worker scope, NOT the coordinator's
    // executor. Share its lifetime, but serialize all history/lifecycle state
    // with Compose callbacks. Use queued Main (not Main.immediate), so a
    // synchronous completion cannot clear a job before its handle is assigned.
    private val uiScope = CoroutineScope(scope.coroutineContext + uiDispatcher)
    private val workerContext = scope.coroutineContext.minusKey(Job)
    private val router = SyncEventRouter(syncTargets)
    private val subscriptionKey = SseSubscriptionKey.Session(sessionId)

    private val windowStore = MutableStateFlow<MessageWindowStore?>(null)
    private val detailLoadFailed = MutableStateFlow(false)

    private var sseJob: Job? = null
    private var initJob: Job? = null
    private var seenJob: Job? = null
    private var olderJob: Job? = null
    private var jumpJob: Job? = null
    private val mutableHistoryPaging = MutableStateFlow(ChatHistoryPagingState())
    val historyPaging: StateFlow<ChatHistoryPagingState> = mutableHistoryPaging.asStateFlow()
    private val mutableJumpToken = MutableStateFlow(0L)
    val jumpToken: StateFlow<Long> = mutableJumpToken.asStateFlow()
    private val mutableJumpingLatest = MutableStateFlow(false)
    val jumpingLatest: StateFlow<Boolean> = mutableJumpingLatest.asStateFlow()
    private var historyObserver: Job? = null
    private var historyRetryJob: Job? = null
    private var historyCancellation: Job? = null
    private var windowModeJob: Job? = null
    private var historyGate: AtomicBoolean? = null
    private var historyDemand = false
    private var readerFollowsTail = true
    private var transcriptVisible = true
    internal val inspection = ChatInspectionState()
    private val transcriptProjection = TranscriptProjection()
    val reconnecting: StateFlow<Boolean> = sseEngine.reconnecting(subscriptionKey)
        .stateIn(scope, SharingStarted.Eagerly, false)

    @MainThread
    internal fun setTranscriptVisible(visible: Boolean) {
        transcriptVisible = visible
        if (!visible) {
            historyDemand = false
            cancelHistory()
        }
    }

    @MainThread
    internal fun beginInspection() {
        jumpJob?.cancel()
        jumpJob = null
        mutableJumpingLatest.value = false
        readingViewportChanged(followsTail = false, needsOlder = false)
        setTranscriptVisible(false)
    }
    private var historyPumpScheduled = false
    private var lastHistoryLayout: Pair<Long, Boolean>? = null
    private var lastHistoryEpoch: Long? = null
    private var started = false
    private var everStarted = false
    private var draftJob: Job? = null

    /** This screen observed a Ready chip — only then may an empty tray be persisted. */
    @Volatile private var traySawReadyChip = false

    /** The draft was carried into a superseding id: this session must not re-persist. */
    @Volatile private var supersededHandoff = false

    // ------------------------------------------------------------ M3 state --

    private val composerText = MutableStateFlow("")
    private val sendInFlight = MutableStateFlow(false)
    private val importingShare = MutableStateFlow(false)
    private val draftReady = CompletableDeferred<Unit>()
    private val importedShares = mutableSetOf<String>()
    private val importedShareTexts = mutableSetOf<String>()
    private val importedSharedFiles = mutableSetOf<String>()
    private val shareImportMutex = Mutex()

    /**
     * Composer attachment tray (B-M3f). The screen feeds prepared picks in
     * and renders `attachments.items`; [sendMessage] consumes the Ready set.
     */
    val attachments = ComposerAttachments(api = api, sessionId = sessionId, scope = scope)
    private val queuedOpPending = MutableStateFlow(false)
    private val permissionOverrides = MutableStateFlow<Map<String, PermissionRowOverride>>(emptyMap())
    private val configOpPending = MutableStateFlow(false)
    private val composerFocusRequest = MutableStateFlow(0L)
    private data class CodexPlanOperations(
        val pendingPlanId: String? = null,
        val implementedPlanIds: Set<String> = emptySet(),
        val continuedPlanIds: Set<String> = emptySet(),
        val errors: Map<String, CodexPlanFailure> = emptyMap(),
    )
    private val codexPlanOperations = MutableStateFlow(CodexPlanOperations())

    /**
     * Per-flavor dynamic catalogs behind the config sheet (slice C). One
     * fetch per sheet open: [loadModelOptions] routes on the session flavor,
     * fills the fields that flavor needs, and leaves [loadedFlavor] null on
     * failure so the next open retries.
     */
    private data class ConfigCatalogs(
        val loading: Boolean = false,
        /** Flavor the catalogs were fetched for; null = not loaded yet / failed. */
        val loadedFlavor: String? = null,
        val codexModels: List<CodexModelSummary>? = null,
        val opencodeEfforts: List<OpencodeReasoningEffortOption>? = null,
        val grokEfforts: List<GrokReasoningEffortOption>? = null,
        val piModels: List<PiModelSummary>? = null,
        /** Cursor session catalog (`GET /api/sessions/:id/cursor-models`). */
        val cursorSessionModels: List<OpencodeModelSummary>? = null,
        /** Machine catalog merge-in; fetch failure tolerated (stays null). */
        val cursorMachineModels: List<OpencodeModelSummary>? = null,
        val cursorSessionSkus: List<OpencodeModelSummary>? = null,
        val cursorMachineSkus: List<OpencodeModelSummary>? = null,
        /** The machine's live cursor wire (`currentModelId` of the session catalog). */
        val cursorCurrentModelId: String? = null,
    )

    private val catalogs = MutableStateFlow(ConfigCatalogs())

    private sealed interface SlashFetch {
        data object Idle : SlashFetch
        data object Loading : SlashFetch
        data class Loaded(val commands: List<SlashCommand>) : SlashFetch
        data object Failed : SlashFetch
    }

    private val slashFetch = MutableStateFlow<SlashFetch>(SlashFetch.Idle)
    private val sessionOpPending = MutableStateFlow(false)

    private val _events = MutableSharedFlow<ChatEvent>(extraBufferCapacity = 16)

    /** One-shot effects: renavigation on supersede, snackbar notices. */
    val events: SharedFlow<ChatEvent> = _events.asSharedFlow()

    // Pipeline memo state — touched only inside the single uiState map stage.
    private val normalizeCache = HashMap<String, NormalizeCacheEntry>()
    private var previousGroups: List<ToolGroupBlock> = emptyList()
    internal val markdownCache = MarkdownRenderCache()
    private var previousMarkdownSources = emptySet<String>()

    private class NormalizeCacheEntry(val source: WindowMessage, val normalized: NormalizedMessage?)

    private data class PipelineInputs(
        val window: MessageWindowState,
        val detail: Session?,
        val summary: SessionSummary?,
        val machines: List<Machine>,
        val detailLoadFailed: Boolean,
        val permissionOverrides: Map<String, PermissionRowOverride>,
    )

    @OptIn(ExperimentalCoroutinesApi::class)
    val uiState: StateFlow<ChatUiState> = windowStore
        .filterNotNull()
        .flatMapLatest { store ->
            combine(
                store.state,
                sessionStore.sessionDetail(sessionId),
                summaryFlow(),
                machineStore.machines,
                detailLoadFailed,
                permissionOverrides,
            ) { values: Array<Any?> -> pipelineInputs(values) }
        }
        // The web samples pipeline runs through React batching; here: emit the
        // first value immediately, then at most one (latest) run per interval.
        .conflate()
        .transform { inputs ->
            emit(inputs)
            delay(pipelineIntervalMs)
        }
        .map(::buildUiState)
        .flowOn(pipelineDispatcher)
        .stateIn(scope, SharingStarted.Eagerly, initialState())

    /** Composer bar state (text is VM-owned so drafts and edit-prefill flow through it). */
    val composer: StateFlow<ComposerUiState> = combine(
        composerText,
        sendInFlight,
        sessionStateFlow(),
        composerFocusRequest,
        importingShare,
    ) { text, sending, session, focusRequest, importing ->
        ComposerUiState(
            text = text,
            isSending = sending,
            canSteer = session.thinking && session.active,
            focusRequest = focusRequest,
            isImportingShare = importing,
        )
    }.stateIn(scope, SharingStarted.Eagerly, ComposerUiState(text = "", isSending = false, canSteer = false))

    /** Uninvoked sends for the queued bar, ordered like the web (immediate first, then scheduled). */
    @OptIn(ExperimentalCoroutinesApi::class)
    val queuedRows: StateFlow<List<QueuedRowUi>> = windowStore
        .filterNotNull()
        .flatMapLatest { store ->
            combine(store.state, queuedOpPending, sessionStateFlow()) { window, opPending, session ->
                buildQueuedRows(window, opPending, session.thinking)
            }
        }
        .stateIn(scope, SharingStarted.Eagerly, emptyList())

    /** Plan availability updates independently of the transcript pipeline. */
    val codexPlanActions: StateFlow<CodexPlanActions> = combine(
        sessionStore.sessionDetail(sessionId), codexPlanOperations, sendInFlight, configOpPending,
    ) { detail, operations, sending, configuring ->
        buildCodexPlanActions(detail, operations, sending || configuring)
    }.stateIn(scope, SharingStarted.Eagerly, CodexPlanActions())

    /** Session config sheet model. */
    val config: StateFlow<SessionConfigUi> = combine(
        sessionStore.sessionDetail(sessionId),
        summaryFlow(),
        catalogs,
        configOpPending,
    ) { detail, summary, catalogs, _ ->
        buildConfigUi(detail, summary, catalogs)
    }.stateIn(scope, SharingStarted.Eagerly, buildConfigUi(null, null, ConfigCatalogs()))

    /**
     * Slash-command dropdown rows (B-M3ce): non-empty only while the composer
     * text is a lone `/token`. Sources: the session's `metadata.slashCommands`
     * names merged with the `GET /slash-commands` RPC list (fetched lazily on
     * the first `/`), RPC entries winning dedupe.
     */
    val slashSuggestions: StateFlow<List<SlashCommand>> = combine(
        composerText,
        slashFetch,
        sessionStore.sessionDetail(sessionId),
    ) { text, fetch, detail ->
        val query = SlashCommands.queryOf(text) ?: return@combine emptyList()
        val fetched = (fetch as? SlashFetch.Loaded)?.commands
        SlashCommands.filter(SlashCommands.merge(detail?.metadata?.slashCommands, fetched), query)
    }.stateIn(scope, SharingStarted.Eagerly, emptyList())

    /**
     * Entry count for the top-bar scratchlist badge (B-M4d); stays 0 without
     * a wired store. The store refetches on [start] (open) and on the
     * `scratchlistUpdatedAt` SSE trigger.
     */
    val scratchlistCount: StateFlow<Int> =
        (scratchlist?.state(sessionId)?.map { it.entries.size } ?: flowOf(0))
            .stateIn(scope, SharingStarted.Eagerly, 0)

    /** Whether a scratchlist store is wired — gates the badge and park affordances. */
    val scratchlistEnabled: Boolean = scratchlist != null

    // ------------------------------------------------------------ lifecycle --

    /** Idempotent; the conversation host starts this, the holder calls [stop] on exit. */
    @MainThread
    fun start() {
        if (started) return
        val preservingHistory = everStarted && (!readerFollowsTail || windowStore.value?.state?.value?.requiresLatestReset == true)
        started = true
        everStarted = true

        initJob = uiScope.launch {
            val store = withContext(workerContext) {
                messageWindows.open(sessionId).also {
                    if (preservingHistory) it.setViewMode(MessageViewMode.History) else it.activate()
                }
            }
            windowStore.value = store
            historyObserver?.cancel()
            historyObserver = uiScope.launch {
                store.state.collect { window ->
                    mutableHistoryPaging.value = mutableHistoryPaging.value.refreshAvailability(window.hasMore)
                    val epoch = window.epoch
                    if (epoch != null) {
                        if (lastHistoryEpoch != null && lastHistoryEpoch != epoch) {
                            cancelHistory()
                            mutableJumpToken.value += 1
                        }
                        lastHistoryEpoch = epoch
                    }
                    scheduleHistoryPump()
                }
            }

            // Subscribe only after the window exists: every routed message
            // event / gap resync then finds a peekable window, and the
            // collector registers before `subscribe` because the engine's
            // SharedFlow has zero replay.
            sseJob = scope.launch {
                sseEngine.events(subscriptionKey)
                    .onSubscription { sseEngine.subscribe(subscriptionKey) }
                    .collect { router.route(subscriptionKey, it) }
            }

            launch(workerContext) {
                if (preservingHistory) return@launch
                runCatching { store.syncTail() }
                // Now that sends exist, verify optimistic queued rows against
                // the hub on every chat open (web queued-state reconciliation).
                runCatching { store.reconcileQueuedState() }
            }
            launch(workerContext) { restoreDraft() }
            withContext(workerContext) { loadDetail() }
            launch(workerContext) { observeAttachmentDrafts() }
        }

        // Badge count + SSE-triggered refetches while this chat is on screen.
        scratchlist?.open(sessionId)

        seenJob = scope.launch {
            // Watermark = updatedAt currently on screen, from whichever cache
            // is fresher (summary via global events, detail via this pipe).
            merge(
                sessionStore.sessions
                    .map { list -> list.firstOrNull { it.id == sessionId }?.updatedAt },
                sessionStore.sessionDetail(sessionId).map { it?.updatedAt },
            )
                .filterNotNull()
                .distinctUntilChanged()
                .collect { updatedAt -> lastSeenStore.markSeen(sessionId, updatedAt) }
        }
    }

    /** Tears the session pipe down (engine keeps the resume cursor). */
    @MainThread
    fun stop() {
        started = false
        historyObserver?.cancel()
        historyObserver = null
        sseJob?.cancel()
        sseJob = null
        initJob?.cancel()
        seenJob?.cancel()
        cancelHistory()
        jumpJob?.cancel()
        jumpJob = null
        mutableJumpingLatest.value = false
        // Exit snapshot first (text + tray refs, while the tray still holds
        // them — the holder's discard runs after [stop]), then the durable
        // flushes. A handed-off source stays retired (web tombstone).
        if (!supersededHandoff) {
            draftSnapshots?.set(
                sessionId,
                ComposerDraftSnapshot(composerText.value, attachments.draftRefs()),
            )
        }
        flushPendingDraft()
        flushAttachmentDraft()
        sseEngine.unsubscribe(subscriptionKey)
        sessionStore.releaseDetail(sessionId)
        scratchlist?.release(sessionId)
    }

    /**
     * A debounced draft save cancelled by screen exit would lose the last
     * keystrokes; flush it on a detached scope — [scope] is torn down right
     * after [stop] returns (the web analogue is the beforeunload persist).
     * A handed-off source never re-persists: its draft belongs to the
     * superseding session now (resurrecting it is the web tombstone bug).
     */
    @OptIn(kotlinx.coroutines.DelicateCoroutinesApi::class)
    private fun flushPendingDraft() {
        val pending = draftJob?.isActive == true
        draftJob?.cancel()
        if (!pending) return
        if (supersededHandoff) return
        val store = drafts ?: return
        val text = composerText.value
        kotlinx.coroutines.GlobalScope.launch(Dispatchers.IO) {
            runCatching { store.save(sessionId, text) }
        }
    }

    /**
     * Tray references outlive the screen: persist the final state durably
     * on a detached scope. An empty tray persists only after this screen
     * observed a Ready chip (a restore skipped for an inactive session must
     * not erase the stored references — the web keeps its IDB row too).
     */
    @OptIn(kotlinx.coroutines.DelicateCoroutinesApi::class)
    private fun flushAttachmentDraft() {
        val store = attachmentDrafts ?: return
        if (supersededHandoff) return
        val refs = attachments.draftRefs()
        if (refs.isEmpty() && !traySawReadyChip) return
        kotlinx.coroutines.GlobalScope.launch(Dispatchers.IO) {
            runCatching { store.save(sessionId, refs) }
        }
    }

    /** Initial-load error state → try again (detail + tail). */
    fun retry() {
        sseEngine.requestReconnect(subscriptionKey)
        scope.launch {
            loadDetail()
            windowStore.value?.let { store -> runCatching { store.syncTail(ensureAfterCurrent = true) } }
        }
    }

    /** Explicit retry/continue. Ordinary paging is driven by viewport coverage. */
    @MainThread
    fun loadOlder() {
        mutableHistoryPaging.value = mutableHistoryPaging.value.resume()
        historyDemand = true
        scheduleHistoryPump()
    }

    @MainThread
    fun readingViewportChanged(followsTail: Boolean, needsOlder: Boolean) {
        if (!transcriptVisible) return
        val changed = readerFollowsTail != followsTail
        readerFollowsTail = followsTail
        historyDemand = needsOlder
        val store = windowStore.value
        if (changed && !mutableJumpingLatest.value && store != null) {
            if (followsTail && store.state.value.requiresLatestReset) { jumpToLatest(); return }
            val previous = windowModeJob
            windowModeJob = uiScope.launch {
                previous?.join()
                withContext(workerContext) {
                    store.setViewMode(if (followsTail) MessageViewMode.Tail else MessageViewMode.History)
                }
            }
        }
        if (!needsOlder && (olderJob != null || mutableHistoryPaging.value.phase == ChatHistoryPagingState.Phase.Retrying)) {
            cancelHistory()
        }
        scheduleHistoryPump()
    }

    @MainThread
    fun historyLaidOut(version: Long, madeProgress: Boolean) {
        val old = lastHistoryLayout
        lastHistoryLayout = version to (madeProgress || (old?.first == version && old.second))
        acknowledgeHistoryLayout()
    }

    private fun acknowledgeHistoryLayout() {
        val layout = lastHistoryLayout ?: return
        val old = mutableHistoryPaging.value
        val next = old.laidOut(layout.first, layout.second)
        mutableHistoryPaging.value = next
        if (next != old) scheduleHistoryPump()
    }

    private fun scheduleHistoryPump() {
        if (historyPumpScheduled) return
        historyPumpScheduled = true
        uiScope.launch {
            yield()
            historyPumpScheduled = false
            pumpHistory()
        }
    }

    private fun pumpHistory() {
        val store = windowStore.value ?: return
        val window = store.state.value
        if (!started || !transcriptVisible || mutableJumpingLatest.value || !historyDemand || !window.hasMore ||
            window.isSyncingTail || window.isLoadingMore || olderJob != null ||
            mutableHistoryPaging.value.phase != ChatHistoryPagingState.Phase.Idle) return
        val request = mutableHistoryPaging.value.begin()
        mutableHistoryPaging.value = request
        val gate = AtomicBoolean(true)
        historyGate = gate
        val cancellation = historyCancellation
        val modeChange = windowModeJob
        olderJob = uiScope.launch {
            cancellation?.join()
            modeChange?.join()
            if (!gate.get()) return@launch
            val outcome = withContext(workerContext) { store.fetchOlder(onBeforeApply = { gate.get() }) }
            if (mutableHistoryPaging.value.generation != request.generation) return@launch
            olderJob = null
            historyGate = null
            mutableHistoryPaging.value = mutableHistoryPaging.value.received(outcome, request.generation)
            acknowledgeHistoryLayout()
            // Tail sync may have completed while olderJob blocked observer
            // pumps. An invalidated page has no layout callback to wake us.
            if (outcome == OlderLoadOutcome.Stopped(OlderLoadOutcome.StopReason.Invalidated) ||
                outcome == OlderLoadOutcome.Stopped(OlderLoadOutcome.StopReason.EpochReset)) {
                scheduleHistoryPump()
            }
            mutableHistoryPaging.value.retryDelayMillis?.let { milliseconds ->
                historyRetryJob = uiScope.launch {
                    delay(milliseconds)
                    mutableHistoryPaging.value = mutableHistoryPaging.value.retryElapsed(request.generation)
                    scheduleHistoryPump()
                }
            }
        }
    }

    private fun cancelHistory() {
        historyGate?.set(false)
        historyGate = null
        olderJob?.cancel()
        olderJob = null
        historyRetryJob?.cancel()
        historyRetryJob = null
        mutableHistoryPaging.value = mutableHistoryPaging.value.cancel()
        lastHistoryLayout = null
        windowStore.value?.let { store ->
            val previous = historyCancellation
            historyCancellation = uiScope.launch {
                previous?.join()
                withContext(workerContext) { store.cancelOlderLoad() }
            }
        }
    }

    @MainThread
    fun jumpToLatest() {
        if (!started || mutableJumpingLatest.value) return
        val store = windowStore.value ?: return
        cancelHistory()
        historyDemand = false
        mutableJumpingLatest.value = true
        val cancellation = historyCancellation
        val modeChange = windowModeJob
        jumpJob = uiScope.launch {
            cancellation?.join()
            modeChange?.join()
            if (store.state.value.requiresLatestReset) {
                withContext(workerContext) { store.syncTail(ensureAfterCurrent = true, allowingHistoryReset = true) }
            }
            if (!started) return@launch
            if (store.state.value.requiresLatestReset) {
                mutableJumpingLatest.value = false
                jumpJob = null
                return@launch
            }
            withContext(workerContext) { store.setViewMode(MessageViewMode.Tail) }
            mutableJumpingLatest.value = false
            jumpJob = null
            readerFollowsTail = true
            mutableJumpToken.value += 1
        }
    }

    private suspend fun loadDetail() {
        try {
            sessionStore.loadSessionDetail(sessionId)
            detailLoadFailed.value = false
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Exception) {
            detailLoadFailed.value = true
        }
    }

    // ------------------------------------------------------------- composer --

    fun setComposerText(text: String) {
        if (importingShare.value) return
        // Fetch the RPC command list on the transition INTO slash mode (the
        // web refetches when the menu opens) — not on every keystroke, so a
        // wedged CLI cannot be hammered while the user types a command.
        val enteredSlashMode = SlashCommands.queryOf(text) != null &&
            SlashCommands.queryOf(composerText.value) == null
        composerText.value = text
        if (enteredSlashMode) loadSlashCommands()
        draftJob?.cancel()
        // Live snapshot on every change (web `setComposerDraftSnapshot`):
        // refreshes recency in the ring and re-opens a handed-off source
        // when the user keeps typing before navigation completes.
        draftSnapshots?.set(sessionId, ComposerDraftSnapshot(text, attachments.draftRefs()))
        val store = drafts ?: return
        draftJob = scope.launch {
            delay(draftSaveDebounceMs)
            runCatching { store.save(sessionId, text) }
        }
    }

    /** Commit the latest keystrokes before a share picker can reopen this session under a new ID. */
    suspend fun persistComposerDraft() {
        draftReady.await()
        draftJob?.cancelAndJoin()
        drafts?.save(sessionId, composerText.value)
    }

    /** Caller is the chat entry's Main-thread effect; cancellation preserves the inbox batch. */
    suspend fun importShare(
        share: PendingShare,
        complete: suspend (ShareImportFailure?) -> Unit = {},
        prepare: suspend (SharedFile) -> PrepareResult,
    ): ShareImportFailure? = shareImportMutex.withLock {
        check(share.canImport)
        importingShare.value = true
        try {
            if (share.id in importedShares) {
                complete(null)
                return@withLock null
            }
            draftReady.await()
            draftJob?.cancelAndJoin()
            if (share.text.isNotBlank() && share.id !in importedShareTexts) {
                composerText.value = drafts?.appendSharedText(sessionId, share.id, composerText.value, share.text)
                    ?: appendSharedText(composerText.value, share.text)
                importedShareTexts += share.id
            }
            for (file in share.files) {
                if (file.id in importedSharedFiles) continue
                when (val result = prepare(file)) {
                    is PrepareResult.Ready -> {
                        attachments.add(result.attachment)
                        importedSharedFiles += file.id
                    }
                    is PrepareResult.TooLarge -> return@withLock ShareImportFailure(file.id, SharedFileStatus.TooLarge).also { complete(it) }
                    is PrepareResult.Unreadable -> return@withLock ShareImportFailure(file.id, SharedFileStatus.Unreadable).also { complete(it) }
                }
            }
            importedShares += share.id
            complete(null)
            composerFocusRequest.value += 1
            null
        } finally {
            importingShare.value = false
        }
    }

    /** Dictation transcript arrived: append with a space separator (web `appendTranscript`). */
    fun appendDictatedText(transcript: String) {
        setComposerText(appendTranscript(composerText.value, transcript))
    }

    /**
     * Scratchlist "Send to composer" (B-M4d): insert [text] into the composer
     * — an empty composer takes it verbatim, an existing draft keeps its
     * words and the entry lands on a new line (the entry itself stays on the
     * scratchlist, like the web's promote-to-composer).
     */
    fun insertComposerText(text: String) {
        if (text.isBlank()) return
        val current = composerText.value
        setComposerText(if (current.isBlank()) text else "${current.trimEnd()}\n$text")
    }

    /**
     * Scratchlist "Park from composer" (B-M4d): the current draft becomes a
     * scratchlist entry and the composer clears (store-optimistic; the
     * composer clears only after the hub accepts, so a failed park cannot
     * lose the draft).
     */
    fun parkComposerDraft() {
        val store = scratchlist ?: return
        val text = composerText.value
        if (text.isBlank()) return
        scope.launch {
            when (val result = store.createEntry(sessionId, text)) {
                is ScratchlistCreateResult.Created -> {
                    // Clear only when the draft is still what we parked (the
                    // operator may have kept typing while the POST ran).
                    if (composerText.value == text) setComposerText("")
                    _events.tryEmit(ChatEvent.Notice(ChatNotice.DraftParked))
                }
                ScratchlistCreateResult.AtCap ->
                    _events.tryEmit(ChatEvent.Notice(ChatNotice.ScratchlistFull))
                is ScratchlistCreateResult.Failed ->
                    _events.tryEmit(ChatEvent.Notice(ChatNotice.ScratchlistParkFailed))
            }
        }
    }

    /** Dropdown tap: replace the slash token with `/name ` ready for arguments. */
    fun selectSlashCommand(command: SlashCommand) {
        setComposerText("/${command.name} ")
    }

    /**
     * `GET /slash-commands` once per screen (near-static list; a failed fetch
     * retries on the next `/`). RPC failure is silent — the metadata names
     * still populate the menu, like the web's builtin fallback.
     */
    private fun loadSlashCommands() {
        if (slashFetch.value is SlashFetch.Loading || slashFetch.value is SlashFetch.Loaded) return
        slashFetch.value = SlashFetch.Loading
        scope.launch {
            slashFetch.value = try {
                val response = api.getSlashCommands(sessionId)
                val commands = response.commands
                if (response.success && commands != null) SlashFetch.Loaded(commands) else SlashFetch.Failed
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (_: Exception) {
                SlashFetch.Failed
            }
        }
    }

    /**
     * Submit the composer. Delivery defaults to durable queue; [steer] is the
     * explicit long-press intent that delivers into the active turn
     * (`deliveryMode: "steer"` — `messageDelivery.ts` semantics; attachments
     * may ride a steer, only `scheduledAt` excludes them).
     *
     * Ready attachments are consumed into `SendMessageRequest.attachments`;
     * an unsettled chip (uploading/failed) blocks the send with a notice.
     * Text may be empty when attachments exist (wire: text OR attachments).
     */
    fun sendMessage(steer: Boolean = false) {
        if (sendInFlight.value || importingShare.value) return
        if (attachments.hasUnsettled()) {
            _events.tryEmit(ChatEvent.Notice(ChatNotice.AttachmentsUploading))
            return
        }
        val text = composerText.value.trim()
        val attachmentMetadata = attachments.consume()
        if (text.isEmpty() && attachmentMetadata == null) return
        composerText.value = ""
        draftJob?.cancel()
        sendInFlight.value = true
        scope.launch {
            try {
                drafts?.let { runCatching { it.clear(sessionId) } }
                // Sent content is not a draft: consume the tray references
                // too (web `clearDraftsAfterSend` clears both stores).
                attachmentDrafts?.let { runCatching { it.clear(sessionId) } }
                draftSnapshots?.remove(sessionId)
                if (attachmentMetadata == null && (text == "/clear" || text == "/new") &&
                    sessionStore.sessionDetail(sessionId).first()?.metadata?.capabilities?.concurrentClients == true) {
                    sendInFlight.value = true
                    try {
                        val result = api.clearConversation(sessionId)
                        _events.tryEmit(ChatEvent.SessionSuperseded(result.sessionId))
                    } catch (cancellation: CancellationException) {
                        throw cancellation
                    } catch (error: Exception) {
                        composerText.value = text
                        _events.tryEmit(ChatEvent.Notice(ChatNotice.ReopenFailed(error.message)))
                    } finally { sendInFlight.value = false }
                    return@launch
                }
                performSend(
                    text = text,
                    localId = localIdGenerator(),
                    createdAt = now(),
                    deliveryMode = if (steer) "steer" else "queue",
                    attachments = attachmentMetadata,
                    isRetry = false,
                )
            } finally { sendInFlight.value = false }
        }
    }

    /**
     * The screen is going away for good (holder `onCleared`, not a config
     * change). With drafts v2 wired the Ready uploads are referenced by the
     * persisted/carried draft and must survive; without it (tests/previews)
     * the v1 cleanup still discards them after a best-effort hub delete.
     */
    fun discardAttachments() {
        if (attachmentDrafts != null) attachments.discardAllKeepingUploads()
        else attachments.discardAllDetached()
    }

    /** Tap-to-retry on a failed optimistic row: re-fires the send with the same localId. */
    fun retryFailedMessage(localId: String) {
        if (sendInFlight.value) return
        scope.launch {
            val store = awaitWindowStore()
            val row = store.state.value.messages
                .firstOrNull { it.localId == localId && it.status == MessageStatus.Failed }
                ?: return@launch
            val payload = sendPayloadOf(row) ?: return@launch
            performSend(
                text = payload.text,
                localId = localId,
                createdAt = row.createdAt,
                // A retry cannot prove the original turn is still live —
                // steer degrades to queue (web `getRetryDeliveryMode`).
                deliveryMode = "queue",
                attachments = payload.attachments,
                scheduledAt = row.wire.scheduledAt,
                isRetry = true,
            )
        }
    }

    private class SendPayload(val text: String, val attachments: List<AttachmentMetadata>?)

    /** Extract text + attachments from an optimistic user row's wire content. */
    private fun sendPayloadOf(row: WindowMessage): SendPayload? {
        val inner = row.wire.content.objOrNull?.get("content").objOrNull ?: return null
        val text = inner["text"].stringOrNull ?: return null
        val attachments = inner["attachments"].arrayOrNull?.let { array ->
            runCatching {
                HapiJson.decodeFromJsonElement(ListSerializer(AttachmentMetadata.serializer()), array)
            }.getOrNull()
        }?.takeIf { it.isNotEmpty() }
        return SendPayload(text, attachments)
    }

    private suspend fun performSend(
        text: String,
        localId: String,
        createdAt: Long,
        deliveryMode: String,
        attachments: List<AttachmentMetadata>? = null,
        scheduledAt: Long? = null,
        isRetry: Boolean,
    ) {
        // Wire constraint (SendMessageRequestSchema): scheduled sends exclude
        // attachments (and steer). No Android surface can produce the combo
        // today — this trips loudly if a scheduled-send UI ever forgets it.
        check(scheduledAt == null || attachments.isNullOrEmpty()) {
            "scheduled sends cannot carry attachments"
        }
        sendInFlight.value = true
        try {
            val store = awaitWindowStore()
            if (isRetry) {
                store.updateStatus(localId, MessageStatus.Sending)
            } else {
                store.appendOptimistic(
                    localId = localId,
                    text = text,
                    attachments = attachments,
                    scheduledAt = scheduledAt,
                    deliveryMode = deliveryMode,
                    createdAt = createdAt,
                )
            }
            val request = SendMessageRequest(
                text = text,
                localId = localId,
                attachments = attachments,
                scheduledAt = scheduledAt,
                deliveryMode = deliveryMode,
            )
            try {
                api.sendMessage(sessionId, request)
                store.updateStatus(localId, successStatus())
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                if (error.isSessionInactive()) {
                    resumeAndRetry(store, request, localId)
                } else {
                    store.updateStatus(localId, MessageStatus.Failed)
                }
            }
        } finally {
            sendInFlight.value = false
        }
    }

    /** Queued while a turn is active, sent otherwise (web `onMutate` successStatus). */
    private fun successStatus(): MessageStatus =
        if (currentSessionState().thinking) MessageStatus.Queued else MessageStatus.Sent

    /**
     * `session_inactive` recovery (web `resolveSessionId` semantics,
     * `router.tsx`): one `POST /resume`, then retry the send against the id
     * the hub returns. A different id supersedes this session — seed the new
     * window from this one, migrate the draft, retarget the optimistic row,
     * and tell the screen to renavigate.
     */
    private suspend fun resumeAndRetry(
        store: MessageWindowStore,
        request: SendMessageRequest,
        localId: String,
    ) {
        val targetSessionId = try {
            api.resumeSession(sessionId, currentDetail()?.permissionMode).sessionId
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Exception) {
            store.updateStatus(localId, MessageStatus.Failed)
            _events.tryEmit(ChatEvent.Notice(ChatNotice.ResumeFailed))
            return
        }

        val optimisticRow = store.state.value.messages.firstOrNull { it.localId == localId }
        var targetStore = store
        if (targetSessionId != sessionId) {
            messageWindows.seed(sessionId, targetSessionId)
            targetStore = messageWindows.open(targetSessionId)
            if (optimisticRow != null) {
                // Seeding copies rows across, but make the hand-off explicit:
                // the pending row must live in the target window only.
                targetStore.appendOptimistic(optimisticRow)
                store.removeMessage(localId)
            }
            carryComposerDraftsTo(targetSessionId)
        }

        // Resume succeeded: reflect activity locally, refresh the list row.
        sessionStore.updateDetailLocal(sessionId) { it.copy(active = true) }
        sessionStore.scheduleRefresh()

        try {
            api.sendMessage(targetSessionId, request)
            targetStore.updateStatus(localId, successStatus())
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Exception) {
            targetStore.updateStatus(localId, MessageStatus.Failed)
        }
        if (targetSessionId != sessionId) {
            _events.tryEmit(ChatEvent.SessionSuperseded(targetSessionId))
        }
    }

    /** `POST /abort` — confirm-free stop of the active turn. */
    fun abortSession() {
        scope.launch {
            try {
                api.abortSession(sessionId)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                _events.tryEmit(ChatEvent.Notice(ChatNotice.AbortFailed(error.message)))
            }
        }
    }

    // ---------------------------------------------------------- session ops --

    /** `PATCH /sessions/:id` rename — optimistic name in the store, rolled forward on failure. */
    fun renameSession(name: String) {
        val trimmed = name.trim()
        if (trimmed.isEmpty()) return
        scope.launch {
            try {
                sessionStore.renameSession(sessionId, trimmed)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                _events.tryEmit(ChatEvent.Notice(ChatNotice.RenameFailed(error.message)))
            }
        }
    }

    /** `DELETE /sessions/:id` — [ChatEvent.SessionDeleted] on success; 409 while active. */
    fun deleteSession() {
        if (!sessionOpPending.compareAndSet(expect = false, update = true)) return
        scope.launch {
            try {
                sessionStore.deleteSession(sessionId)
                _events.tryEmit(ChatEvent.SessionDeleted)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                val notice = if (error is ApiError && error.status == 409) {
                    ChatNotice.DeleteConflictActive
                } else {
                    ChatNotice.DeleteFailed(error.message)
                }
                _events.tryEmit(ChatEvent.Notice(notice))
            } finally {
                sessionOpPending.value = false
            }
        }
    }

    /**
     * `POST /reopen` for an inactive session. A superseding id gets the same
     * treatment as the send-resume path: window seed + draft move +
     * [ChatEvent.SessionSuperseded]. 422 (metadata incomplete) surfaces via
     * [formatReopenError].
     */
    fun reopenSession() {
        if (!sessionOpPending.compareAndSet(expect = false, update = true)) return
        scope.launch {
            try {
                val response = sessionStore.reopenSession(sessionId)
                if (response.sessionId != sessionId) {
                    messageWindows.seed(sessionId, response.sessionId)
                    carryComposerDraftsTo(response.sessionId)
                    _events.tryEmit(ChatEvent.SessionSuperseded(response.sessionId))
                }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                _events.tryEmit(ChatEvent.Notice(ChatNotice.ReopenFailed(formatReopenError(error))))
            } finally {
                sessionOpPending.value = false
            }
        }
    }

    // ----------------------------------------------------------- queued bar --

    /**
     * Cancel one queued message: optimistic removal, `DELETE`; an `invoked`
     * answer means the agent already consumed it — ingest the authoritative
     * row as sent (web `useCancelQueuedMessage`). Errors restore the row.
     */
    fun cancelQueuedMessage(messageId: String) {
        scope.launch { cancelQueuedInternal(messageId) }
    }

    /** @return the cancel verdict: `"cancelled"`, `"invoked"`, or null on guard/error. */
    private suspend fun cancelQueuedInternal(messageId: String): String? {
        val store = awaitWindowStore()
        val row = store.state.value.messages.firstOrNull { it.id == messageId } ?: return null
        if (!canActOnQueuedRow(row)) return null
        if (!queuedOpPending.compareAndSet(expect = false, update = true)) return null
        val localId = row.localId ?: row.id
        store.removeMessage(localId)
        return try {
            val response = api.cancelMessage(sessionId, messageId)
            val invokedMessage = response.message
            if (response.status == "invoked" && invokedMessage != null) {
                store.appendOptimistic(invokedMessage.asWindowMessage(MessageStatus.Sent))
            } else if (response.status == "busy") {
                store.appendOptimistic(row.copy(status = MessageStatus.Indeterminate))
                runCatching { store.reconcileQueuedState() }
            }
            response.status
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Exception) {
            store.appendOptimistic(row)
            _events.tryEmit(ChatEvent.Notice(ChatNotice.CancelQueuedFailed(error.message)))
            null
        } finally {
            queuedOpPending.value = false
        }
    }

    fun retryIndeterminateMessage(messageId: String) {
        if (!queuedOpPending.compareAndSet(expect = false, update = true)) return
        scope.launch {
            try {
                val response = api.retryIndeterminateMessage(sessionId, messageId)
                val message = response.message
                if (response.status == "invoked" && message != null) {
                    val localId = message.localId
                    val invokedAt = message.invokedAtOrNull
                    if (localId != null && invokedAt != null) {
                        awaitWindowStore().markConsumed(listOf(localId), invokedAt)
                    }
                }
                if (response.status == "retried" || response.status == "already-queued") {
                    response.localId?.let { awaitWindowStore().markRequeued(listOf(it)) }
                } else if (response.status == "not-found") {
                    awaitWindowStore().removeMessage(messageId)
                    _events.tryEmit(ChatEvent.Notice(ChatNotice.CancelQueuedFailed("Message is no longer available")))
                } else if (response.status == "retry-unavailable") {
                    _events.tryEmit(ChatEvent.Notice(ChatNotice.CancelQueuedFailed("Delivery is still being resolved")))
                }
            } catch (error: Exception) {
                _events.tryEmit(ChatEvent.Notice(ChatNotice.CancelQueuedFailed(error.message)))
            } finally {
                queuedOpPending.value = false
            }
        }
    }

    /** Edit = cancel + prefill composer (kept when the operator typed meanwhile). */
    fun editQueuedMessage(messageId: String) {
        scope.launch {
            val store = awaitWindowStore()
            val row = store.state.value.messages.firstOrNull { it.id == messageId } ?: return@launch
            val preview = queuedPreview(row)
            val editText = preview.text.ifEmpty { preview.attachmentNames.joinToString(", ") }
            val composerAtEdit = composerText.value
            when (cancelQueuedInternal(messageId)) {
                "cancelled" -> {
                    if (composerText.value == composerAtEdit) {
                        setComposerText(editText)
                    } else {
                        _events.tryEmit(ChatEvent.Notice(ChatNotice.QueuedEditKeptDraft))
                    }
                }
                "invoked" -> _events.tryEmit(ChatEvent.Notice(ChatNotice.QueuedAlreadyDelivered))
                else -> Unit
            }
        }
    }

    /**
     * Steer one queued message into the active turn. Non-optimistic: the
     * `messages-consumed` event settles the row (web `useSteerQueuedMessage`);
     * an `invoked` answer reconciles a missed consume.
     */
    fun steerQueuedMessage(messageId: String) {
        scope.launch {
            val store = awaitWindowStore()
            val row = store.state.value.messages.firstOrNull { it.id == messageId } ?: return@launch
            if (!canActOnQueuedRow(row) || row.wire.scheduledAt != null) return@launch
            if (!queuedOpPending.compareAndSet(expect = false, update = true)) return@launch
            try {
                val response = api.steerMessage(sessionId, messageId)
                when (response.status) {
                    "failed" -> _events.tryEmit(
                        ChatEvent.Notice(ChatNotice.SteerFailed(response.error)),
                    )
                    "invoked" -> {
                        val message = response.message
                        val invokedLocalId = message?.localId
                        val invokedAt = message?.invokedAtOrNull
                        if (invokedLocalId != null && invokedAt != null) {
                            store.markConsumed(listOf(invokedLocalId), invokedAt)
                        }
                    }
                    else -> Unit // "steered": messages-consumed removes the row.
                }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                _events.tryEmit(ChatEvent.Notice(ChatNotice.SteerFailed(error.message)))
            } finally {
                queuedOpPending.value = false
            }
        }
    }

    private fun canActOnQueuedRow(row: WindowMessage): Boolean {
        val hasServerEcho = row.localId == null || row.id != row.localId
        return hasServerEcho && !queuedOpPending.value
    }

    private class QueuedPreview(val text: String, val attachmentNames: List<String>)

    private fun queuedPreview(row: WindowMessage): QueuedPreview {
        val normalized = normalizeDecryptedMessage(row.wire) as? NormalizedMessage.User
            ?: return QueuedPreview("", emptyList())
        return QueuedPreview(
            text = normalized.text.trim(),
            attachmentNames = normalized.attachments?.map { it.filename } ?: emptyList(),
        )
    }

    private fun buildQueuedRows(
        window: MessageWindowState,
        opPending: Boolean,
        thinking: Boolean,
    ): List<QueuedRowUi> {
        val queued = window.messages.filter { it.isQueuedForInvocation }
        // Web `sortQueuedMessages`: immediate first (submission order), then
        // scheduled by fire time.
        val sorted = queued.sortedWith(
            compareBy<WindowMessage> { it.wire.scheduledAt != null }
                .thenBy { it.wire.scheduledAt ?: it.createdAt },
        )
        return sorted.map { row ->
            val preview = queuedPreview(row)
            val hasServerEcho = row.localId == null || row.id != row.localId
            val canAct = hasServerEcho && !opPending
            QueuedRowUi(
                id = row.id,
                localId = row.localId,
                text = preview.text,
                attachmentNames = preview.attachmentNames,
                scheduledAt = row.wire.scheduledAt,
                canAct = canAct,
                canSteer = canAct && thinking && row.wire.scheduledAt == null
                    && row.status != MessageStatus.Indeterminate,
                indeterminate = row.status == MessageStatus.Indeterminate,
            )
        }
    }

    // ---------------------------------------------------------- permissions --

    /**
     * Apply one permission decision. Wire bodies match the web
     * `PermissionFooter`/`AskUserQuestionFooter`/`RequestUserInputFooter`
     * exactly; 404/409 from the hub mean the request already settled
     * elsewhere — surfaced as a benign [PermissionRowOverride.AlreadyHandled].
     */
    fun resolvePermission(requestId: String, action: PermissionAction) {
        if (permissionOverrides.value.containsKey(requestId)) return
        permissionOverrides.update { it + (requestId to PermissionRowOverride.Resolving) }
        scope.launch {
            try {
                when (action) {
                    PermissionAction.Deny -> api.denyPermission(sessionId, requestId)
                    PermissionAction.Abort -> api.denyPermission(sessionId, requestId, decision = "abort")
                    else -> api.approvePermission(sessionId, requestId, approveBody(requestId, action))
                }
                // Success: stay `Resolving`; the agentState patch clears the
                // pending request and the pipeline prunes the override.
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                if (error is ApiError && (error.status == 404 || error.status == 409)) {
                    permissionOverrides.update { it + (requestId to PermissionRowOverride.AlreadyHandled) }
                    _events.tryEmit(ChatEvent.Notice(ChatNotice.PermissionAlreadyHandled))
                } else {
                    permissionOverrides.update { it - requestId }
                    _events.tryEmit(ChatEvent.Notice(ChatNotice.PermissionRequestFailed(error.message)))
                }
            }
        }
    }

    private fun approveBody(requestId: String, action: PermissionAction): ApprovePermissionRequest {
        val flavor = currentFlavor()
        val request = currentDetail()?.agentState?.requests?.get(requestId)
        val toolName = request?.tool
        val codexUx = isCodexPermissionUx(flavor, toolName)
        return when (action) {
            PermissionAction.Allow ->
                if (codexUx) ApprovePermissionRequest(decision = "approved")
                else ApprovePermissionRequest()

            PermissionAction.AllowForSession ->
                if (flavor == "claude") {
                    val command = if (toolName == "Bash") {
                        getInputStringAny(request?.arguments, listOf("command", "cmd"))
                    } else {
                        null
                    }
                    val toolIdentifier = if (toolName == "Bash" && command != null) {
                        "Bash($command)"
                    } else {
                        toolName ?: ""
                    }
                    ApprovePermissionRequest(allowTools = listOf(toolIdentifier))
                } else {
                    ApprovePermissionRequest(decision = "approved_for_session")
                }

            PermissionAction.AllowAllEdits -> ApprovePermissionRequest(mode = "acceptEdits")

            is PermissionAction.FlatAnswers -> ApprovePermissionRequest(
                answers = buildJsonObject {
                    action.answers.forEach { (key, values) ->
                        put(key, JsonArray(values.map(::JsonPrimitive)))
                    }
                },
            )

            is PermissionAction.NestedAnswers -> ApprovePermissionRequest(
                answers = buildJsonObject {
                    action.answers.forEach { (key, values) ->
                        put(
                            key,
                            buildJsonObject {
                                put("answers", buildJsonArray { values.forEach { add(JsonPrimitive(it)) } })
                            },
                        )
                    }
                },
            )

            PermissionAction.Deny, PermissionAction.Abort ->
                error("deny actions do not build approve bodies")
        }
    }

    // ---------------------------------------------------- Codex plan actions --

    private fun buildCodexPlanActions(
        detail: Session?, operations: CodexPlanOperations, busy: Boolean,
    ): CodexPlanActions = CodexPlanActions(
        proposalId = detail?.agentState?.codexPlanProposalId?.takeIf {
            detail.active && detail.metadata?.flavor == "codex"
                && detail.metadata?.capabilities?.concurrentClients == true
                && it !in operations.implementedPlanIds
                && it !in operations.continuedPlanIds
        },
        pendingPlanId = operations.pendingPlanId,
        disabled = busy || detail?.thinking == true,
        errors = operations.errors,
    )

    // Re-read live inputs for callbacks; a combined StateFlow can lag a UI tap.
    private fun currentCodexPlanActions() = buildCodexPlanActions(
        sessionStore.currentDetail(sessionId), codexPlanOperations.value,
        sendInFlight.value || configOpPending.value,
    )

    fun implementCodexPlan(planId: String) {
        val previous = codexPlanOperations.value
        if (!currentCodexPlanActions().forPlan(planId).canAct) return
        if (!codexPlanOperations.compareAndSet(previous, previous.copy(
                pendingPlanId = planId, errors = previous.errors - planId,
            ))) return
        scope.launch {
            try {
                try {
                    api.implementCodexPlan(sessionId, planId)
                    // Acceptance wins over a failed or temporarily stale refresh.
                    codexPlanOperations.update { it.copy(implementedPlanIds = it.implementedPlanIds + planId) }
                } catch (cancellation: CancellationException) {
                    throw cancellation
                } catch (error: Exception) {
                    val serverMessage = (error as? ApiError)?.body?.let {
                        runCatching { HapiJson.parseToJsonElement(it).objOrNull?.get("error").stringOrNull }.getOrNull()
                    }
                    codexPlanOperations.update {
                        it.copy(errors = it.errors + (planId to CodexPlanFailure(serverMessage ?: error.message)))
                    }
                }
                // Another client may have consumed/withdrawn the proposal, even
                // after a failure. Refresh without resubmitting an uncertain POST.
                try {
                    sessionStore.loadSessionDetail(sessionId)
                } catch (cancellation: CancellationException) {
                    throw cancellation
                } catch (_: Exception) {
                    // Keep the last state; SSE/reconnection will refresh later.
                }
            } finally {
                codexPlanOperations.update { it.copy(pendingPlanId = null) }
            }
        }
    }

    fun continueCodexPlan(planId: String) {
        if (!currentCodexPlanActions().forPlan(planId).canAct) return
        codexPlanOperations.update {
            it.copy(continuedPlanIds = it.continuedPlanIds + planId, errors = it.errors - planId)
        }
        composerFocusRequest.update { it + 1 }
    }

    // ---------------------------------------------------------------- config --

    /**
     * Web's terminal-control flag (SessionChat.tsx:996):
     * `controlledByUser && !concurrentClients` — shared-clients sessions
     * report the flag but keep remote config switching.
     */
    private fun terminalControlled(detail: Session?): Boolean =
        detail?.agentState?.controlledByUser == true && detail?.metadata?.capabilities?.concurrentClients != true

    /**
     * `POST /permission-mode` with an optimistic detail flip; server truth on
     * error. Inactive sessions stay switchable (web parity — the send path
     * auto-resumes); only copilot sessions under local terminal control lose
     * the switcher (web withholds the callback, SessionChat.tsx:2159-2163).
     */
    fun setPermissionMode(mode: PermissionMode) {
        if (currentFlavor() == "copilot" && terminalControlled(currentDetail())) return
        runConfigChange(
            optimistic = { it.copy(permissionMode = mode.wireId) },
            call = { api.setPermissionMode(sessionId, mode.wireId) },
        )
    }

    /** `POST /model` — null clears back to the agent default. */
    fun setModel(model: String?) {
        runConfigChange(
            optimistic = { it.copy(model = model) },
            call = { api.setModel(sessionId, model) },
        )
    }

    /**
     * Effort switch, flavor-routed: claude → `POST /effort`; codex/opencode →
     * `POST /model-reasoning-effort`. Null clears. Pi's rows toggle off by
     * posting null when the clicked row is already selected (web parity).
     */
    fun setEffort(effort: String?) {
        val usesReasoningEffort = currentFlavor() == "codex" || currentFlavor() == "opencode"
        runConfigChange(
            optimistic = {
                if (usesReasoningEffort) it.copy(modelReasoningEffort = effort) else it.copy(effort = effort)
            },
            call = {
                if (usesReasoningEffort) {
                    api.setModelReasoningEffort(sessionId, effort)
                } else {
                    api.setEffort(sessionId, effort)
                }
            },
        )
    }

    /**
     * `POST /service-tier` (codex Fast mode) — `'fast' | 'standard'`; an
     * explicit `'standard'` persists Fast-off distinctly from an untouched
     * session. Optimistic flip with the shared rollback.
     */
    fun setServiceTier(serviceTier: String) {
        runConfigChange(
            optimistic = { it.copy(serviceTier = serviceTier) },
            call = { api.setServiceTier(sessionId, serviceTier) },
        )
    }

    /** Flavors whose config sheet needs a dynamic catalog fetch. */
    private val configCatalogFlavors = setOf("codex", "opencode", "grok", "pi", "cursor")

    /**
     * Fetch the session flavor's dynamic config catalogs (codex models +
     * efforts, opencode/grok reasoning-effort options, pi models, cursor
     * session+machine catalogs). One load per flavor: a failure leaves
     * `loadedFlavor` null so the next sheet open retries. Other flavors are a
     * no-op (static/no catalog).
     */
    fun loadModelOptions() {
        val flavor = currentFlavor() ?: return
        if (flavor !in configCatalogFlavors) return
        val state = catalogs.value
        if (state.loading || state.loadedFlavor == flavor) return
        catalogs.value = ConfigCatalogs(loading = true)
        scope.launch {
            catalogs.value = when (flavor) {
                "codex" -> loadCodexCatalogs()
                "opencode" -> loadOpencodeCatalogs()
                "grok" -> loadGrokCatalogs()
                "pi" -> loadPiCatalogs()
                "cursor" -> loadCursorCatalogs()
                else -> ConfigCatalogs()
            }
        }
    }

    private suspend fun loadCodexCatalogs(): ConfigCatalogs {
        val response = try {
            api.getSessionCodexModels(sessionId)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Exception) {
            _events.tryEmit(ChatEvent.Notice(ChatNotice.ModelsLoadFailed(error.message)))
            return ConfigCatalogs()
        }
        val models = response.models
        return if (response.success && models != null) {
            ConfigCatalogs(loadedFlavor = "codex", codexModels = models)
        } else {
            _events.tryEmit(ChatEvent.Notice(ChatNotice.ModelsLoadFailed(response.error)))
            ConfigCatalogs()
        }
    }

    /** Silent-hide on failure — the opencode section simply stays absent (web parity). */
    private suspend fun loadOpencodeCatalogs(): ConfigCatalogs {
        val response = try {
            api.getSessionOpencodeReasoningEffortOptions(sessionId)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Exception) {
            return ConfigCatalogs()
        }
        val options = response.options
        return if (response.success && options != null) {
            ConfigCatalogs(loadedFlavor = "opencode", opencodeEfforts = options)
        } else {
            ConfigCatalogs()
        }
    }

    /** Silent-hide on failure — the grok section stays absent (web parity). */
    private suspend fun loadGrokCatalogs(): ConfigCatalogs {
        val response = try {
            api.getSessionGrokReasoningEffortOptions(sessionId)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Exception) {
            return ConfigCatalogs()
        }
        val options = response.options
        return if (response.success && options != null) {
            ConfigCatalogs(loadedFlavor = "grok", grokEfforts = options)
        } else {
            ConfigCatalogs()
        }
    }

    /** Silent-hide on failure — pi thinking levels need the resolved model row. */
    private suspend fun loadPiCatalogs(): ConfigCatalogs {
        val response = try {
            api.getSessionPiModels(sessionId)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Exception) {
            return ConfigCatalogs()
        }
        val models = response.availableModels
        return if (response.success && models != null) {
            ConfigCatalogs(loadedFlavor = "pi", piModels = models)
        } else {
            ConfigCatalogs()
        }
    }

    /**
     * Session catalog first (authoritative); the machine catalog merges in to
     * fill display names and extra CLI skus — its failure is tolerated (web
     * parity: `useCursorModelsForMachine` error only downgrades readiness).
     */
    private suspend fun loadCursorCatalogs(): ConfigCatalogs {
        val session = try {
            api.getSessionCursorModels(sessionId)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Exception) {
            return ConfigCatalogs()
        }
        if (!session.success) return ConfigCatalogs()

        val machineId = currentDetail()?.metadata?.machineId
        val machine = if (machineId != null) {
            try {
                api.getMachineCursorModels(machineId)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (_: Exception) {
                null
            }
        } else {
            null
        }
        return ConfigCatalogs(
            loadedFlavor = "cursor",
            cursorSessionModels = session.availableModels ?: emptyList(),
            cursorMachineModels = if (machine?.success == true) machine.availableModels ?: emptyList() else null,
            cursorSessionSkus = session.cliModelSkus ?: emptyList(),
            cursorMachineSkus = if (machine?.success == true) machine.cliModelSkus ?: emptyList() else null,
            cursorCurrentModelId = session.currentModelId,
        )
    }

    private fun runConfigChange(optimistic: (Session) -> Session, call: suspend () -> Unit) {
        if (!configOpPending.compareAndSet(expect = false, update = true)) return
        sessionStore.updateDetailLocal(sessionId, optimistic)
        scope.launch {
            try {
                call()
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                // Roll back by rolling forward to server truth (an SSE patch
                // may have moved other fields since the optimistic write).
                runCatching { sessionStore.loadSessionDetail(sessionId) }
                _events.tryEmit(ChatEvent.Notice(ChatNotice.ConfigUpdateFailed(error.message)))
            } finally {
                configOpPending.value = false
            }
        }
    }

    private fun buildConfigUi(
        detail: Session?,
        summary: SessionSummary?,
        catalogs: ConfigCatalogs,
    ): SessionConfigUi {
        val flavor = detail?.metadata?.flavor ?: summary?.metadata?.flavor
        val model = detail?.model
        val modelOptions: List<CatalogOption>?
        var modelOptionsLoading = false
        var effort: String? = null
        var effortOptions: List<CatalogOption>? = null
        var fastModeAvailable = false
        var variantOptions: List<CatalogOption>? = null

        when (flavor) {
            "claude" -> {
                modelOptions = ModelCatalog.claudeModelOptions(model)
                effort = detail?.effort
                effortOptions = ModelCatalog.claudeEffortOptions(effort)
            }
            "codex" -> {
                val models = catalogs.codexModels
                if (models != null) {
                    modelOptions = models.map { summaryRow ->
                        CatalogOption(
                            value = summaryRow.id,
                            label = summaryRow.displayName + if (summaryRow.isDefault) " · default" else "",
                        )
                    }
                } else {
                    modelOptions = emptyList()
                    modelOptionsLoading = catalogs.loading
                }
                // Codex efforts come from the active model's advertised list
                // (selection, else default row); presets when it advertises
                // none — the section is never hidden (web parity).
                effort = detail?.modelReasoningEffort
                effortOptions = SessionConfigSections.codexReasoningEffortOptions(
                    effort,
                    models?.let { SessionConfigSections.codexModelReasoningEfforts(it, model) },
                )
                fastModeAvailable = SessionConfigSections.advertisesFastTier(model, models)
            }
            "opencode" -> {
                modelOptions = null // Model picker stays create-form only.
                effort = detail?.modelReasoningEffort
                effortOptions = SessionConfigSections.opencodeReasoningEffortOptions(effort, catalogs.opencodeEfforts)
            }
            "grok" -> {
                modelOptions = null
                effort = detail?.effort
                effortOptions = SessionConfigSections.grokReasoningEffortOptions(catalogs.grokEfforts)
            }
            "pi" -> {
                modelOptions = null
                effort = detail?.effort
                val piModels = catalogs.piModels
                effortOptions = SessionConfigSections.piThinkingOptions(
                    effort,
                    piModels?.let {
                        SessionConfigSections.piSelectedModel(it, model, detail?.metadata?.piSelectedModel)
                    },
                )
            }
            "cursor" -> {
                modelOptions = null
                variantOptions = if (catalogs.loadedFlavor == "cursor") {
                    SessionConfigSections.cursorVariantOptions(cursorPicker(detail, catalogs))
                } else {
                    null
                }
            }
            else -> modelOptions = null // Generic fallback: hide the picker.
        }

        return SessionConfigUi(
            flavor = flavor,
            active = detail?.active ?: summary?.active ?: false,
            controlledByUser = terminalControlled(detail),
            permissionMode = detail?.permissionMode,
            permissionModes = PermissionModes.forFlavor(flavor),
            model = model,
            modelOptions = modelOptions,
            modelOptionsLoading = modelOptionsLoading,
            effort = effort,
            effortOptions = effortOptions,
            serviceTier = detail?.serviceTier,
            fastModeAvailable = fastModeAvailable,
            variantOptions = variantOptions,
        )
    }

    /** Session-sheet cursor picker: session + machine catalogs + merged CLI skus. */
    private fun cursorPicker(detail: Session?, catalogs: ConfigCatalogs): CursorModels.PickerState =
        CursorModels.buildSessionPickerState(
            sessionModels = catalogs.cursorSessionModels ?: emptyList(),
            machineModels = catalogs.cursorMachineModels ?: emptyList(),
            cliSkus = CursorModels.mergeCliSkus(
                catalogs.cursorMachineSkus ?: emptyList(),
                catalogs.cursorSessionSkus ?: emptyList(),
            ),
            sessionModel = detail?.model,
            sessionCurrentModelId = catalogs.cursorCurrentModelId,
        )

    // ------------------------------------------------------------- internals --

    private suspend fun awaitWindowStore(): MessageWindowStore =
        windowStore.filterNotNull().first()

    private fun currentDetail(): Session? =
        sessionStore.currentDetail(sessionId)

    private fun currentFlavor(): String? =
        currentDetail()?.metadata?.flavor
            ?: sessionStore.sessions.value.firstOrNull { it.id == sessionId }?.metadata?.flavor

    private class SessionLiveState(val active: Boolean, val thinking: Boolean)

    private fun currentSessionState(): SessionLiveState {
        val detail = currentDetail()
        if (detail != null) return SessionLiveState(detail.active, detail.thinking)
        val summary = sessionStore.sessions.value.firstOrNull { it.id == sessionId }
        return SessionLiveState(summary?.active ?: false, summary?.thinking ?: false)
    }

    private fun sessionStateFlow() = combine(
        sessionStore.sessionDetail(sessionId),
        summaryFlow(),
    ) { detail, summary ->
        SessionLiveState(
            active = detail?.active ?: summary?.active ?: false,
            thinking = detail?.thinking ?: summary?.thinking ?: false,
        )
    }

    private fun summaryFlow() = sessionStore.sessions
        .map { list -> list.firstOrNull { it.id == sessionId } }
        .distinctUntilChanged()

    private suspend fun restoreDraft() {
        if (draftReady.isCompleted) return
        try {
            // Durable store first; the live snapshot ring is the fallback (the
            // supersession carry writes both — a failed durable write still
            // carries in-memory, web `liveSnapshots`).
            val draft = runCatching { drafts?.load(sessionId) }.getOrNull()
                ?: draftSnapshots?.get(sessionId)?.text
            if (!draft.isNullOrEmpty() && composerText.value.isEmpty()) {
                composerText.value = draft
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // Ordinary chat remains usable when local draft storage fails.
        } finally {
            draftReady.complete(Unit)
        }
    }

    /**
     * Drafts v2 supersession carry (web `transferComposerDraft`): the whole
     * draft — text and attachment references — moves to [targetSessionId].
     *
     * - The freshest composer text is flushed into the source row first, so
     *   un-debounced keystrokes cannot be lost by the move.
     * - References keep their hub paths (absolute on the agent machine, the
     *   `resumeAndRetry` precedent) — unlike the web there is no blob to
     *   re-upload into the target session.
     * - The live snapshot is set on the target and the source retired
     *   (`markHandedOff`, the web `completedHandoffs` tombstone) so the
     *   source's exit cannot resurrect its draft or delete carried paths.
     */
    private suspend fun carryComposerDraftsTo(targetSessionId: String) {
        if (targetSessionId == sessionId) return
        val text = composerText.value
        // The tray is the live truth when it holds chips; an unrestored tray
        // (inactive session) falls back to the stored references so the carry
        // moves what the draft actually holds, not just what is on screen.
        val refs = attachments.draftRefs().ifEmpty {
            runCatching { attachmentDrafts?.load(sessionId) }.getOrNull().orEmpty()
        }
        draftJob?.cancel()
        supersededHandoff = true
        runCatching {
            drafts?.let { store ->
                if (text.isNotBlank()) store.save(sessionId, text)
                store.move(sessionId, targetSessionId)
            }
        }
        runCatching {
            attachmentDrafts?.let { store ->
                if (refs.isNotEmpty()) store.save(sessionId, refs)
                store.move(sessionId, targetSessionId)
            }
        }
        draftSnapshots?.let { snapshots ->
            snapshots.set(targetSessionId, ComposerDraftSnapshot(text = text, attachments = refs))
            snapshots.markHandedOff(sessionId)
        }
    }

    /**
     * Drafts v2 restore + persist observer, started after [loadDetail]
     * (activity decides the restore, the web contract):
     *
     * - Active session: restore stored references as Ready chips (the live
     *   snapshot backs the store). An inactive session restores text only —
     *   references stay stored untouched, like the web's IDB row.
     * - Every settled tray change persists the current references and
     *   refreshes the live snapshot. An empty tray persists only after this
     *   screen observed a Ready chip (skipped restores and untouched trays
     *   must not erase stored references); a handed-off source persists
     *   nothing.
     */
    private suspend fun observeAttachmentDrafts() {
        val store = attachmentDrafts ?: return
        if (currentSessionState().active) {
            val stored = runCatching { store.load(sessionId) }.getOrDefault(emptyList())
            val refs = stored.ifEmpty { draftSnapshots?.get(sessionId)?.attachments.orEmpty() }
            if (refs.isNotEmpty()) attachments.restoreDraftAttachments(refs)
        }
        var lastFingerprint: String? = null
        attachments.items.collect { items ->
            val fingerprint = items.joinToString("|") { "${it.id}:${it.status.name}" }
            if (fingerprint == lastFingerprint) return@collect
            lastFingerprint = fingerprint
            if (items.any { it.status == ComposerAttachmentStatus.Ready }) {
                traySawReadyChip = true
            }
            if (supersededHandoff || !traySawReadyChip) return@collect
            val refs = attachments.draftRefs()
            draftSnapshots?.set(sessionId, ComposerDraftSnapshot(composerText.value, refs))
            runCatching { store.save(sessionId, refs) }
        }
    }

    private fun pipelineInputs(values: Array<Any?>): PipelineInputs {
        @Suppress("UNCHECKED_CAST")
        return PipelineInputs(
            window = values[0] as MessageWindowState,
            detail = values[1] as Session?,
            summary = values[2] as SessionSummary?,
            machines = values[3] as List<Machine>,
            detailLoadFailed = values[4] as Boolean,
            permissionOverrides = values[5] as Map<String, PermissionRowOverride>,
        )
    }

    // ------------------------------------------------------------- pipeline --

    private fun initialState() = ChatUiState(
        sessionId = sessionId,
        header = ChatHeaderUi(title = sessionId.take(8), subtitle = null, active = false, thinking = false),
        flavor = null,
        basePath = null,
        blocks = emptyList(),
        permissionOverrides = emptyMap(),
        hasMore = false,
        isLoadingOlder = false,
        isSyncingTail = true,
        isInitialLoading = true,
        loadFailed = false,
        warning = null,
        tailRevision = 0,
    )

    private fun buildUiState(inputs: PipelineInputs): ChatUiState {
        val window = inputs.window

        // Queued-not-yet-invoked rows belong to the composer bar, not the
        // thread — shared predicate with the window store, like the web.
        val visibleMessages = window.messages.filter { !it.isQueuedForInvocation }

        val normalized = ArrayList<NormalizedMessage>(visibleMessages.size)
        val seen = HashSet<String>(visibleMessages.size * 2)
        for (message in visibleMessages) {
            if (!seen.add(message.id)) continue
            val cached = normalizeCache[message.id]
            if (cached != null && cached.source === message) {
                cached.normalized?.let(normalized::add)
                continue
            }
            // Re-attach the window row's client-side status after normalizing
            // the bare wire (web parity: `normalize.ts` copies `message.status`
            // onto the normalized row). Without this, failed sends never render
            // as failed and tap-to-retry can't trigger. Memo-safe: status
            // changes always allocate a new row instance (B-M2c contract).
            val bare = normalizeDecryptedMessage(message.wire)
            val rowStatus = message.status
            val next = if (bare is NormalizedMessage.User && rowStatus != null) {
                bare.copy(status = rowStatus.wire)
            } else {
                bare
            }
            normalizeCache[message.id] = NormalizeCacheEntry(message, next)
            next?.let(normalized::add)
        }
        normalizeCache.keys.retainAll(seen)

        val agentState = inputs.detail?.agentState
        val reduced = reduceChatBlocks(normalized, agentState)
        val visibleBlocks = buildVisibleChatBlocks(
            reduced.blocks,
            ToolGroupingOptions(hasMoreMessages = window.hasMore, previousGroups = previousGroups),
        )
        previousGroups = visibleBlocks.filterIsInstance<ToolGroupBlock>()
        inspection.update(visibleBlocks, window.epoch)
        val sources = visibleBlocks.mapNotNull { block ->
            when (block) {
                is AgentTextBlock -> block.text
                is AgentReasoningBlock -> block.text
                is ToolCallBlock -> planProposalMarkdown(block.tool)
                else -> null
            }
        }.toSet()
        // buildUiState runs on pipelineDispatcher, before these rows reach UI.
        markdownCache.prepare(sources - previousMarkdownSources)
        previousMarkdownSources = sources

        prunePermissionOverrides(agentState, inputs.permissionOverrides)

        val isEmpty = visibleBlocks.isEmpty()
        // syncGeneration 0 = no tail sync has even begun (the moment between
        // open and syncTail) — still "loading", never a flash of empty state.
        val syncSettled = !window.isSyncingTail && window.syncGeneration > 0
        return ChatUiState(
            sessionId = sessionId,
            header = buildHeader(inputs),
            flavor = inputs.detail?.metadata?.flavor ?: inputs.summary?.metadata?.flavor,
            basePath = inputs.detail?.metadata?.path ?: inputs.summary?.metadata?.path,
            blocks = transcriptProjection.project(visibleBlocks),
            processSteps = visibleBlocks.filterIsInstance<ToolCallBlock>().filter(::opensToolProcess)
                .associate { it.id to it.children.size },
            permissionOverrides = inputs.permissionOverrides,
            hasMore = window.hasMore,
            isLoadingOlder = window.isLoadingMore,
            isSyncingTail = window.isSyncingTail,
            isInitialLoading = isEmpty && !syncSettled && window.warning == null,
            loadFailed = isEmpty && syncSettled &&
                (window.warning != null || inputs.detailLoadFailed),
            warning = window.warning,
            tailRevision = window.tailRevision,
            historyVersion = window.historyVersion,
            messagesVersion = window.messagesVersion,
            requiresLatestReset = window.requiresLatestReset,
        )
    }

    /** A settled request (gone from `agentState.requests`) drops its override. */
    private fun prunePermissionOverrides(
        agentState: AgentState?,
        overrides: Map<String, PermissionRowOverride>,
    ) {
        if (overrides.isEmpty()) return
        // A missing agentState means the detail is (re)loading, not that the
        // requests settled — never prune on absence of evidence.
        if (agentState == null) return
        val pendingIds = agentState.requests?.keys ?: emptySet()
        val stale = overrides.keys.filter { it !in pendingIds }
        if (stale.isEmpty()) return
        permissionOverrides.update { current -> current - stale.toSet() }
    }

    private fun buildHeader(inputs: PipelineInputs): ChatHeaderUi {
        val detail = inputs.detail
        val summary = inputs.summary

        // Detail first — the fresher source once loaded (this pipe patches it
        // live); a detail without usable metadata falls through to the list
        // summary, then to the id prefix (`getSessionTitle` cascade).
        val title = detail?.let(::detailTitle)
            ?: summary?.let(SessionListViewModel::sessionTitle)
            ?: sessionId.take(8)

        val flavor = detail?.metadata?.flavor ?: summary?.metadata?.flavor
        val machineId = detail?.metadata?.machineId ?: summary?.metadata?.machineId
        val machineLabel = machineId?.let { id ->
            val metadata = inputs.machines.firstOrNull { it.id == id }?.metadata
            metadata?.displayName?.takeIf { it.isNotBlank() } ?: metadata?.host ?: id.take(8)
        }
        val worktree = (detail?.metadata?.worktree ?: summary?.metadata?.worktree)
            ?.let { it.name.ifBlank { it.branch } }
        val subtitle = listOfNotNull(flavor?.let(Flavors::label), machineLabel, worktree)
            .takeIf { it.isNotEmpty() }
            ?.joinToString(" · ")

        return ChatHeaderUi(
            title = title,
            subtitle = subtitle,
            flavor = flavor,
            name = detail?.metadata?.name ?: summary?.metadata?.name,
            active = detail?.active ?: summary?.active ?: false,
            thinking = detail?.thinking ?: summary?.thinking ?: false,
        )
    }

    /** Detail title cascade; null when the metadata carries nothing usable. */
    private fun detailTitle(detail: Session): String? {
        val metadata = detail.metadata ?: return null
        metadata.name?.takeIf { it.isNotEmpty() }?.let { return it }
        metadata.summary?.text?.takeIf { it.isNotEmpty() }?.let { return it }
        return metadata.path.split('/').lastOrNull { it.isNotEmpty() }
    }

    private companion object {
        /** Web-equivalent render batching for the pipeline (the "sample(100ms)"). */
        const val PIPELINE_INTERVAL_MS: Long = 100

        const val DRAFT_SAVE_DEBOUNCE_MS: Long = 300

        fun Exception.isSessionInactive(): Boolean =
            this is ApiError && status == 409 && code == "session_inactive"

        /**
         * Codex-style approval UX (`PermissionFooter.isCodexSession`): codex
         * family or cursor flavor, or a codex-dialect tool name.
         */
        fun isCodexPermissionUx(flavor: String?, toolName: String?): Boolean =
            Flavors.isCodexFamily(flavor) ||
                flavor == "cursor" ||
                toolName?.let { name ->
                    name.startsWith("Codex") || name.startsWith("Gemini") ||
                        name.startsWith("OpenCode") || name.startsWith("Copilot") ||
                        name.startsWith("Cursor")
                } == true
    }
}

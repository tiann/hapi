package app.hapi.companion.feature.newsession

import app.hapi.protocol.wire.CodexDesktopSyncRequest
import app.hapi.protocol.wire.CodexLocalSessionSummary
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Strings the codex-import flow needs at runtime (B-M5a Strings seam):
 * defaults are English; the Navigation holder resolves resources per locale.
 * Web refs: `codexSync.failed.body`, `codexSync.failed.bodyWithReason`,
 * `codexSync.error.timeout`, `codexSync.error.active`.
 */
class CodexImportStrings(
    /** Load + soft-failure fallback (`codexSync.failed.body`). */
    val loadFailed: String = "Failed to import Codex sessions.",
    /** `%1$s` = failure detail (`codexSync.failed.bodyWithReason`). */
    val importFailedReason: String = "Import failed: %1\$s",
    /** `codexSync.error.timeout` (matched via [CodexImportController.TIMEOUT_PATTERN]). */
    val timeout: String = "Operation timed out",
    /** `codexSync.error.active` (matched via [CodexImportController.ACTIVE_PATTERN]). */
    val sessionActive: String = "This session is still active. Please wait until it ends and try again.",
    /**
     * Import-at-create outer-catch fallback. Web hardcodes the untranslated
     * literal `'Failed to create session'`; Android already localizes that
     * literal for the create form (`new_session_error_create`), so it rides
     * the same key.
     */
    val createFailed: String = "Failed to create session",
)

/**
 * Dialog + inline-section state for the codex import (slice A). `error` is
 * the load error shown on the inline section (web `codexImportError`);
 * `importError` is a failed bulk import shown inside the still-open dialog
 * (web surfaces it as a toast — divergence, see controller docs).
 */
data class CodexImportUiState(
    val open: Boolean = false,
    val loading: Boolean = false,
    val sessions: List<CodexLocalSessionSummary> = emptyList(),
    val error: String? = null,
    val importError: String? = null,
    /** Inline (create-with-history) selection; web `selectedCodexImportSessionId`. */
    val selectedSessionId: String? = null,
    /** Machine the sessions were listed from; web `codexImportMachineId`. */
    val machineId: String? = null,
    /** Dialog checkboxes, insertion-ordered (web `selectedSessionIds`). */
    val dialogSelection: Set<String> = emptySet(),
    val workdirFilter: String = CodexImportLogic.ALL_WORKDIR_FILTER,
    val searchQuery: String = "",
    /** Bulk import in flight (web `isBulkImportingCodexSessions`). */
    val importing: Boolean = false,
    /** Single import-at-create in flight (web `isImportingCodexSession`). */
    val importingAtCreate: Boolean = false,
    /** Imported markers, for the badge + default-check rule. */
    val importedMarkers: Map<String, Long> = emptyMap(),
) {
    val selectedSession: CodexLocalSessionSummary?
        get() = selectedSessionId?.let { id -> sessions.firstOrNull { it.id == id } }
}

/** Outcome of the import-at-create chain (sync → resume). */
sealed interface CodexImportAtCreateResult {
    /** [resumedSessionId] is what navigation should open. */
    data class Imported(val resumedSessionId: String) : CodexImportAtCreateResult

    /** [rawError] is shown as the form's create error, un-normalized (web parity). */
    data class Failed(val rawError: String) : CodexImportAtCreateResult
}

/**
 * Controller for the codex session-import flow (slice A): owns the list
 * dialog state, the inline section's selection, and the two import paths
 * (bulk from the dialog, single during Create). Web refs:
 * `web/src/components/CodexSessionSyncDialog.tsx` (dialog state machine) and
 * the codex-import branches of `web/src/components/NewSession/index.tsx`
 * (`loadCodexImportSessions`, `handleBulkImportCodexSessions`,
 * `handleSelectCodexImportSession`, `handleCreate`).
 *
 * Faithful behaviors:
 * - `GET /api/codex/sessions` soft failures are silent: HTTP 200 +
 *   `success:false` decodes to `sessions:[]` with **no** error (web never
 *   checks `success` on this call); only a thrown network/API error sets
 *   [CodexImportUiState.error] and clears the machine + inline selection.
 * - Dialog-local state (checkboxes, filters, flags) resets on both the open
 *   and the close edge (web `wasOpenRef` effect).
 * - The workdir filter initializes **once, only after a non-empty list
 *   arrives** (web defers it so the current directory is among the options);
 *   a filter whose directory disappears from the list falls back to the
 *   default. Checkbox init waits for the first `!isLoading` moment and
 *   default-checks the inline selection when it is in the list and not yet
 *   imported.
 * - Confirm with exactly one checked row = inline select (+ apply that
 *   session's cwd to the form directory); more = bulk import. Bulk failure
 *   keeps the dialog open with selections intact.
 *
 * Declared Android divergences (web behavior in parens):
 * - bulk-import success has no toast and no session-list refetch (web toasts
 *   "Import complete" and refetches); the dialog simply closes and the list
 *   screen refreshes on next entry.
 * - bulk-import failure shows [CodexImportUiState.importError] inside the
 *   still-open dialog (web toasts; Android's create form has no toast host),
 *   and the normalize fallback for an exception with no message reuses
 *   [CodexImportStrings.loadFailed] (web uses `dialog.error.default`).
 * - the import-at-create error is raw, exactly like web's `setError` (no
 *   timeout/active classification there either).
 * - duplicate-detection/merge and the restart/archive affordances are
 *   slices B/C and absent; launcher-not-found errors therefore pass through
 *   raw (web classifies them to `codexSync.restart.failed.notFound`).
 */
class CodexImportController(
    private val scope: CoroutineScope,
    private val gateway: NewSessionGateway,
    private val store: CodexImportedSessionsStore,
    private val strings: CodexImportStrings = CodexImportStrings(),
    /** Applies a session cwd to the form directory (web `setDirectory(session.cwd.trim())`). */
    private val applyDirectory: (String) -> Unit = {},
) {
    private val mutable = MutableStateFlow(CodexImportUiState())
    val state: StateFlow<CodexImportUiState> = mutable.asStateFlow()

    /** Directory/machine snapshots from the latest open/load (web reads form state). */
    private var currentDirectory: String = ""
    private var formMachineId: String = ""

    private var hasInitializedSelection = false
    private var hasInitializedWorkdirFilter = false
    private var loadJob: Job? = null

    init {
        scope.launch {
            store.markers.collect { markers ->
                update { it.copy(importedMarkers = markers) }
            }
        }
    }

    // ------------------------------------------------------------ actions --

    /**
     * Opens the dialog and loads sessions for the current form context
     * (web `onChooseHistory`: `setIsCodexImportDialogOpen(true)` +
     * `loadCodexImportSessions()`). The open edge resets dialog-local state.
     */
    fun openDialog(directory: String, machineId: String) {
        resetDialogFields()
        update { it.copy(open = true) }
        load(directory, machineId)
    }

    /** Close edge: dialog-local state resets (web `wasOpenRef` block). */
    fun close() {
        resetDialogFields()
        update { it.copy(open = false) }
    }

    /**
     * `loadCodexImportSessions`: **no `success` check** — a 200 + `success:false`
     * body yields its empty `sessions` silently. Machine id is backfilled from
     * the response when present. The inline selection survives only while its
     * session is still in the list. A thrown error clears everything and sets
     * [CodexImportUiState.error].
     */
    fun load(directory: String, machineId: String) {
        currentDirectory = directory
        formMachineId = machineId
        loadJob?.cancel()
        loadJob = scope.launch {
            update { it.copy(loading = true, error = null) }
            val applied = try {
                val result = gateway.getCodexSessions(directory.trim().ifEmpty { null }, machineId)
                update { current ->
                    current.copy(
                        sessions = result.sessions,
                        machineId = result.machineId ?: machineId,
                        selectedSessionId = current.selectedSessionId
                            ?.takeIf { id -> result.sessions.any { it.id == id } },
                    )
                }
                true
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                update {
                    it.copy(
                        sessions = emptyList(),
                        machineId = null,
                        selectedSessionId = null,
                        error = error.message ?: strings.loadFailed,
                    )
                }
                false
            } finally {
                update { it.copy(loading = false) }
            }
            if (applied) applyDialogInitializations()
        }
    }

    /** Checkbox toggle, blocked while busy (web `toggleSession`, multiple mode). */
    fun toggleSession(sessionId: String) {
        val current = state.value
        if (current.importing || current.loading) return
        update {
            it.copy(
                dialogSelection = if (sessionId in it.dialogSelection) {
                    it.dialogSelection - sessionId
                } else {
                    it.dialogSelection + sessionId
                },
            )
        }
    }

    /** Checks exactly the filtered rows (web `selectAll` replaces, no union). */
    fun selectAll() {
        val current = state.value
        val filtered = CodexImportLogic.filterSessions(current.sessions, current.workdirFilter, current.searchQuery)
        update { it.copy(dialogSelection = LinkedHashSet(filtered.map { it.id })) }
    }

    fun clearSelection() {
        update { it.copy(dialogSelection = emptySet()) }
    }

    fun setWorkdirFilter(filter: String) {
        update { it.copy(workdirFilter = filter) }
    }

    fun setSearchQuery(query: String) {
        update { it.copy(searchQuery = query) }
    }

    /**
     * Dialog Confirm (web `onConfirm` wiring in the create form): one checked
     * row selects it inline (and applies its cwd to the form directory), then
     * the dialog closes; more than one runs the bulk import (which closes the
     * dialog only on success).
     */
    fun confirm() {
        val current = state.value
        val checked = current.dialogSelection.toList()
        if (checked.size == 1) {
            current.sessions.firstOrNull { it.id == checked[0] }?.let(::selectInline)
            close()
            return
        }
        bulkImport(checked)
    }

    /**
     * `handleBulkImportCodexSessions`: `POST /codex/sync-session` with the
     * whole checked batch; on success marks the batch imported, clears the
     * inline selection only when it was part of the batch, and closes the
     * dialog. On failure the dialog stays open with the normalized error.
     * `cwd`/`machineId` mirror the web payload: trimmed form directory, and
     * the listing machine with the form machine as fallback.
     */
    fun bulkImport(sessionIds: List<String>) {
        val current = state.value
        if (current.importing || current.loading || sessionIds.isEmpty()) return
        val requestMachineId = current.machineId ?: formMachineId.ifEmpty { null }
        update { it.copy(importing = true) }
        scope.launch {
            try {
                val result = gateway.syncCodexSession(
                    CodexDesktopSyncRequest(
                        sessionIds = sessionIds,
                        cwd = currentDirectory.trim().ifEmpty { null },
                        machineId = requestMachineId,
                    ),
                )
                if (!result.success) {
                    throw IllegalStateException(normalizeError(result.error, strings.loadFailed))
                }
                store.markImported(sessionIds)
                val keepSelection = CodexImportLogic.clearBatchImportedCodexSelection(
                    state.value.selectedSessionId,
                    sessionIds,
                )
                resetDialogFields()
                update { it.copy(open = false, selectedSessionId = keepSelection) }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                // Web toasts the normalized failure; Android shows it in-dialog
                // (declared divergence). Blank-message fallback reuses
                // loadFailed (web: dialog.error.default — no Android twin).
                val reason = normalizeError(error.message, strings.loadFailed)
                update { it.copy(importError = formatFailure(reason)) }
            } finally {
                update { it.copy(importing = false) }
            }
        }
    }

    /** `handleSelectCodexImportSession`: select inline + adopt the session's cwd. */
    fun selectInline(session: CodexLocalSessionSummary) {
        update { it.copy(selectedSessionId = session.id) }
        CodexImportLogic.cwdOf(session)?.let(applyDirectory)
    }

    /** The inline section's Clear button. */
    fun clearInlineSelection() {
        update { it.copy(selectedSessionId = null) }
    }

    /**
     * Agent switched away from codex (web effect on `agent !== 'codex'`):
     * close the dialog, cancel the in-flight load, drop list + selection.
     */
    fun resetForAgentChange() {
        loadJob?.cancel()
        resetDialogFields()
        update {
            it.copy(
                open = false,
                loading = false,
                sessions = emptyList(),
                machineId = null,
                selectedSessionId = null,
                error = null,
            )
        }
    }

    /**
     * Machine (or other form context) changed (web `handleMachineChange`):
     * same clear minus the dialog close — the dialog cannot be open while
     * the machine picker is interactive.
     */
    fun resetForContextChange() {
        loadJob?.cancel()
        update {
            it.copy(
                loading = false,
                sessions = emptyList(),
                machineId = null,
                selectedSessionId = null,
                error = null,
            )
        }
    }

    /**
     * The codex-import branch of web `handleCreate`: sync the inline-selected
     * session, then immediately `resume` the created Hapi record (the import
     * only creates the row — it does not start the agent; resuming avoids a
     * dead-looking first frame). `permissionMode` travels to the resume call
     * only when the form selected one (`'default'` omits it). Failures come
     * back **raw** (web `setError(result.error || result.message || …)` and
     * the outer `catch (e) → e.message || 'Failed to create session'`).
     */
    suspend fun importAtCreate(
        request: CodexDesktopSyncRequest,
        permissionMode: String,
    ): CodexImportAtCreateResult {
        update { it.copy(importingAtCreate = true) }
        return try {
            val result = gateway.syncCodexSession(request)
            if (!result.success) {
                CodexImportAtCreateResult.Failed(result.error ?: result.message ?: strings.loadFailed)
            } else {
                val importedSessionId = result.hapiSessionIds?.firstOrNull()
                    ?: throw IllegalStateException("Imported session id missing")
                val resumed = gateway.resumeSession(
                    importedSessionId,
                    permissionMode.takeIf { it != "default" },
                )
                store.markImported(request.sessionIds)
                CodexImportAtCreateResult.Imported(resumed.sessionId)
            }
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Exception) {
            CodexImportAtCreateResult.Failed(error.message ?: strings.createFailed)
        } finally {
            update { it.copy(importingAtCreate = false) }
        }
    }

    // ---------------------------------------------------------- internals --

    /** Web's untranslated outer-catch literal — deliberately not localized. */
    private fun normalizeError(message: String?, fallback: String): String {
        val raw = message?.trim().orEmpty()
        if (raw.isEmpty()) return fallback
        if (TIMEOUT_PATTERN.containsMatchIn(raw)) return strings.timeout
        if (ACTIVE_PATTERN.containsMatchIn(raw)) return strings.sessionActive
        // Web also classifies "codex launcher not found" here; that strings
        // key belongs to the restart feature (slice C) — raw passthrough.
        return raw
    }

    private fun formatFailure(reason: String): String =
        if (reason == strings.timeout || reason == strings.sessionActive) {
            reason
        } else {
            strings.importFailedReason.format(reason)
        }

    /**
     * The dialog's one-time init effects, run after a load settles:
     * workdir-filter init (only with a non-empty list) + invalid-filter
     * fallback + checkbox init (default-check the inline selection when in
     * the list and not imported).
     */
    private fun applyDialogInitializations() {
        val current = state.value
        if (!current.open) return
        val options = CodexImportLogic.workdirOptions(current.sessions)
        val default = CodexImportLogic.defaultWorkdirFilter(current.sessions, currentDirectory)
        if (!hasInitializedWorkdirFilter && current.sessions.isNotEmpty()) {
            hasInitializedWorkdirFilter = true
            update { it.copy(workdirFilter = default) }
        } else if (current.workdirFilter != CodexImportLogic.ALL_WORKDIR_FILTER &&
            current.workdirFilter !in options
        ) {
            update { it.copy(workdirFilter = default) }
        }
        if (!hasInitializedSelection) {
            hasInitializedSelection = true
            val defaultSelected = current.selectedSessionId
                ?.takeIf { id -> current.sessions.any { it.id == id } && current.importedMarkers[id] == null }
            update { it.copy(dialogSelection = defaultSelected?.let { setOf(it) } ?: emptySet()) }
        }
    }

    private fun resetDialogFields() {
        hasInitializedSelection = false
        hasInitializedWorkdirFilter = false
        update {
            it.copy(
                dialogSelection = emptySet(),
                workdirFilter = CodexImportLogic.ALL_WORKDIR_FILTER,
                searchQuery = "",
                importError = null,
            )
        }
    }

    private fun update(transform: (CodexImportUiState) -> CodexImportUiState) {
        mutable.value = transform(mutable.value)
    }

    companion object {
        /** `normalizeCodexScriptError` timeout pattern (`/i`). */
        val TIMEOUT_PATTERN: Regex =
            Regex("""执行超时|timed\s*out|timeout""", RegexOption.IGNORE_CASE)

        /** `normalizeCodexScriptError` active-thread pattern (`/i`). */
        val ACTIVE_PATTERN: Regex =
            Regex("""当前会话仍处于活跃状态，请等待会话结束后重试|Active Hapi process already has this Codex thread""", RegexOption.IGNORE_CASE)
    }
}

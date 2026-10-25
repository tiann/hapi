package app.hapi.companion.feature.newsession

import app.hapi.protocol.wire.PiImportSessionsRequest
import app.hapi.protocol.wire.PiLocalSessionSummary
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Strings the pi-import flow needs at runtime (Strings seam; defaults are
 * English, the Navigation holder resolves resources per locale). Web refs:
 * `piImport.failed.body`, `piImport.error.diverged`, `piImport.error.active`,
 * `piImport.success.title/body`, `piImport.failed.title/partial` (slice C).
 */
class PiImportStrings(
    /** Load + soft-failure fallback (`piImport.failed.body`). */
    val loadFailed: String = "Failed to import Pi history.",
    /** `piImport.error.diverged` — mapped from code `transcript_diverged`. */
    val errorDiverged: String =
        "The local Pi branch changed after the previous import. Review the session before continuing.",
    /** `piImport.error.active` — mapped from code `session_active`. */
    val errorActive: String =
        "Stop the active Hapi Pi session before importing newer native history.",
    /** `piImport.success.title` (web toast title; inline notice here). */
    val successTitle: String = "Pi sessions imported",
    /** `piImport.success.body` for one imported session. */
    val successBodyOne: String = "Imported 1 Pi session.",
    /** `%1$d` = imported count (`piImport.success.body`). */
    val successBodyMany: String = "Imported %1\$d Pi sessions.",
    /** `piImport.failed.title` (web toast title; inline notice here). */
    val failedTitle: String = "Pi import failed",
    /** `%1$d` = failed count, `%2$s` = reason (`piImport.failed.partial`). */
    val failedPartial: String = "%1\$d sessions failed: %2\$s",
    /**
     * Import-at-create outer-catch fallback. Web hardcodes the untranslated
     * `'Failed to create session'`; Android already localizes that literal
     * for the create form (`new_session_error_create`), so it rides the same
     * key (same call as the codex slice).
     */
    val createFailed: String = "Failed to create session",
)

/**
 * Pure helpers for the pi import (slice C) — web twins live in
 * `PiSessionImportDialog.tsx` (filtering) and `NewSession/index.tsx`
 * (`formatPiImportError`, the import-at-create payload).
 */
internal object PiImportLogic {
    /** Web `ALL_DIRECTORIES = '__all__'`. */
    const val ALL_DIRECTORIES = "__all__"

    /** Web `directories`: deduped **trimmed** cwds, sorted. */
    fun directoryOptions(sessions: List<PiLocalSessionSummary>): List<String> =
        sessions.mapNotNull { session -> session.cwd?.trim()?.takeIf { it.isNotEmpty() } }
            .distinct()
            .sorted()

    /**
     * Web filter compares the **raw** session cwd against the (trimmed)
     * directory option — a session with a padded cwd never matches its
     * trimmed directory. That quirk is preserved verbatim.
     */
    fun matchesDirectory(session: PiLocalSessionSummary, directory: String): Boolean =
        directory == ALL_DIRECTORIES || session.cwd == directory

    /** Web query: case-insensitive contains over title/prompt/cwd/id/model. */
    fun matchesQuery(session: PiLocalSessionSummary, query: String): Boolean {
        val normalized = query.trim().lowercase()
        if (normalized.isEmpty()) return true
        return listOfNotNull(
            session.title,
            session.lastUserMessage,
            session.cwd,
            session.id,
            session.model,
        ).any { value -> value.lowercase().contains(normalized) }
    }

    fun filterSessions(
        sessions: List<PiLocalSessionSummary>,
        directory: String,
        query: String,
    ): List<PiLocalSessionSummary> = sessions.filter { session ->
        matchesDirectory(session, directory) && matchesQuery(session, query)
    }

    /** Non-blank trimmed cwd, for adopting a session's directory into the form. */
    fun cwdOf(session: PiLocalSessionSummary): String? =
        session.cwd?.trim()?.takeIf { it.isNotEmpty() }

    /** Row second line: `lastUserMessage ?? cwd ?? id` (web `??` chain). */
    fun previewOf(session: PiLocalSessionSummary): String =
        session.lastUserMessage ?: session.cwd ?: session.id

    /**
     * Web `formatPiImportError(code?, message?)`: map the two known codes to
     * friendly text, else the trimmed message, else `piImport.failed.body`.
     */
    fun formatError(code: String?, message: String?, strings: PiImportStrings): String = when (code) {
        "transcript_diverged" -> strings.errorDiverged
        "session_active" -> strings.errorActive
        else -> message?.trim()?.takeIf { it.isNotEmpty() } ?: strings.loadFailed
    }

    /**
     * The pi import-at-create payload (web `handleCreate` pi branch):
     * `cwd: selected.cwd ?? trimmedDirectory` — the session's **raw** cwd
     * wins, only null falls back to the form directory; machine id is the
     * listing machine with the form machine as fallback.
     */
    fun buildSingleImportRequest(
        form: NewSessionForm,
        selected: PiLocalSessionSummary,
        formMachineId: String,
        importMachineId: String?,
    ): PiImportSessionsRequest = PiImportSessionsRequest(
        sessionIds = listOf(selected.id),
        cwd = selected.cwd ?: form.trimmedDirectory.ifEmpty { null },
        machineId = importMachineId ?: formMachineId,
    )
}

/**
 * Dialog + inline-section state for the pi import (slice C). `error` is the
 * scan error shown on the inline section (web `piImportError`); the import
 * outcomes are inline notices (web toasts — divergence, see controller docs).
 */
data class PiImportUiState(
    val open: Boolean = false,
    val loading: Boolean = false,
    val sessions: List<PiLocalSessionSummary> = emptyList(),
    /** Machine the sessions were listed from; web `piImportMachineId`. */
    val machineId: String? = null,
    /** Inline (continue-now) selection; web `selectedPiImportSessionId`. */
    val selectedSessionId: String? = null,
    val error: String? = null,
    /** Dialog checkboxes; web dialog `selectedIds`. */
    val dialogSelection: Set<String> = emptySet(),
    /** Directory filter: raw cwd or [PiImportLogic.ALL_DIRECTORIES]. */
    val directoryFilter: String = PiImportLogic.ALL_DIRECTORIES,
    val searchQuery: String = "",
    /** Bulk import in flight (web `isBulkImportingPiSessions`). */
    val importing: Boolean = false,
    /** Single import-at-create in flight (web `isImportingPiSession`). */
    val importingAtCreate: Boolean = false,
    /** Web success toast (`piImport.success.*`) — inline in the dialog. */
    val successNotice: String? = null,
    /** Web failure toast (`piImport.failed.*`) — inline in the dialog. */
    val failedNotice: String? = null,
) {
    val selectedSession: PiLocalSessionSummary?
        get() = selectedSessionId?.let { id -> sessions.firstOrNull { it.id == id } }
}

/** Outcome of the import-at-create chain (import → reopen). */
sealed interface PiImportAtCreateResult {
    /** [sessionId] is the reopened id navigation should open. */
    data class Imported(val sessionId: String) : PiImportAtCreateResult

    /** [rawError] is shown as the form's create error. */
    data class Failed(val rawError: String) : PiImportAtCreateResult
}

/**
 * Controller for the pi session-import flow (slice C): owns the list dialog
 * state, the inline section's selection, the two import paths (bulk from the
 * dialog, single continue-now during Create), and the scan's generation
 * guard. Web refs: `web/src/components/PiSessionImportDialog.tsx` (dialog
 * state machine) and the pi branches of
 * `web/src/components/NewSession/index.tsx` (`loadPiImportSessions`,
 * `handleBulkImportPiSessions`, `handleSelectPiImportSession`,
 * `handleCreate`, the `piLoadGenerationRef` effects).
 *
 * Faithful behaviors:
 * - The scan **does** check the envelope: HTTP 200 + `success:false` throws
 *   into [PiImportUiState.error] and clears sessions/machine/selection (the
 *   codex twin silently renders the empty list — that asymmetry is web
 *   behavior, not a divergence).
 * - Stale scans are dropped by a generation counter (web
 *   `piLoadGenerationRef`): every load and every agent/machine reset bumps
 *   it, and a reply with an old generation never touches state.
 * - The dialog's init is the web's weak effect, deliberately: it re-applies
 *   on the open edge and after every settled scan (the web effect re-runs on
 *   any `directories` change), resetting checkboxes to exactly the inline
 *   selection, the directory filter to the form cwd when present in the
 *   options (else all), and clearing the query — no one-shot "wait for load"
 *   flags like the codex dialog has.
 * - Confirm with exactly one checked row = inline select (adopting that
 *   session's cwd into the form directory) + close; the row missing from
 *   the list leaves the dialog open (web returns without closing). More
 *   than one = bulk import.
 * - Bulk import scores the batch from `results` alone (`hapiSessionId` and
 *   no `error`) — the envelope's `success` flag is not consulted (web
 *   parity; a `success:false` envelope with good rows still counts them).
 *   Any success emits the success notice, refreshes the session list and
 *   re-pulls the scan; a partial failure additionally emits the
 *   first-failure notice and **keeps the dialog open**; an all-success
 *   batch closes the dialog and clears the inline selection. A thrown
 *   error keeps the dialog open with the failure notice.
 * - Import-at-create: `POST /api/pi/import-sessions` with the single
 *   selection, then `POST /api/sessions/:id/reopen` on the created Hapi id
 *   (pi history reopens as-is; no resume/permission forwarding, no imported
 *   markers). A per-item error maps through
 *   [PiImportLogic.formatError]; a missing Hapi id falls back to the
 *   envelope error, else `piImport.failed.body`.
 *
 * Declared Android divergences (web behavior in parens):
 * - bulk-import outcomes are inline notices in the dialog
 *   ([PiImportUiState.successNotice]/[PiImportUiState.failedNotice]); web
 *   toasts them globally (the create form has no toast host on Android).
 * - the session-list refresh after a successful bulk import is a hook
 *   ([refreshSessions]) that production leaves as a no-op — this screen
 *   does not own the session list (web `await refetchSessions()` on the
 *   parent); the list refreshes on next entry, same call as the codex slice.
 * - switching the agent away from pi clears list/machine/selection here;
 *   web only bumps the generation and leaves the (now invisible) state.
 */
class PiImportController(
    private val scope: CoroutineScope,
    private val gateway: NewSessionGateway,
    private val strings: PiImportStrings = PiImportStrings(),
    /** Applies a session cwd to the form directory (web `setDirectory`). */
    private val applyDirectory: (String) -> Unit = {},
    /** Session-list refresh after a successful bulk import (web `refetchSessions`). */
    private val refreshSessions: () -> Unit = {},
) {
    private val mutable = MutableStateFlow(PiImportUiState())
    val state: StateFlow<PiImportUiState> = mutable.asStateFlow()

    /** Directory/machine snapshots from the latest open/load (web reads form state). */
    private var currentDirectory: String = ""
    private var formMachineId: String = ""

    /** Web `piLoadGenerationRef` — stale replies never touch state. */
    private var loadGeneration = 0
    private var loadJob: Job? = null

    // ------------------------------------------------------------ actions --

    /**
     * Opens the dialog and scans for the current form context (web
     * `onChooseHistory`: `setIsPiImportDialogOpen(true)` +
     * `loadPiImportSessions()`). The open edge re-applies the dialog init
     * with whatever is known; the arriving scan re-applies it again (the
     * web weak effect).
     */
    fun openDialog(directory: String, machineId: String) {
        update { it.copy(open = true, successNotice = null, failedNotice = null) }
        applyDialogInitializations()
        load(directory, machineId)
    }

    /**
     * Close edge — dialog-local fields intentionally survive (web has no
     * close-edge reset; the open edge re-inits). Notices clear on the next
     * open like expired toasts would.
     */
    fun close() {
        update { it.copy(open = false) }
    }

    /**
     * `loadPiImportSessions`: no-op policy aside, **`success:false` throws**
     * (web checks the flag — the codex twin does not). Machine id is
     * backfilled from the response when present; the inline selection
     * survives only while its session is still in the list; a settled scan
     * re-applies the dialog init while the dialog is open.
     */
    fun load(directory: String, machineId: String) {
        currentDirectory = directory
        formMachineId = machineId
        loadJob?.cancel()
        val generation = ++loadGeneration
        loadJob = scope.launch { performLoad(directory, machineId, generation) }
    }

    /** Checkbox toggle, blocked while busy (web `toggle`). */
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

    /** Checks exactly the filtered rows (web SelectAll replaces, no union). */
    fun selectAll() {
        val current = state.value
        if (current.importing) return
        val filtered = PiImportLogic.filterSessions(current.sessions, current.directoryFilter, current.searchQuery)
        if (filtered.isEmpty()) return
        update { it.copy(dialogSelection = LinkedHashSet(filtered.map { it.id })) }
    }

    fun clearSelection() {
        if (state.value.importing) return
        update { it.copy(dialogSelection = emptySet()) }
    }

    fun setDirectoryFilter(filter: String) {
        if (state.value.importing) return
        update { it.copy(directoryFilter = filter) }
    }

    fun setSearchQuery(query: String) {
        if (state.value.importing) return
        update { it.copy(searchQuery = query) }
    }

    /**
     * Dialog Confirm (web `onConfirm` wiring in the create form): one checked
     * row selects it inline (adopting its cwd) and closes — unless the row
     * vanished from the list, which leaves the dialog open (web `if (session)`
     * guard); more than one runs the bulk import.
     */
    fun confirm() {
        val current = state.value
        val checked = current.dialogSelection.toList()
        if (checked.size == 1) {
            val session = current.sessions.firstOrNull { it.id == checked[0] } ?: return
            selectInline(session)
            close()
            return
        }
        bulkImport(checked)
    }

    /**
     * `handleBulkImportPiSessions`: `POST /api/pi/import-sessions` with the
     * whole checked batch. Successes (`hapiSessionId` and no `error`) emit
     * the success notice, refresh the session list and re-pull the scan
     * (which re-applies the dialog init — web's weak effect re-runs on the
     * directories change); any failure emits the first failure's partial
     * notice and keeps the dialog open; an all-success batch closes the
     * dialog and clears the inline selection. `cwd`/`machineId` mirror the
     * web payload: trimmed form directory, listing machine with the form
     * machine as fallback.
     */
    fun bulkImport(sessionIds: List<String>) {
        val current = state.value
        if (current.importing || current.loading || sessionIds.isEmpty()) return
        val requestMachineId = current.machineId ?: formMachineId.ifEmpty { null }
        update { it.copy(importing = true, successNotice = null, failedNotice = null) }
        scope.launch {
            try {
                val result = gateway.importPiSessions(
                    PiImportSessionsRequest(
                        sessionIds = sessionIds,
                        cwd = currentDirectory.trim().ifEmpty { null },
                        machineId = requestMachineId,
                    ),
                )
                val importedCount = result.results.count { it.hapiSessionId != null && it.error == null }
                val failed = result.results.filter { it.error != null }
                if (importedCount > 0) {
                    update { it.copy(successNotice = formatSuccessNotice(importedCount)) }
                    refreshSessions()
                    performLoad(currentDirectory, formMachineId, ++loadGeneration)
                }
                if (failed.isNotEmpty()) {
                    val first = failed.first().error
                    update {
                        it.copy(
                            failedNotice = strings.failedTitle + "\n" +
                                strings.failedPartial.format(
                                    failed.size,
                                    PiImportLogic.formatError(first?.code, first?.message, strings),
                                ),
                        )
                    }
                    return@launch
                }
                close()
                update { it.copy(selectedSessionId = null) }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                // Web toasts failed.title + message; Android shows the notice
                // in the still-open dialog (declared divergence).
                update {
                    it.copy(
                        failedNotice = strings.failedTitle + "\n" +
                            (error.message?.takeIf { message -> message.isNotEmpty() } ?: strings.loadFailed),
                    )
                }
            } finally {
                update { it.copy(importing = false) }
            }
        }
    }

    /** `handleSelectPiImportSession`: select inline + adopt the session's cwd. */
    fun selectInline(session: PiLocalSessionSummary) {
        update { it.copy(selectedSessionId = session.id) }
        PiImportLogic.cwdOf(session)?.let(applyDirectory)
    }

    /** The inline section's Clear button. */
    fun clearInlineSelection() {
        update { it.copy(selectedSessionId = null) }
    }

    /**
     * Agent switched away from pi: close the dialog, cancel the in-flight
     * scan, drop list + selection (web only bumps the generation — declared
     * divergence, the stale state is invisible there but kept).
     */
    fun resetForAgentChange() {
        loadJob?.cancel()
        ++loadGeneration
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
     * Machine (or other form context) changed (web `handleMachineChange` pi
     * block + the generation effect): same clear minus the dialog close —
     * the dialog cannot be open while the machine picker is interactive.
     */
    fun resetForContextChange() {
        loadJob?.cancel()
        ++loadGeneration
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
     * The pi branch of web `handleCreate`: import the inline-selected
     * session, then immediately `reopen` the created Hapi record (pi history
     * continues as-is — no resume, no permission forwarding). A per-item
     * error comes back mapped through [PiImportLogic.formatError]; a missing
     * Hapi id falls back to the envelope error, else `piImport.failed.body`.
     */
    suspend fun importAtCreate(request: PiImportSessionsRequest): PiImportAtCreateResult {
        update { it.copy(importingAtCreate = true) }
        return try {
            val result = gateway.importPiSessions(request)
            val targetId = request.sessionIds.firstOrNull()
            val imported = result.results.firstOrNull { it.piSessionId == targetId }
            val itemError = imported?.error
            if (itemError != null) {
                PiImportAtCreateResult.Failed(PiImportLogic.formatError(itemError.code, itemError.message, strings))
            } else {
                val hapiSessionId = imported?.hapiSessionId
                    ?: throw IllegalStateException(result.error ?: strings.loadFailed)
                val reopened = gateway.reopenSession(hapiSessionId)
                PiImportAtCreateResult.Imported(reopened.sessionId)
            }
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Exception) {
            PiImportAtCreateResult.Failed(error.message ?: strings.createFailed)
        } finally {
            update { it.copy(importingAtCreate = false) }
        }
    }

    // ---------------------------------------------------------- internals --

    private suspend fun performLoad(directory: String, machineId: String, generation: Int) {
        update { it.copy(loading = true, error = null) }
        try {
            val result = gateway.piSessions(directory.trim().ifEmpty { null }, machineId)
            if (generation != loadGeneration) return
            if (!result.success) {
                throw IllegalStateException(result.error ?: strings.loadFailed)
            }
            update { current ->
                current.copy(
                    sessions = result.sessions,
                    machineId = result.machineId ?: machineId,
                    selectedSessionId = current.selectedSessionId
                        ?.takeIf { id -> result.sessions.any { it.id == id } },
                )
            }
            applyDialogInitializations()
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Exception) {
            if (generation != loadGeneration) return
            update {
                it.copy(
                    sessions = emptyList(),
                    machineId = null,
                    selectedSessionId = null,
                    error = error.message?.takeIf { message -> message.isNotEmpty() } ?: strings.loadFailed,
                )
            }
        } finally {
            if (generation == loadGeneration) update { it.copy(loading = false) }
        }
    }

    /**
     * The web init effect (`PiSessionImportDialog` L39-45), weak on purpose:
     * checkboxes = exactly the inline selection (membership in the list is
     * **not** required, unlike the codex dialog), directory = the form cwd
     * when it is among the options (else all directories), query cleared.
     * Re-applied on the open edge and after every settled scan while open.
     */
    private fun applyDialogInitializations() {
        val current = state.value
        if (!current.open) return
        val options = PiImportLogic.directoryOptions(current.sessions)
        val formCwd = currentDirectory.trim().takeIf { it.isNotEmpty() }
        update {
            it.copy(
                dialogSelection = current.selectedSessionId?.let { id -> setOf(id) } ?: emptySet(),
                directoryFilter = if (formCwd != null && formCwd in options) formCwd else PiImportLogic.ALL_DIRECTORIES,
                searchQuery = "",
            )
        }
    }

    private fun formatSuccessNotice(count: Int): String =
        strings.successTitle + "\n" +
            (if (count == 1) strings.successBodyOne else strings.successBodyMany.format(count))

    private fun update(transform: (PiImportUiState) -> PiImportUiState) {
        mutable.value = transform(mutable.value)
    }
}

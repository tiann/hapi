package app.hapi.companion.feature.newsession

import app.hapi.protocol.wire.CodexDesktopSyncRequest
import app.hapi.protocol.wire.CodexDuplicateSessionGroup
import app.hapi.protocol.wire.CodexLocalSessionSummary
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Strings the codex-import flow needs at runtime (B-M5a Strings seam):
 * defaults are English; the Navigation holder resolves resources per locale.
 * Web refs: `codexSync.failed.body`, `codexSync.failed.bodyWithReason`,
 * `codexSync.error.timeout`, `codexSync.error.active`,
 * `codexSync.restart.failed.notFound/body`, `codexSync.duplicates.*`.
 */
class CodexImportStrings(
    /** Load + soft-failure fallback (`codexSync.failed.body`). */
    val loadFailed: String = "Failed to import Codex sessions.",
    /** `%1$s` = failure detail (`codexSync.failed.bodyWithReason`). */
    val importFailedReason: String = "Import failed: %1\$s",
    /** `codexSync.error.timeout` (matched via [CodexImportMerge.TIMEOUT_PATTERN]). */
    val timeout: String = "Operation timed out",
    /** `codexSync.error.active` (matched via [CodexImportMerge.ACTIVE_PATTERN]). */
    val sessionActive: String = "This session is still active. Please wait until it ends and try again.",
    /**
     * `codexSync.restart.failed.notFound` (matched via
     * [CodexImportMerge.NOT_FOUND_PATTERN]; also the status-probe failure).
     */
    val clientNotFound: String = "Failed to restart Codex client: not installed or not found",
    /** `codexSync.restart.failed.body` — restart normalize fallback. */
    val restartFailedBody: String = "Failed to run the restart script.",
    /** `codexSync.duplicates.detect.failed.body` — detect normalize fallback. */
    val detectFailedBody: String = "Failed to detect duplicate sessions.",
    /** `codexSync.duplicates.merge.failed.body` — merge normalize fallback. */
    val mergeFailedBody: String = "Failed to merge duplicate sessions.",
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
 * and — after Back/scrim/swipe dismissal — retained on the inline section
 * (web surfaces it as a toast, which survives the dialog by nature).
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
    /** Failed archive, shown as the dialog's red banner (web `archiveError`). */
    val archiveError: String? = null,
    /** Restart-client probe/restart in flight (web `isRestartingCodexDesktop`). */
    val restartingDesktop: Boolean = false,
    /** Last restart succeeded (web toasts `restart.started.*`; inline here). */
    val restartStarted: Boolean = false,
    /** Last restart failed — normalized message (web toasts `restart.failed.*`). */
    val restartError: String? = null,
    /**
     * Codex thread ids whose import detected duplicates — the batch both
     * detected and re-sent for merging (web `pendingDuplicateSessionIds`).
     */
    val pendingDuplicateSessionIds: List<String> = emptyList(),
    /** Hapi session ids the import created (web `pendingDuplicateHapiSessionIds`). */
    val pendingDuplicateHapiSessionIds: List<String> = emptyList(),
    /** Duplicate groups behind the confirm dialog (web `duplicateSessionGroups`). */
    val duplicateSessionGroups: List<CodexDuplicateSessionGroup> = emptyList(),
    /** Merge in flight (web `isMergingDuplicateSessions`). */
    val mergingDuplicates: Boolean = false,
    /**
     * Failed merge, shown inline in the still-open confirm dialog (web
     * rethrows and lets ConfirmDialog catch — same keep-open semantics).
     */
    val duplicateMergeError: String? = null,
    /**
     * Failed duplicate detection after an otherwise successful import (web
     * only toasts `duplicates.detect.failed.*`; the import result stands).
     */
    val duplicateDetectError: String? = null,
    /**
     * A single-row Confirm found the checked row gone from the listing
     * (archived externally, e.g. from the desktop client, after it was
     * checked): the dialog stays open with the selection intact and this
     * notice armed instead of closing with no selection at all.
     */
    val confirmSelectionMissing: Boolean = false,
) {
    val selectedSession: CodexLocalSessionSummary?
        get() = selectedSessionId?.let { id -> sessions.firstOrNull { it.id == id } }

    /**
     * The merge confirm dialog is open exactly when a batch is pending and
     * groups were detected (web `isDuplicateMergeConfirmOpen && groups > 0`;
     * the flag and the data always flip together, so it is derived).
     */
    val duplicateMergeConfirmOpen: Boolean
        get() = pendingDuplicateSessionIds.isNotEmpty() && duplicateSessionGroups.isNotEmpty()
}

/** Outcome of the import-at-create chain (sync → resume). */
sealed interface CodexImportAtCreateResult {
    /** [resumedSessionId] is what navigation should open. */
    data class Imported(val resumedSessionId: String) : CodexImportAtCreateResult

    /** [rawError] is shown as the form's create error, un-normalized (web parity). */
    data class Failed(val rawError: String) : CodexImportAtCreateResult
}

/**
 * Controller for the codex session-import flow (slices A+B): owns the list
 * dialog state, the inline section's selection, the two import paths (bulk
 * from the dialog, single during Create), and — since slice B — the
 * duplicate-merge confirm leg, the archive action and the restart affordance.
 * Web refs: `web/src/components/CodexSessionSyncDialog.tsx` (dialog state
 * machine) and the codex-import branches of
 * `web/src/components/NewSession/index.tsx`
 * (`loadCodexImportSessions`, `handleBulkImportCodexSessions`,
 * `handleMergeDuplicateSessions`, `handleArchiveCodexImportSession`,
 * `handleRestartCodexDesktop`, `handleSelectCodexImportSession`,
 * `handleCreate`).
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
 *   keeps the dialog open with selections intact. A single-row Confirm
 *   whose row was archived/removed externally in the meantime keeps the
 *   dialog open with the selection intact + a visible notice — never a
 *   silent close with no selection.
 * - After a successful bulk import the same batch is re-checked for
 *   duplicates (`POST /codex/duplicate-sessions`, only `sessionIds`):
 *   duplicates arm the merge-confirm state; a detection failure never
 *   disturbs the finished import (web toasts; here
 *   [CodexImportUiState.duplicateDetectError]).
 * - The pending-duplicate state is independent of the import dialog's
 *   lifecycle (web keeps it in separate useState slots); closing the import
 *   dialog does not clear it — only [closeDuplicateMergeDialog] and the next
 *   bulk import's stale-flush do.
 * - Merge confirm failure keeps the confirm dialog open with the error
 *   inline (web rethrows out of `handleMergeDuplicateSessions` and
 *   `ConfirmDialog` catches into its error slot); success clears the
 *   pending state and navigates to the canonical session. The confirm's
 *   dismissal is guarded while a merge is in flight (progress + outcome
 *   stay observable), and dismissing after a failure retains the error on
 *   the inline section instead of swallowing it with the dialog.
 * - Archive removes the row (and the inline selection when it pointed at
 *   it); failures land in the dialog's red [CodexImportUiState.archiveError]
 *   banner. Restart probes `/codex/status` first — an unavailable client
 *   short-circuits with the not-found message and never calls
 *   restart-desktop.
 *
 * Declared Android divergences (web behavior in parens):
 * - bulk-import success has no toast and no session-list refetch (web toasts
 *   "Import complete" and refetches); the dialog simply closes and the list
 *   screen refreshes on next entry.
 * - bulk-import failure shows [CodexImportUiState.importError] inside the
 *   still-open dialog (web toasts; Android's create form has no toast host),
 *   and the normalize fallback for an exception with no message reuses
 *   [CodexImportStrings.loadFailed] (web uses `dialog.error.default`).
 *   Dismissing the sheet mid-import or after a failure keeps the error on
 *   the inline section (web's toast equally survives the dialog).
 * - the import-at-create error is raw, exactly like web's `setError` (no
 *   timeout/active classification there either).
 * - duplicate detection after a successful import surfaces as
 *   [CodexImportUiState.duplicateDetectError] on the inline section instead
 *   of a transient toast (web: `duplicates.detect.failed.*` toast).
 * - merge success navigates straight to the redirect session with no toast
 *   (web also toasts `duplicates.merge.success.*`) and no session-list
 *   refetch (web `refetchSessions`); the merged session opens directly, so
 *   the list refreshes on next entry. Merge failure shows only the
 *   normalized message in the confirm dialog's error slot (web toasts the
 *   title first, then shows the same message inline).
 * - restart feedback is inline in the import dialog (web: toasts for
 *   `restart.started.*` / `restart.failed.*`; the not-found body and script
 *   fallback are reused verbatim from the strings seam).
 */
class CodexImportController(
    private val scope: CoroutineScope,
    private val gateway: NewSessionGateway,
    private val store: CodexImportedSessionsStore,
    private val strings: CodexImportStrings = CodexImportStrings(),
    /** Applies a session cwd to the form directory (web `setDirectory(session.cwd.trim())`). */
    private val applyDirectory: (String) -> Unit = {},
    /** Merge-confirmed navigation target (web `props.onSuccess(redirectSessionId)`). */
    private val navigateToSession: (String) -> Unit = {},
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

    /**
     * Close edge (Back/scrim/swipe/Cancel): dialog-local state resets (web
     * `wasOpenRef` block) — except a failed bulk import's
     * [CodexImportUiState.importError], which **survives** the close so the
     * inline section keeps showing it. The web twin toasts the failure
     * outside the dialog; Android's toast host is the section's error line
     * (web parity via a different surface).
     */
    fun close() {
        resetDialogFields(retainImportError = true)
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
        update { current ->
            if (current.importing || current.loading) {
                current
            } else {
                current.copy(
                    dialogSelection = if (sessionId in current.dialogSelection) {
                        current.dialogSelection - sessionId
                    } else {
                        current.dialogSelection + sessionId
                    },
                    // The selection changed — a stale row-missing notice is obsolete.
                    confirmSelectionMissing = false,
                )
            }
        }
    }

    /** Checks exactly the filtered rows (web `selectAll` replaces, no union). */
    fun selectAll() {
        update { current ->
            val filtered =
                CodexImportLogic.filterSessions(current.sessions, current.workdirFilter, current.searchQuery)
            current.copy(dialogSelection = LinkedHashSet(filtered.map { it.id }), confirmSelectionMissing = false)
        }
    }

    fun clearSelection() {
        update { it.copy(dialogSelection = emptySet(), confirmSelectionMissing = false) }
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
     * dialog only on success). A single-row Confirm whose row has vanished
     * from the listing meanwhile (archived externally) keeps the dialog open
     * with the selection intact + a visible notice rather than closing with
     * no selection at all.
     */
    fun confirm() {
        val current = state.value
        val checked = current.dialogSelection.toList()
        if (checked.size == 1) {
            val picked = current.sessions.firstOrNull { it.id == checked[0] }
            if (picked == null) {
                update { it.copy(confirmSelectionMissing = true) }
                return
            }
            selectInline(picked)
            // An inline pick is a clean exit — drop any stale failure left by
            // an earlier bulk attempt in the same dialog session.
            resetDialogFields()
            update { it.copy(open = false) }
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
     * the listing machine with the form machine as fallback. Since slice B a
     * successful import immediately re-checks the same batch for duplicates
     * (web L1223-1249): stale pending state is flushed first, then
     * `POST /codex/duplicate-sessions` with only `sessionIds` arms the
     * merge-confirm state when duplicates come back. Detection failures
     * never roll the import back — they surface as
     * [CodexImportUiState.duplicateDetectError].
     */
    fun bulkImport(sessionIds: List<String>) {
        if (sessionIds.isEmpty()) return
        // The busy guard and the importing=true transition are one atomic
        // step, so two racing Confirm taps can never double-launch (the
        // captures reset each CAS attempt — they reflect exactly the attempt
        // whose transition won).
        var requestMachineId: String? = null
        var started = false
        // A fresh import attempt supersedes any retained merge/detect
        // feedback from the previous batch (including a merge error retained
        // through a dismissed confirm).
        update { current ->
            started = false
            requestMachineId = null
            if (current.importing || current.loading) {
                current
            } else {
                started = true
                requestMachineId = current.machineId
                current.copy(importing = true, duplicateDetectError = null, duplicateMergeError = null)
            }
        }
        if (!started) return
        val machineId = requestMachineId ?: formMachineId.ifEmpty { null }
        scope.launch {
            try {
                val result = gateway.syncCodexSession(
                    CodexDesktopSyncRequest(
                        sessionIds = sessionIds,
                        cwd = currentDirectory.trim().ifEmpty { null },
                        machineId = machineId,
                    ),
                )
                if (!result.success) {
                    throw IllegalStateException(normalizeError(result.error, strings.loadFailed))
                }
                store.markImported(sessionIds)
                resetDialogFields()
                // The keep-selection read rides the atomic transition — a
                // concurrent update between a stale read and this write can
                // no longer resurrect a dropped inline selection.
                update { current ->
                    current.copy(
                        open = false,
                        selectedSessionId = CodexImportLogic.clearBatchImportedCodexSelection(
                            current.selectedSessionId,
                            sessionIds,
                        ),
                    )
                }
                // Duplicate detection (slice B) — second hop after the import
                // itself succeeded; scope == the batch just imported.
                val importedHapiIds = result.hapiSessionIds ?: emptyList()
                closeDuplicateMergeDialog()
                update { it.copy(pendingDuplicateHapiSessionIds = importedHapiIds) }
                try {
                    val duplicateResult = gateway.getCodexDuplicateSessions(
                        CodexDesktopSyncRequest(sessionIds = sessionIds),
                    )
                    if (!duplicateResult.success) {
                        throw IllegalStateException(
                            normalizeError(duplicateResult.error, strings.detectFailedBody),
                        )
                    }
                    if (duplicateResult.duplicates.isNotEmpty()) {
                        update {
                            it.copy(
                                pendingDuplicateSessionIds = sessionIds,
                                pendingDuplicateHapiSessionIds = importedHapiIds,
                                duplicateSessionGroups = duplicateResult.duplicates,
                            )
                        }
                    }
                } catch (cancellation: CancellationException) {
                    throw cancellation
                } catch (detectError: Exception) {
                    // Web toasts; the import stands and the dialog is closed.
                    update {
                        it.copy(
                            duplicateDetectError = normalizeError(detectError.message, strings.detectFailedBody),
                        )
                    }
                }
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

    /**
     * `handleMergeDuplicateSessions`: execute the confirmed merge for the
     * pending batch. Success resolves the redirect target (first canonical
     * survivor, else the first imported Hapi session), clears the pending
     * state and hands the id to [navigateToSession] (web `onSuccess`;
     * `refetchSessions` is a declared divergence). Failure keeps the confirm
     * dialog open with the normalized message inline — web rethrows and
     * `ConfirmDialog` catches into its own error slot.
     */
    fun mergeDuplicates() {
        // Guard + mergingDuplicates=true in one atomic step (no double-launch
        // under racing taps); the batch capture resets each CAS attempt.
        var pendingBatch: List<String> = emptyList()
        update { current ->
            pendingBatch = emptyList()
            if (current.mergingDuplicates || current.pendingDuplicateSessionIds.isEmpty()) {
                current
            } else {
                pendingBatch = current.pendingDuplicateSessionIds
                current.copy(mergingDuplicates = true, duplicateMergeError = null)
            }
        }
        if (pendingBatch.isEmpty()) return
        scope.launch {
            try {
                val result = gateway.mergeCodexDuplicateSessions(
                    CodexDesktopSyncRequest(sessionIds = pendingBatch),
                )
                if (!result.success) {
                    throw IllegalStateException(normalizeError(result.error, strings.mergeFailedBody))
                }
                val redirectSessionId = CodexImportMerge.resolveCodexImportRedirectSessionId(
                    merged = result.merged,
                    importedHapiSessionIds = state.value.pendingDuplicateHapiSessionIds,
                )
                // Success owns its cleanup: end the in-flight window first so
                // the guarded close actually clears (a user dismissal
                // mid-merge is the guarded no-op), and drop any stale error.
                update { it.copy(mergingDuplicates = false, duplicateMergeError = null) }
                closeDuplicateMergeDialog()
                redirectSessionId?.let(navigateToSession)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                update {
                    it.copy(duplicateMergeError = normalizeError(error.message, strings.mergeFailedBody))
                }
            } finally {
                update { it.copy(mergingDuplicates = false) }
            }
        }
    }

    /** `closeDuplicateMergeDialog`: clears the pending slots — with two dismissal guarantees. */
    fun closeDuplicateMergeDialog() {
        // While a merge is in flight this is a no-op: the confirm stays open
        // so the in-flight progress and the eventual outcome stay observable
        // (an AlertDialog's back/outside dismissal routes here, same as the
        // already-disabled cancel button; success ends the in-flight window
        // before its own cleanup below). The guard rides the atomic
        // transition, so a merge settling concurrently with the dismissal
        // cannot slip the cleanup past a stale guard read.
        update { current ->
            if (current.mergingDuplicates) {
                current
            } else {
                // A failed merge's error is retained through the dismissal —
                // it must not vanish with the dialog (the web twin toasts it
                // outside the dialog; the #2149 import-error retention shape).
                // It renders on the inline section while the confirm is
                // closed, and clears on the next bulk import or merge attempt.
                current.copy(
                    pendingDuplicateSessionIds = emptyList(),
                    pendingDuplicateHapiSessionIds = emptyList(),
                    duplicateSessionGroups = emptyList(),
                )
            }
        }
    }

    /**
     * `handleArchiveCodexImportSession`: archive one local transcript on the
     * listing machine (form machine as fallback — web
     * `codexImportMachineId ?? machineId`). Success removes the row and, when
     * the inline selection pointed at it, clears the selection; failure
     * rethrows into the dialog's [CodexImportUiState.archiveError] banner
     * (web `handleArchive` catch, no toast channel).
     */
    fun archive(sessionId: String) {
        // Guard + error reset in one atomic step; the machine capture resets
        // each CAS attempt (it reflects exactly the winning transition).
        var machineId: String? = null
        var started = false
        update { current ->
            started = false
            machineId = null
            if (current.importing || current.loading) {
                current
            } else {
                started = true
                machineId = current.machineId
                current.copy(archiveError = null)
            }
        }
        if (!started) return
        scope.launch {
            try {
                val result = gateway.archiveCodexSession(sessionId, machineId ?: formMachineId.ifEmpty { null })
                if (!result.success) {
                    throw IllegalStateException(result.error.orEmpty())
                }
                update { state2 ->
                    state2.copy(
                        sessions = state2.sessions.filterNot { it.id == sessionId },
                        selectedSessionId = state2.selectedSessionId?.takeIf { it != sessionId },
                    )
                }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                update { it.copy(archiveError = error.message ?: strings.loadFailed) }
            }
        }
    }

    /**
     * `handleRestartCodexDesktop`: probe `/codex/status` first — an
     * unavailable client short-circuits with the not-found message and the
     * restart call is never made; otherwise `POST /restart-desktop` and
     * branch on the envelope's `success` (failures normalized with the
     * script fallback). Outcomes are inline in the dialog (web toasts —
     * declared divergence): [CodexImportUiState.restartStarted] on success,
     * [CodexImportUiState.restartError] on failure.
     */
    fun restart() {
        // Guard + restartingDesktop=true in one atomic step (no double-probe).
        var started = false
        update { current ->
            started = false
            if (current.restartingDesktop) {
                current
            } else {
                started = true
                current.copy(restartingDesktop = true, restartStarted = false, restartError = null)
            }
        }
        if (!started) return
        scope.launch {
            try {
                val status = gateway.getCodexDesktopStatus()
                if (!status.codexClientAvailable) {
                    throw IllegalStateException(strings.clientNotFound)
                }
                val result = gateway.restartCodexDesktop()
                if (!result.success) {
                    throw IllegalStateException(normalizeError(result.error, strings.restartFailedBody))
                }
                update { it.copy(restartStarted = true) }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                update { it.copy(restartError = normalizeError(error.message, strings.restartFailedBody)) }
            } finally {
                update { it.copy(restartingDesktop = false) }
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

    /**
     * Web `normalizeCodexScriptError` (pure twin in [CodexImportMerge]):
     * classify timeout / active-thread / launcher-not-found, else pass
     * through; blank falls back to the caller-provided message.
     */
    private fun normalizeError(message: String?, fallback: String): String =
        CodexImportMerge.normalizeCodexScriptError(message, fallback, strings)

    /** Web `formatCodexImportFailure` (pure twin in [CodexImportMerge]). */
    private fun formatFailure(reason: String): String =
        CodexImportMerge.formatCodexImportFailure(reason, strings)

    /**
     * The dialog's one-time init effects, run after a load settles:
     * workdir-filter init (only with a non-empty list) + invalid-filter
     * fallback + checkbox init (default-check the inline selection when in
     * the list and not imported).
     */
    private fun applyDialogInitializations() {
        // One-shot latch reads happen outside the transition (they are
        // controller-private and only advance here); every state-derived
        // decision — including the marker merge — folds inside, so a marker
        // emission or scan settling between read and write can no longer
        // produce an init computed from a stale snapshot.
        val initWorkdirFilter = !hasInitializedWorkdirFilter
        val initSelection = !hasInitializedSelection
        if (initWorkdirFilter) hasInitializedWorkdirFilter = true
        if (initSelection) hasInitializedSelection = true
        update { current ->
            if (!current.open) {
                current
            } else {
                var next = current
                val options = CodexImportLogic.workdirOptions(current.sessions)
                val default = CodexImportLogic.defaultWorkdirFilter(current.sessions, currentDirectory)
                if (initWorkdirFilter && current.sessions.isNotEmpty()) {
                    next = next.copy(workdirFilter = default)
                } else if (current.workdirFilter != CodexImportLogic.ALL_WORKDIR_FILTER &&
                    current.workdirFilter !in options
                ) {
                    next = next.copy(workdirFilter = default)
                }
                if (initSelection) {
                    val defaultSelected = current.selectedSessionId
                        ?.takeIf { id ->
                            current.sessions.any { it.id == id } && current.importedMarkers[id] == null
                        }
                    next = next.copy(dialogSelection = defaultSelected?.let { setOf(it) } ?: emptySet())
                }
                next
            }
        }
    }

    private fun resetDialogFields(retainImportError: Boolean = false) {
        hasInitializedSelection = false
        hasInitializedWorkdirFilter = false
        update {
            it.copy(
                dialogSelection = emptySet(),
                workdirFilter = CodexImportLogic.ALL_WORKDIR_FILTER,
                searchQuery = "",
                importError = if (retainImportError) it.importError else null,
                archiveError = null,
                restartStarted = false,
                restartError = null,
                confirmSelectionMissing = false,
            )
        }
    }

    /**
     * Atomic CAS ([MutableStateFlow.update]) — the controller is mutated from
     * the UI thread and from background work (the marker collector, scans,
     * imports) on `Dispatchers.Default`, so a read-copy-write here could
     * resurrect fields a concurrent update had just changed — e.g. a late
     * marker emission rewriting a snapshot where the dialog was still open
     * (reopening a closed dialog) or busy was still set (stranding the form).
     * Transforms must stay side-effect-pure; they may re-run while the CAS
     * retries.
     */
    private fun update(transform: (CodexImportUiState) -> CodexImportUiState) {
        mutable.update(transform)
    }
}

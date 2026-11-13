package app.hapi.companion.feature.newsession

import app.hapi.protocol.wire.CodexDesktopSyncRequest
import app.hapi.protocol.wire.CodexLocalSessionSummary

/**
 * Pure helpers for the codex session-import flow (slice A), ported from
 * `web/src/components/CodexSessionSyncDialog.tsx` + the codex-import branch
 * of the web create form (`web/src/components/NewSession/index.tsx`).
 * Android-free so JVM tests can pin the exact semantics.
 */
object CodexImportLogic {

    /** Sentinel workdir filter matching every directory (web `__all__`). */
    const val ALL_WORKDIR_FILTER = "__all__"

    /** Trimmed non-empty [CodexLocalSessionSummary.cwd], else null. */
    fun cwdOf(session: CodexLocalSessionSummary): String? =
        session.cwd?.trim()?.takeIf { it.isNotEmpty() }

    /**
     * De-duplicated trimmed session cwds, sorted. Web uses `localeCompare`;
     * Kotlin's lexicographic [sorted] is the practical equivalent here.
     */
    fun workdirOptions(sessions: List<CodexLocalSessionSummary>): List<String> =
        sessions.mapNotNull { cwdOf(it) }.toSortedSet().toList()

    /**
     * The form's current directory when it is among [sessions]' cwds,
     * else the all-files sentinel (web `defaultWorkdirFilter`).
     */
    fun defaultWorkdirFilter(sessions: List<CodexLocalSessionSummary>, currentDirectory: String): String {
        val directory = currentDirectory.trim()
        if (directory.isEmpty() || workdirOptions(sessions).none { it == directory }) return ALL_WORKDIR_FILTER
        return directory
    }

    /** Search over the web field set: title, last message, cwd, originator, cli version, id. */
    fun matchesQuery(session: CodexLocalSessionSummary, rawQuery: String): Boolean {
        val query = rawQuery.trim().lowercase()
        if (query.isEmpty()) return true
        val fields = listOfNotNull(
            session.title.ifEmpty { null },
            session.lastUserMessage?.ifEmpty { null },
            session.cwd?.ifEmpty { null },
            session.originator?.ifEmpty { null },
            session.cliVersion?.ifEmpty { null },
            session.id.ifEmpty { null },
        )
        return fields.any { it.lowercase().contains(query) }
    }

    /** Workdir + search filtering (web `filteredSessions`). */
    fun filterSessions(
        sessions: List<CodexLocalSessionSummary>,
        workdirFilter: String,
        searchQuery: String,
    ): List<CodexLocalSessionSummary> = sessions.filter { session ->
        if (workdirFilter != ALL_WORKDIR_FILTER && cwdOf(session) != workdirFilter) return@filter false
        matchesQuery(session, searchQuery)
    }

    /** "Original" badge: user thread or not a fork (web `isOriginalCodexSession`). */
    fun isOriginal(session: CodexLocalSessionSummary): Boolean =
        session.threadSource == "user" || session.forkedFromId == null

    /** "Fork" badge: non-blank [CodexLocalSessionSummary.forkedFromId]. */
    fun isForked(session: CodexLocalSessionSummary): Boolean =
        !session.forkedFromId.isNullOrBlank()

    /**
     * Row preview: trimmed last user message, else `originator · cliVersion`
     * with empty parts dropped (web `getCodexSessionPreview`).
     */
    fun previewOf(session: CodexLocalSessionSummary): String =
        session.lastUserMessage?.trim()?.takeIf { it.isNotEmpty() }
            ?: listOfNotNull(
                session.originator?.ifEmpty { null },
                session.cliVersion?.ifEmpty { null },
            ).joinToString(" · ")

    /**
     * After a bulk import the inline (single) selection clears only when it
     * was itself part of the imported batch (web `clearBatchImportedCodexSelection`
     * in `NewSession/codexImportMerge.ts`).
     */
    fun clearBatchImportedCodexSelection(
        selectedSessionId: String?,
        importedSessionIds: List<String>,
    ): String? =
        if (selectedSessionId != null && selectedSessionId in importedSessionIds) null else selectedSessionId

    /**
     * `POST /api/codex/sync-session` body for importing the inline-selected
     * session during Create — field-for-field port of the codex-import branch
     * of web `handleCreate`:
     * - `cwd` = the session's **raw** cwd when present (no trim — web
     *   `selectedCodexImportSession.cwd ?? trimmedDirectory`), else the
     *   trimmed form directory;
     * - `machineId` = the import dialog's machine (the machine the sessions
     *   were listed from) when set, else the form's machine;
     * - `model` only when not `'auto'`; `modelReasoningEffort` only when not
     *   `'default'`; `serviceTier` only while the fast tier is visible (then
     *   also `'standard'`);
     * - `collaborationMode` **always** (`'default'` included);
     * - `yolo` **always**, `true` exactly when the native permission mode is
     *   `'yolo'`.
     */
    fun buildSingleImportRequest(
        form: NewSessionForm,
        selected: CodexLocalSessionSummary,
        formMachineId: String,
        importMachineId: String?,
        codexFastTierVisible: Boolean,
    ): CodexDesktopSyncRequest = CodexDesktopSyncRequest(
        sessionIds = listOf(selected.id),
        cwd = selected.cwd ?: form.trimmedDirectory.ifEmpty { null },
        machineId = importMachineId ?: formMachineId,
        model = form.model.takeIf { it != "auto" },
        modelReasoningEffort = form.modelReasoningEffort.takeIf { it != "default" },
        serviceTier = form.serviceTier.takeIf { codexFastTierVisible },
        collaborationMode = form.collaborationMode.takeIf { it != "default" } ?: "default",
        yolo = form.permissionMode == "yolo",
    )
}

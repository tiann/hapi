package app.hapi.companion.feature.newsession

import app.hapi.data.api.HapiApi
import app.hapi.protocol.wire.CodexArchiveSessionResponse
import app.hapi.protocol.wire.CodexDesktopScriptResponse
import app.hapi.protocol.wire.CodexDesktopStatusResponse
import app.hapi.protocol.wire.CodexDesktopSyncRequest
import app.hapi.protocol.wire.CodexDuplicateSessionsResponse
import app.hapi.protocol.wire.CodexLocalSessionsResponse
import app.hapi.protocol.wire.CodexMergeDuplicateSessionsResponse
import app.hapi.protocol.wire.CodexModelsResponse
import app.hapi.protocol.wire.AgentAvailabilityResponse
import app.hapi.protocol.wire.GrokModelsResponse
import app.hapi.protocol.wire.MachineListDirectoryResponse
import app.hapi.protocol.wire.MachinePathsExistsResponse
import app.hapi.protocol.wire.PiImportSessionsRequest
import app.hapi.protocol.wire.PiImportSessionsResponse
import app.hapi.protocol.wire.PiLocalSessionsResponse
import app.hapi.protocol.wire.ReopenSessionResponse
import app.hapi.protocol.wire.ResumeSessionResponse
import app.hapi.protocol.wire.SpawnResponse
import app.hapi.protocol.wire.SpawnSessionRequest

/**
 * The machine endpoints the create form talks to, as a seam so JVM tests
 * drive [NewSessionViewModel] with fakes (the concrete [HapiApi] is final).
 */
interface NewSessionGateway {
    /** `POST /api/machines/:id/spawn` — check `type`, not HTTP status. */
    suspend fun spawn(machineId: String, request: SpawnSessionRequest): SpawnResponse

    /** `POST /api/machines/:id/list-directory` (RPC-wrapped). */
    suspend fun listDirectory(
        machineId: String,
        path: String,
        includeHidden: Boolean = false,
    ): MachineListDirectoryResponse

    /** `POST /api/machines/:id/paths/exists`. */
    suspend fun pathsExist(machineId: String, paths: List<String>): MachinePathsExistsResponse

    /** `GET /api/machines/:id/agent-availability`. */
    suspend fun agentAvailability(machineId: String): AgentAvailabilityResponse

    /** `GET /api/machines/:id/codex-models` (RPC-wrapped; 503 `rpc_target_missing` = hide picker). */
    suspend fun codexModels(machineId: String): CodexModelsResponse

    /** `GET /api/machines/:id/grok-models?cwd=` (RPC-wrapped) — Auto-mode capability probe. */
    suspend fun grokModels(machineId: String, cwd: String): GrokModelsResponse
    /**
     * `GET /api/codex/sessions` (codex import, slice A). Soft failures arrive
     * as HTTP 200 `{success:false, sessions:[]}` — the silent-empty policy
     * lives in [CodexImportController], not here.
     */
    suspend fun getCodexSessions(
        cwd: String? = null,
        machineId: String? = null,
    ): CodexLocalSessionsResponse

    /** `POST /api/codex/sync-session` — HTTP 200 + `success:false` on failure; check the flag. */
    suspend fun syncCodexSession(sync: CodexDesktopSyncRequest): CodexDesktopScriptResponse

    /**
     * `POST /api/sessions/:id/resume` — import-at-create hands the imported
     * session back to the caller via the same resume path a reopened session
     * takes. `permissionMode` travels only when the form selected one.
     */
    suspend fun resumeSession(sessionId: String, permissionMode: String? = null): ResumeSessionResponse

    /**
     * `POST /api/codex/archive-session` (slice B) — archive one local Codex
     * transcript; `machineId` is omitted from the body when null. Failure is
     * HTTP 200 `success:false`; the caller rethrows it into the dialog's red
     * archive banner.
     */
    suspend fun archiveCodexSession(
        sessionId: String,
        machineId: String? = null,
    ): CodexArchiveSessionResponse

    /**
     * `GET /api/codex/status` (slice B) — `codexClientAvailable=false` means
     * the restart call must not be made (not installed / not found).
     */
    suspend fun getCodexDesktopStatus(): CodexDesktopStatusResponse

    /**
     * `POST /api/codex/duplicate-sessions` (slice B) — duplicates among the
     * batch carried by [payload]; the web caller passes only `sessionIds` so
     * detection scope == execution scope.
     */
    suspend fun getCodexDuplicateSessions(payload: CodexDesktopSyncRequest): CodexDuplicateSessionsResponse

    /** `POST /api/codex/merge-duplicate-sessions` (slice B) — execute the confirmed merge. */
    suspend fun mergeCodexDuplicateSessions(payload: CodexDesktopSyncRequest): CodexMergeDuplicateSessionsResponse

    /** `POST /api/codex/restart-desktop` (slice B) — script envelope; check `success`. */
    suspend fun restartCodexDesktop(): CodexDesktopScriptResponse

    /**
     * `GET /api/pi/sessions` (pi import, slice C). Soft failures arrive as
     * HTTP 200 `{success:false, sessions:[]}` — and unlike the codex twin the
     * web Pi caller treats that as an error; that policy lives in
     * [PiImportController], not here.
     */
    suspend fun piSessions(
        cwd: String? = null,
        machineId: String? = null,
    ): PiLocalSessionsResponse

    /**
     * `POST /api/pi/import-sessions` (slice C) — failures are a top-level
     * HTTP 200 `success:false` **or** per-item `results[i].error`; the caller
     * scores the batch from `results`.
     */
    suspend fun importPiSessions(payload: PiImportSessionsRequest): PiImportSessionsResponse

    /**
     * `POST /api/sessions/:id/reopen` (slice C) — the pi import-at-create leg
     * reopens the imported session as-is (web `api.reopenSession`); the
     * returned id may differ from [sessionId] (superseding spawn).
     */
    suspend fun reopenSession(sessionId: String): ReopenSessionResponse
}

/** Production adapter over the hub's [HapiApi]. */
class ApiNewSessionGateway(private val api: HapiApi) : NewSessionGateway {
    override suspend fun spawn(machineId: String, request: SpawnSessionRequest): SpawnResponse =
        api.spawnSession(machineId, request)

    override suspend fun listDirectory(
        machineId: String,
        path: String,
        includeHidden: Boolean,
    ): MachineListDirectoryResponse = api.listMachineDirectory(machineId, path, includeHidden)

    override suspend fun pathsExist(machineId: String, paths: List<String>): MachinePathsExistsResponse =
        api.checkMachinePathsExist(machineId, paths)

    override suspend fun agentAvailability(machineId: String): AgentAvailabilityResponse =
        api.getMachineAgentAvailability(machineId)

    override suspend fun codexModels(machineId: String): CodexModelsResponse =
        api.getMachineCodexModels(machineId)

    override suspend fun grokModels(machineId: String, cwd: String): GrokModelsResponse =
        api.getMachineGrokModelsForCwd(machineId, cwd)
    override suspend fun getCodexSessions(
        cwd: String?,
        machineId: String?,
    ): CodexLocalSessionsResponse = api.getCodexSessions(cwd, machineId)

    override suspend fun syncCodexSession(sync: CodexDesktopSyncRequest): CodexDesktopScriptResponse =
        api.syncCodexSession(sync)

    override suspend fun resumeSession(sessionId: String, permissionMode: String?): ResumeSessionResponse =
        api.resumeSession(sessionId, permissionMode)

    override suspend fun archiveCodexSession(
        sessionId: String,
        machineId: String?,
    ): CodexArchiveSessionResponse = api.archiveCodexSession(sessionId, machineId)

    override suspend fun getCodexDesktopStatus(): CodexDesktopStatusResponse =
        api.getCodexDesktopStatus()

    override suspend fun getCodexDuplicateSessions(payload: CodexDesktopSyncRequest): CodexDuplicateSessionsResponse =
        api.getCodexDuplicateSessions(payload)

    override suspend fun mergeCodexDuplicateSessions(payload: CodexDesktopSyncRequest): CodexMergeDuplicateSessionsResponse =
        api.mergeCodexDuplicateSessions(payload)

    override suspend fun restartCodexDesktop(): CodexDesktopScriptResponse =
        api.restartCodexDesktop()

    override suspend fun piSessions(
        cwd: String?,
        machineId: String?,
    ): PiLocalSessionsResponse = api.getPiSessions(cwd, machineId)

    override suspend fun importPiSessions(payload: PiImportSessionsRequest): PiImportSessionsResponse =
        api.importPiSessions(payload)

    override suspend fun reopenSession(sessionId: String): ReopenSessionResponse =
        api.reopenSession(sessionId)
}

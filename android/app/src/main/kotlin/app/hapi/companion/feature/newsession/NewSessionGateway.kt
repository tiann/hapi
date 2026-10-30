package app.hapi.companion.feature.newsession

import app.hapi.data.api.HapiApi
import app.hapi.protocol.wire.CodexDesktopScriptResponse
import app.hapi.protocol.wire.CodexDesktopSyncRequest
import app.hapi.protocol.wire.CodexLocalSessionsResponse
import app.hapi.protocol.wire.CodexModelsResponse
import app.hapi.protocol.wire.AgentAvailabilityResponse
import app.hapi.protocol.wire.GrokModelsResponse
import app.hapi.protocol.wire.MachineListDirectoryResponse
import app.hapi.protocol.wire.MachinePathsExistsResponse
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
}

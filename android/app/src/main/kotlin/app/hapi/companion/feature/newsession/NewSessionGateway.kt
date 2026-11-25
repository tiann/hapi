package app.hapi.companion.feature.newsession

import app.hapi.data.api.HapiApi
import app.hapi.protocol.wire.CodexModelsResponse
import app.hapi.protocol.wire.AgentAvailabilityResponse
import app.hapi.protocol.wire.GrokModelsResponse
import app.hapi.protocol.wire.MachineListDirectoryResponse
import app.hapi.protocol.wire.MachinePathsExistsResponse
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
}

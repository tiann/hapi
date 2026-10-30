package app.hapi.companion.feature.newsession

import app.hapi.data.api.HapiApi
import app.hapi.protocol.wire.CodexModelsResponse
import app.hapi.protocol.wire.AgentAvailabilityResponse
import app.hapi.protocol.wire.AgyModelsResponse
import app.hapi.protocol.wire.CopilotModelsResponse
import app.hapi.protocol.wire.CursorModelsResponse
import app.hapi.protocol.wire.GrokModelsResponse
import app.hapi.protocol.wire.KimiModelsResponse
import app.hapi.protocol.wire.MachineListDirectoryResponse
import app.hapi.protocol.wire.MachinePathsExistsResponse
import app.hapi.protocol.wire.OpencodeModelsResponse
import app.hapi.protocol.wire.OpencodeModelVariantsResponse
import app.hapi.protocol.wire.PiModelsResponse
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

    // Flavor model catalogs for the per-agent pickers (web ref:
    // `web/src/components/NewSession/index.tsx`). All RPC-wrapped.

    /** `GET /api/machines/:id/agy-models` — [refresh] spends the once-per-load cache skip (Retry). */
    suspend fun agyModels(machineId: String, refresh: Boolean = false): AgyModelsResponse

    /** `GET /api/machines/:id/pi-models`. */
    suspend fun piModels(machineId: String): PiModelsResponse

    /** `GET /api/machines/:id/cursor-models`. */
    suspend fun cursorModels(machineId: String): CursorModelsResponse

    /** `GET /api/machines/:id/opencode-models?cwd=` — catalog is cwd-scoped. */
    suspend fun opencodeModels(machineId: String, cwd: String): OpencodeModelsResponse

    /** `GET /api/machines/:id/opencode-model-variants?cwd=` — null [cwd] omits the query. */
    suspend fun opencodeModelVariants(machineId: String, cwd: String? = null): OpencodeModelVariantsResponse

    /** `GET /api/machines/:id/grok-models?cwd=` — also probes auto-permission support. */
    suspend fun grokModels(machineId: String, cwd: String): GrokModelsResponse

    /** `GET /api/machines/:id/copilot-models?cwd=`. */
    suspend fun copilotModels(machineId: String, cwd: String): CopilotModelsResponse

    /** `GET /api/machines/:id/kimi-models?cwd=`. */
    suspend fun kimiModels(machineId: String, cwd: String): KimiModelsResponse
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

    override suspend fun agyModels(machineId: String, refresh: Boolean): AgyModelsResponse =
        api.getMachineAgyModels(machineId, refresh)

    override suspend fun piModels(machineId: String): PiModelsResponse =
        api.getMachinePiModels(machineId)

    override suspend fun cursorModels(machineId: String): CursorModelsResponse =
        api.getMachineCursorModels(machineId)

    override suspend fun opencodeModels(machineId: String, cwd: String): OpencodeModelsResponse =
        api.getMachineOpencodeModels(machineId, cwd)

    override suspend fun opencodeModelVariants(machineId: String, cwd: String?): OpencodeModelVariantsResponse =
        api.getMachineOpencodeModelVariants(machineId, cwd)

    override suspend fun grokModels(machineId: String, cwd: String): GrokModelsResponse =
        api.getMachineGrokModels(machineId, cwd)

    override suspend fun copilotModels(machineId: String, cwd: String): CopilotModelsResponse =
        api.getMachineCopilotModels(machineId, cwd)

    override suspend fun kimiModels(machineId: String, cwd: String): KimiModelsResponse =
        api.getMachineKimiModels(machineId, cwd)
}

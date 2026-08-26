import Foundation
import HapiProtocol

/// Machines and spawning (`docs/api/client-contract/rest.md`).
extension APIClient {
    /// `GET /api/machines` — online machines in the caller's namespace.
    public func listMachines() async throws -> [Machine] {
        let response: MachinesResponse = try await request(.get, "/api/machines")
        return response.machines
    }

    /// `PATCH /api/machines/:id` — rename (≤ 64 chars; empty string clears
    /// the custom name back to the hostname).
    public func renameMachine(id: String, displayName: String) async throws {
        struct RenameMachineRequest: Encodable {
            let displayName: String
        }
        try await requestVoid(
            .patch,
            "/api/machines/\(encodePathComponent(id))",
            body: RenameMachineRequest(displayName: displayName)
        )
    }

    /// `POST /api/machines/:id/spawn`. The response is discriminated on
    /// `type`, not HTTP status — a failed spawn is still HTTP 200 with
    /// `.error`.
    public func spawnSession(machineId: String, _ spawn: SpawnRequest) async throws -> SpawnResponse {
        try await request(
            .post,
            "/api/machines/\(encodePathComponent(machineId))/spawn",
            body: spawn
        )
    }

    /// `GET /api/machines/:id/agent-availability` — executable/static-config
    /// availability for every supported Agent. A runner lacking the RPC
    /// answers 409 `runner_upgrade_required`.
    public func machineAgentAvailability(machineId: String) async throws -> AgentAvailabilityResponse {
        try await request(.get, "/api/machines/\(encodePathComponent(machineId))/agent-availability")
    }

    /// `POST /api/machines/:id/list-directory` (RPC envelope — check
    /// `success`).
    public func listMachineDirectory(
        machineId: String,
        path: String,
        includeHidden: Bool = false
    ) async throws -> MachineListDirectoryResponse {
        struct ListDirectoryRequest: Encodable {
            let path: String
            let includeHidden: Bool
        }
        return try await request(
            .post,
            "/api/machines/\(encodePathComponent(machineId))/list-directory",
            body: ListDirectoryRequest(path: path, includeHidden: includeHidden)
        )
    }

    /// `POST /api/machines/:id/paths/exists` (≤ 1000 paths).
    public func machinePathsExist(
        machineId: String,
        paths: [String]
    ) async throws -> MachinePathsExistsResponse {
        struct PathsExistsRequest: Encodable {
            let paths: [String]
        }
        return try await request(
            .post,
            "/api/machines/\(encodePathComponent(machineId))/paths/exists",
            body: PathsExistsRequest(paths: paths)
        )
    }

    /// `GET /api/machines/:id/codex-models` — pre-spawn codex model catalog
    /// (RPC envelope — check `success`). A runner without the machine-scoped
    /// RPC answers 503 `rpc_target_missing`, surfaced as an ``APIError``
    /// whose `code` the new-session form uses to hide the picker. Added in
    /// A-M3c (endpoint documented in `docs/api/client-contract/rest.md`).
    public func machineCodexModels(machineId: String) async throws -> CodexModelsResponse {
        try await request(.get, "/api/machines/\(encodePathComponent(machineId))/codex-models")
    }
}

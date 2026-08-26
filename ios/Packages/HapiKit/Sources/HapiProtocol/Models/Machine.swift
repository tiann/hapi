import Foundation

/// Machine (runner host) metadata written by the CLI.
///
/// Mirrors `MachineMetadataSchema` (`shared/src/schemas.ts`).
public struct MachineMetadata: Codable, Equatable, Sendable {
    public var host: String
    public var platform: String
    public var happyCliVersion: String
    public var displayName: String?
    public var homeDir: String?
    public var happyHomeDir: String?
    public var happyLibDir: String?
    public var workspaceRoots: [String]?
    /// Machine-scoped RPC capability ids this runner registers.
    public var capabilities: [String]?
    public var startedCliMtimeMs: Double?
    public var installedCliMtimeMs: Double?
    public var supervisedRestart: Bool?

    public init(
        host: String,
        platform: String,
        happyCliVersion: String,
        displayName: String? = nil,
        homeDir: String? = nil,
        happyHomeDir: String? = nil,
        happyLibDir: String? = nil,
        workspaceRoots: [String]? = nil,
        capabilities: [String]? = nil,
        startedCliMtimeMs: Double? = nil,
        installedCliMtimeMs: Double? = nil,
        supervisedRestart: Bool? = nil
    ) {
        self.host = host
        self.platform = platform
        self.happyCliVersion = happyCliVersion
        self.displayName = displayName
        self.homeDir = homeDir
        self.happyHomeDir = happyHomeDir
        self.happyLibDir = happyLibDir
        self.workspaceRoots = workspaceRoots
        self.capabilities = capabilities
        self.startedCliMtimeMs = startedCliMtimeMs
        self.installedCliMtimeMs = installedCliMtimeMs
        self.supervisedRestart = supervisedRestart
    }
}

/// Runner capability flags inside `RunnerState`.
///
/// `agentConfigs` (unified agent configuration descriptors) is kept
/// wire-verbatim; nothing in v1 consumes its internals.
public struct RunnerCapabilities: Codable, Equatable, Sendable {
    public var piExistingSessionResume: Bool?
    public var agentConfigs: [JSONValue]?

    public init(piExistingSessionResume: Bool? = nil, agentConfigs: [JSONValue]? = nil) {
        self.piExistingSessionResume = piExistingSessionResume
        self.agentConfigs = agentConfigs
    }
}

/// Runner daemon state reported per machine.
///
/// Mirrors `RunnerStateSchema` (`shared/src/schemas.ts`). `status` and
/// `shutdownSource` are open string unions on the wire (`enum | string`), so
/// they stay `String` with known-value helpers; `lastSpawnError` is kept
/// wire-verbatim.
public struct RunnerState: Codable, Equatable, Sendable {
    public var status: String
    public var pid: Int?
    public var httpPort: Int?
    public var startedAt: Int?
    public var capabilities: RunnerCapabilities?
    public var shutdownRequestedAt: Int?
    public var shutdownSource: String?
    public var lastSpawnError: JSONValue?

    public var isRunning: Bool { status == "running" }
    public var isShuttingDown: Bool { status == "shutting-down" }

    public init(
        status: String,
        pid: Int? = nil,
        httpPort: Int? = nil,
        startedAt: Int? = nil,
        capabilities: RunnerCapabilities? = nil,
        shutdownRequestedAt: Int? = nil,
        shutdownSource: String? = nil,
        lastSpawnError: JSONValue? = nil
    ) {
        self.status = status
        self.pid = pid
        self.httpPort = httpPort
        self.startedAt = startedAt
        self.capabilities = capabilities
        self.shutdownRequestedAt = shutdownRequestedAt
        self.shutdownSource = shutdownSource
        self.lastSpawnError = lastSpawnError
    }
}

/// Point-in-time host health sample.
///
/// Mirrors `MachineHealthSchema` (`shared/src/schemas.ts`). zod marks it
/// `.strict()`, but this decoder stays lenient on purpose: health is
/// advisory, and a new hub-side field must not break machine decoding.
public struct MachineHealth: Codable, Equatable, Sendable {
    public var collectedAt: Int
    public var cpuCount: Int?
    public var load1m: Double?
    public var cpuPercent: Double?
    public var memoryPercent: Double?
    public var uptimeSeconds: Double?

    public init(
        collectedAt: Int,
        cpuCount: Int? = nil,
        load1m: Double? = nil,
        cpuPercent: Double? = nil,
        memoryPercent: Double? = nil,
        uptimeSeconds: Double? = nil
    ) {
        self.collectedAt = collectedAt
        self.cpuCount = cpuCount
        self.load1m = load1m
        self.cpuPercent = cpuPercent
        self.memoryPercent = memoryPercent
        self.uptimeSeconds = uptimeSeconds
    }
}

/// One machine row of `GET /api/machines` and full-payload `machine-updated`
/// events.
///
/// Mirrors `MachineSchema` (`shared/src/schemas.ts:492-507`).
public struct Machine: Codable, Equatable, Sendable {
    public var id: String
    public var namespace: String
    public var seq: Int
    public var createdAt: Int
    public var updatedAt: Int
    public var active: Bool
    public var activeAt: Int
    public var metadata: MachineMetadata?
    public var metadataVersion: Int
    public var runnerState: RunnerState?
    public var runnerStateVersion: Int
    public var health: MachineHealth?

    public init(
        id: String,
        namespace: String,
        seq: Int,
        createdAt: Int,
        updatedAt: Int,
        active: Bool,
        activeAt: Int,
        metadata: MachineMetadata? = nil,
        metadataVersion: Int,
        runnerState: RunnerState? = nil,
        runnerStateVersion: Int,
        health: MachineHealth? = nil
    ) {
        self.id = id
        self.namespace = namespace
        self.seq = seq
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.active = active
        self.activeAt = activeAt
        self.metadata = metadata
        self.metadataVersion = metadataVersion
        self.runnerState = runnerState
        self.runnerStateVersion = runnerStateVersion
        self.health = health
    }
}

/// A flat `machine-updated` patch.
///
/// Mirrors `MachinePatchSchema` (`shared/src/schemas.ts:509-513`), zod
/// `.strict()` — strictness discriminates the
/// `Machine | MachinePatch | null` union (see `MachineUpdatedData`).
public struct MachinePatch: Equatable, Sendable {
    public var active: Bool?
    public var activeAt: Int?
    public var updatedAt: Int?

    public init(active: Bool? = nil, activeAt: Int? = nil, updatedAt: Int? = nil) {
        self.active = active
        self.activeAt = activeAt
        self.updatedAt = updatedAt
    }
}

extension MachinePatch: Codable {
    private enum CodingKeys: String, CodingKey, CaseIterable {
        case active
        case activeAt
        case updatedAt
    }

    public init(from decoder: Decoder) throws {
        try rejectUnknownKeys(
            in: decoder,
            known: Set(CodingKeys.allCases.map(\.stringValue)),
            payloadName: "MachinePatch"
        )
        let container = try decoder.container(keyedBy: CodingKeys.self)
        active = try container.decodeIfPresent(Bool.self, forKey: .active)
        activeAt = try container.decodeIfPresent(Int.self, forKey: .activeAt)
        updatedAt = try container.decodeIfPresent(Int.self, forKey: .updatedAt)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(active, forKey: .active)
        try container.encodeIfPresent(activeAt, forKey: .activeAt)
        try container.encodeIfPresent(updatedAt, forKey: .updatedAt)
    }
}

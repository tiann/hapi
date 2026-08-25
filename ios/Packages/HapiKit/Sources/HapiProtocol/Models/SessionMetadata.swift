import Foundation

/// How a session was launched. Shared by `SessionMetadata.startingMode` and
/// `AgentState.startingMode` (`z.enum(['local', 'remote', 'pty'])`).
public enum SessionStartingMode: String, Codable, Sendable {
    case local
    case remote
    case pty
}

/// The `metadata.summary` blob (`{text, updatedAt}`).
public struct SessionMetadataSummary: Codable, Equatable, Sendable {
    public var text: String
    public var updatedAt: Int

    public init(text: String, updatedAt: Int) {
        self.text = text
        self.updatedAt = updatedAt
    }
}

/// Worktree info for sessions spawned into a git worktree.
///
/// Mirrors `WorktreeMetadataSchema` (`shared/src/schemas.ts`).
public struct WorktreeMetadata: Codable, Equatable, Sendable {
    public var basePath: String
    public var branch: String
    public var name: String
    public var worktreePath: String?
    public var createdAt: Int?

    public init(
        basePath: String,
        branch: String,
        name: String,
        worktreePath: String? = nil,
        createdAt: Int? = nil
    ) {
        self.basePath = basePath
        self.branch = branch
        self.name = name
        self.worktreePath = worktreePath
        self.createdAt = createdAt
    }
}

/// Conversation-history feature toggles inside `SessionCapabilities`.
public struct ConversationHistoryCapabilities: Codable, Equatable, Sendable {
    public var forkCurrent: Bool?
    public var forkAtMessage: Bool?
    public var rewindToMessage: Bool?

    public init(
        forkCurrent: Bool? = nil,
        forkAtMessage: Bool? = nil,
        rewindToMessage: Bool? = nil
    ) {
        self.forkCurrent = forkCurrent
        self.forkAtMessage = forkAtMessage
        self.rewindToMessage = rewindToMessage
    }
}

/// Per-session capability flags advertised by the CLI.
public struct SessionCapabilities: Codable, Equatable, Sendable {
    public var terminal: Bool?
    public var conversationHistory: ConversationHistoryCapabilities?

    public init(
        terminal: Bool? = nil,
        conversationHistory: ConversationHistoryCapabilities? = nil
    ) {
        self.terminal = terminal
        self.conversationHistory = conversationHistory
    }
}

/// Typed subset of the session `metadata` blob (`MetadataSchema`,
/// `shared/src/schemas.ts:54-163`) covering what the app renders.
///
/// Decoding is lenient by construction: unknown wire fields (the per-flavor
/// native-session-id bookkeeping, fork/rewind maps, import state, ...) are
/// ignored by `JSONDecoder`, matching zod's default strip behavior. The CLI is
/// the only writer of metadata — natives never round-trip it to the hub, so
/// dropping fields we do not render is safe.
public struct SessionMetadata: Codable, Equatable, Sendable {
    /// Working directory of the session (required on the wire).
    public var path: String
    /// Hostname of the machine running the CLI (required on the wire).
    public var host: String
    /// User-assigned session name.
    public var name: String?
    public var os: String?
    public var summary: SessionMetadataSummary?
    public var machineId: String?
    /// Agent flavor id (`z.string().nullish()`); resolve with
    /// ``AgentFlavor/init(rawValue:)`` — unknown values map to `.other`.
    public var flavor: String?
    public var startingMode: SessionStartingMode?
    /// Free-form lifecycle marker (e.g. `running`, `archived`).
    public var lifecycleState: String?
    /// Durable link to the session that replaced this one after a
    /// clear/reopen; used to follow superseding sessions.
    public var supersededBySessionId: String?
    public var worktree: WorktreeMetadata?
    public var capabilities: SessionCapabilities?
    /// Loopback MCP URL when the session's CLI happy server is running.
    public var hapiMcpUrl: String?
    public var slashCommands: [String]?
    public var tools: [String]?
    // Per-flavor agent session ids (`MetadataSchema`) — the resume handle for
    // each CLI. Needed by the `SessionSummary.agentSessionId` projection
    // (`getSummaryAgentSessionId`, `shared/src/sessionSummary.ts`, ported in
    // `SummaryPatching`). Same field list as the Android reference port.
    public var claudeSessionId: String?
    public var codexSessionId: String?
    public var geminiSessionId: String?
    public var opencodeSessionId: String?
    public var grokSessionId: String?
    public var agySessionId: String?
    public var cursorSessionId: String?
    public var kimiSessionId: String?
    public var copilotSessionId: String?
    public var piSessionId: String?

    public init(
        path: String,
        host: String,
        name: String? = nil,
        os: String? = nil,
        summary: SessionMetadataSummary? = nil,
        machineId: String? = nil,
        flavor: String? = nil,
        startingMode: SessionStartingMode? = nil,
        lifecycleState: String? = nil,
        supersededBySessionId: String? = nil,
        worktree: WorktreeMetadata? = nil,
        capabilities: SessionCapabilities? = nil,
        hapiMcpUrl: String? = nil,
        slashCommands: [String]? = nil,
        tools: [String]? = nil,
        claudeSessionId: String? = nil,
        codexSessionId: String? = nil,
        geminiSessionId: String? = nil,
        opencodeSessionId: String? = nil,
        grokSessionId: String? = nil,
        agySessionId: String? = nil,
        cursorSessionId: String? = nil,
        kimiSessionId: String? = nil,
        copilotSessionId: String? = nil,
        piSessionId: String? = nil
    ) {
        self.path = path
        self.host = host
        self.name = name
        self.os = os
        self.summary = summary
        self.machineId = machineId
        self.flavor = flavor
        self.startingMode = startingMode
        self.lifecycleState = lifecycleState
        self.supersededBySessionId = supersededBySessionId
        self.worktree = worktree
        self.capabilities = capabilities
        self.hapiMcpUrl = hapiMcpUrl
        self.slashCommands = slashCommands
        self.tools = tools
        self.claudeSessionId = claudeSessionId
        self.codexSessionId = codexSessionId
        self.geminiSessionId = geminiSessionId
        self.opencodeSessionId = opencodeSessionId
        self.grokSessionId = grokSessionId
        self.agySessionId = agySessionId
        self.cursorSessionId = cursorSessionId
        self.kimiSessionId = kimiSessionId
        self.copilotSessionId = copilotSessionId
        self.piSessionId = piSessionId
    }
}

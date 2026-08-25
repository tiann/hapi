import Foundation

/// The full session record returned by `GET /api/sessions/:id` and carried by
/// full-payload `session-updated` SSE events.
///
/// Mirrors `SessionSchema` (`shared/src/schemas.ts:304-338`) field by field.
/// `metadataVersion` / `agentStateVersion` / `todosUpdatedAt` /
/// `teamStateUpdatedAt` are the watermarks the versioned-patch gate in
/// `applySessionDetailPatch(session:patch:)` checks against.
public struct Session: Codable, Equatable, Sendable {
    public var id: String
    public var namespace: String
    public var seq: Int
    public var createdAt: Int
    public var updatedAt: Int
    public var pinned: Bool?
    public var globalPinned: Bool?
    public var active: Bool
    /// Last keep-alive stamp (epoch ms). The wire may carry `null` for legacy
    /// rows; zod coerces to `0` and this decoder replicates that.
    public var activeAt: Int
    public var metadata: SessionMetadata?
    public var metadataVersion: Int
    public var agentState: AgentState?
    public var agentStateVersion: Int
    public var thinking: Bool
    public var thinkingAt: Int
    public var activeTurnStartedAt: Int?
    public var backgroundTaskCount: Int?
    public var todos: [TodoItem]?
    /// Team-mode state, kept wire-verbatim (no v1 UI consumes its internals).
    public var teamState: JSONValue?
    /// Version watermark for `todos` patches (absent = 0 when gating).
    public var todosUpdatedAt: Int?
    /// Version watermark for `teamState` patches (absent = 0 when gating).
    public var teamStateUpdatedAt: Int?
    public var model: String?
    public var modelReasoningEffort: String?
    public var effort: String?
    public var serviceTier: String?
    public var permissionMode: PermissionMode?
    public var collaborationMode: CodexCollaborationMode?
    public var copilotAgentMode: CopilotAgentMode?

    public init(
        id: String,
        namespace: String,
        seq: Int,
        createdAt: Int,
        updatedAt: Int,
        pinned: Bool? = nil,
        globalPinned: Bool? = nil,
        active: Bool,
        activeAt: Int,
        metadata: SessionMetadata? = nil,
        metadataVersion: Int,
        agentState: AgentState? = nil,
        agentStateVersion: Int,
        thinking: Bool,
        thinkingAt: Int,
        activeTurnStartedAt: Int? = nil,
        backgroundTaskCount: Int? = nil,
        todos: [TodoItem]? = nil,
        teamState: JSONValue? = nil,
        todosUpdatedAt: Int? = nil,
        teamStateUpdatedAt: Int? = nil,
        model: String? = nil,
        modelReasoningEffort: String? = nil,
        effort: String? = nil,
        serviceTier: String? = nil,
        permissionMode: PermissionMode? = nil,
        collaborationMode: CodexCollaborationMode? = nil,
        copilotAgentMode: CopilotAgentMode? = nil
    ) {
        self.id = id
        self.namespace = namespace
        self.seq = seq
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.pinned = pinned
        self.globalPinned = globalPinned
        self.active = active
        self.activeAt = activeAt
        self.metadata = metadata
        self.metadataVersion = metadataVersion
        self.agentState = agentState
        self.agentStateVersion = agentStateVersion
        self.thinking = thinking
        self.thinkingAt = thinkingAt
        self.activeTurnStartedAt = activeTurnStartedAt
        self.backgroundTaskCount = backgroundTaskCount
        self.todos = todos
        self.teamState = teamState
        self.todosUpdatedAt = todosUpdatedAt
        self.teamStateUpdatedAt = teamStateUpdatedAt
        self.model = model
        self.modelReasoningEffort = modelReasoningEffort
        self.effort = effort
        self.serviceTier = serviceTier
        self.permissionMode = permissionMode
        self.collaborationMode = collaborationMode
        self.copilotAgentMode = copilotAgentMode
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        namespace = try container.decode(String.self, forKey: .namespace)
        seq = try container.decode(Int.self, forKey: .seq)
        createdAt = try container.decode(Int.self, forKey: .createdAt)
        updatedAt = try container.decode(Int.self, forKey: .updatedAt)
        pinned = try container.decodeIfPresent(Bool.self, forKey: .pinned)
        globalPinned = try container.decodeIfPresent(Bool.self, forKey: .globalPinned)
        active = try container.decode(Bool.self, forKey: .active)
        // zod: `z.number().nullish().transform((value) => value ?? 0)`.
        activeAt = try container.decodeIfPresent(Int.self, forKey: .activeAt) ?? 0
        metadata = try container.decodeIfPresent(SessionMetadata.self, forKey: .metadata)
        metadataVersion = try container.decode(Int.self, forKey: .metadataVersion)
        agentState = try container.decodeIfPresent(AgentState.self, forKey: .agentState)
        agentStateVersion = try container.decode(Int.self, forKey: .agentStateVersion)
        thinking = try container.decode(Bool.self, forKey: .thinking)
        thinkingAt = try container.decode(Int.self, forKey: .thinkingAt)
        activeTurnStartedAt = try container.decodeIfPresent(Int.self, forKey: .activeTurnStartedAt)
        backgroundTaskCount = try container.decodeIfPresent(Int.self, forKey: .backgroundTaskCount)
        todos = try container.decodeIfPresent([TodoItem].self, forKey: .todos)
        teamState = try container.decodeIfPresent(JSONValue.self, forKey: .teamState)
        todosUpdatedAt = try container.decodeIfPresent(Int.self, forKey: .todosUpdatedAt)
        teamStateUpdatedAt = try container.decodeIfPresent(Int.self, forKey: .teamStateUpdatedAt)
        model = try container.decodeIfPresent(String.self, forKey: .model)
        modelReasoningEffort = try container.decodeIfPresent(String.self, forKey: .modelReasoningEffort)
        effort = try container.decodeIfPresent(String.self, forKey: .effort)
        serviceTier = try container.decodeIfPresent(String.self, forKey: .serviceTier)
        permissionMode = try container.decodeIfPresent(PermissionMode.self, forKey: .permissionMode)
        collaborationMode = try container.decodeIfPresent(CodexCollaborationMode.self, forKey: .collaborationMode)
        copilotAgentMode = try container.decodeIfPresent(CopilotAgentMode.self, forKey: .copilotAgentMode)
    }
}

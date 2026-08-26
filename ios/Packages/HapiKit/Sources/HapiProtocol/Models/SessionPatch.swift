import Foundation

/// A `{version, value}` wrapper carried by structured `session-updated`
/// patches for `metadata` / `agentState` / `todos` / `teamState`.
///
/// The version is the only safe way to reject stale patches: the dual SSE
/// connections have no shared ordering, so `value` must be applied — and the
/// matching watermark stored — only when `version` is strictly greater than
/// the cached one (see `isNewerVersionedPatch(patchVersion:cachedVersion:)`).
/// Never assign the wrapper itself into a `Session`.
public struct VersionedValue<Value: Codable & Equatable & Sendable>: Codable, Equatable, Sendable {
    public var version: Int
    /// `nil` covers wire-`null` (explicit clear, e.g. team deletion).
    public var value: Value?

    public init(version: Int, value: Value?) {
        self.version = version
        self.value = value
    }
}

/// A patch field whose wire type is `T | null`, where "key absent" and
/// "key present with null" mean different things.
///
/// `SessionPatch.model = nil` means the patch does not touch `model`;
/// `.null` means the patch explicitly clears it. Swift's synthesized Codable
/// (`decodeIfPresent`) conflates the two, so `SessionPatch` decodes these by
/// hand via `contains` + `decodeNil`.
public enum PatchField<Value: Codable & Equatable & Sendable>: Equatable, Sendable {
    case null
    case value(Value)

    /// The value as it would appear after applying: `nil` for `.null`.
    public var wireValue: Value? {
        if case .value(let value) = self { return value }
        return nil
    }
}

/// A structured `session-updated` patch.
///
/// Mirrors `SessionPatchSchema` (`shared/src/schemas.ts:371-404`), which is
/// zod `.strict()`: unknown keys make decoding throw. That strictness is
/// load-bearing — `SessionUpdatedData` discriminates the
/// `Session | SessionPatch` union by attempting `Session` first and falling
/// back to the strict patch, so a malformed full session must not silently
/// half-decode as a lenient patch.
public struct SessionPatch: Equatable, Sendable {
    public var active: Bool?
    public var thinking: Bool?
    /// Carried on the wire but NOT applied by `applySessionDetailPatch`
    /// (mirroring `web/src/lib/sessionPatch.ts`).
    public var activeTurnStartedAt: PatchField<Int>?
    public var activeAt: Int?
    public var updatedAt: Int?
    public var metadata: VersionedValue<SessionMetadata>?
    public var agentState: VersionedValue<AgentState>?
    public var todos: VersionedValue<[TodoItem]>?
    public var teamState: VersionedValue<JSONValue>?
    public var model: PatchField<String>?
    public var modelReasoningEffort: PatchField<String>?
    public var effort: PatchField<String>?
    public var serviceTier: PatchField<String>?
    public var permissionMode: PermissionMode?
    public var collaborationMode: CodexCollaborationMode?
    public var copilotAgentMode: CopilotAgentMode?
    public var backgroundTaskCount: Int?
    /// Bare refetch trigger for `GET /api/sessions/:id/scratchlist`; never
    /// applied onto the `Session` (which carries no such field).
    public var scratchlistUpdatedAt: Int?

    public init(
        active: Bool? = nil,
        thinking: Bool? = nil,
        activeTurnStartedAt: PatchField<Int>? = nil,
        activeAt: Int? = nil,
        updatedAt: Int? = nil,
        metadata: VersionedValue<SessionMetadata>? = nil,
        agentState: VersionedValue<AgentState>? = nil,
        todos: VersionedValue<[TodoItem]>? = nil,
        teamState: VersionedValue<JSONValue>? = nil,
        model: PatchField<String>? = nil,
        modelReasoningEffort: PatchField<String>? = nil,
        effort: PatchField<String>? = nil,
        serviceTier: PatchField<String>? = nil,
        permissionMode: PermissionMode? = nil,
        collaborationMode: CodexCollaborationMode? = nil,
        copilotAgentMode: CopilotAgentMode? = nil,
        backgroundTaskCount: Int? = nil,
        scratchlistUpdatedAt: Int? = nil
    ) {
        self.active = active
        self.thinking = thinking
        self.activeTurnStartedAt = activeTurnStartedAt
        self.activeAt = activeAt
        self.updatedAt = updatedAt
        self.metadata = metadata
        self.agentState = agentState
        self.todos = todos
        self.teamState = teamState
        self.model = model
        self.modelReasoningEffort = modelReasoningEffort
        self.effort = effort
        self.serviceTier = serviceTier
        self.permissionMode = permissionMode
        self.collaborationMode = collaborationMode
        self.copilotAgentMode = copilotAgentMode
        self.backgroundTaskCount = backgroundTaskCount
        self.scratchlistUpdatedAt = scratchlistUpdatedAt
    }
}

extension SessionPatch: Codable {
    private enum CodingKeys: String, CodingKey, CaseIterable {
        case active
        case thinking
        case activeTurnStartedAt
        case activeAt
        case updatedAt
        case metadata
        case agentState
        case todos
        case teamState
        case model
        case modelReasoningEffort
        case effort
        case serviceTier
        case permissionMode
        case collaborationMode
        case copilotAgentMode
        case backgroundTaskCount
        case scratchlistUpdatedAt
    }

    public init(from decoder: Decoder) throws {
        // Mirror zod `.strict()`: any unknown key rejects the whole patch.
        try rejectUnknownKeys(
            in: decoder,
            known: Set(CodingKeys.allCases.map(\.stringValue)),
            payloadName: "SessionPatch"
        )
        let container = try decoder.container(keyedBy: CodingKeys.self)
        active = try container.decodeIfPresent(Bool.self, forKey: .active)
        thinking = try container.decodeIfPresent(Bool.self, forKey: .thinking)
        activeTurnStartedAt = try Self.decodePatchField(Int.self, in: container, forKey: .activeTurnStartedAt)
        activeAt = try container.decodeIfPresent(Int.self, forKey: .activeAt)
        updatedAt = try container.decodeIfPresent(Int.self, forKey: .updatedAt)
        metadata = try container.decodeIfPresent(VersionedValue<SessionMetadata>.self, forKey: .metadata)
        agentState = try container.decodeIfPresent(VersionedValue<AgentState>.self, forKey: .agentState)
        todos = try container.decodeIfPresent(VersionedValue<[TodoItem]>.self, forKey: .todos)
        teamState = try container.decodeIfPresent(VersionedValue<JSONValue>.self, forKey: .teamState)
        model = try Self.decodePatchField(String.self, in: container, forKey: .model)
        modelReasoningEffort = try Self.decodePatchField(String.self, in: container, forKey: .modelReasoningEffort)
        effort = try Self.decodePatchField(String.self, in: container, forKey: .effort)
        serviceTier = try Self.decodePatchField(String.self, in: container, forKey: .serviceTier)
        permissionMode = try container.decodeIfPresent(PermissionMode.self, forKey: .permissionMode)
        collaborationMode = try container.decodeIfPresent(CodexCollaborationMode.self, forKey: .collaborationMode)
        copilotAgentMode = try container.decodeIfPresent(CopilotAgentMode.self, forKey: .copilotAgentMode)
        backgroundTaskCount = try container.decodeIfPresent(Int.self, forKey: .backgroundTaskCount)
        scratchlistUpdatedAt = try container.decodeIfPresent(Int.self, forKey: .scratchlistUpdatedAt)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(active, forKey: .active)
        try container.encodeIfPresent(thinking, forKey: .thinking)
        try Self.encodePatchField(activeTurnStartedAt, in: &container, forKey: .activeTurnStartedAt)
        try container.encodeIfPresent(activeAt, forKey: .activeAt)
        try container.encodeIfPresent(updatedAt, forKey: .updatedAt)
        try container.encodeIfPresent(metadata, forKey: .metadata)
        try container.encodeIfPresent(agentState, forKey: .agentState)
        try container.encodeIfPresent(todos, forKey: .todos)
        try container.encodeIfPresent(teamState, forKey: .teamState)
        try Self.encodePatchField(model, in: &container, forKey: .model)
        try Self.encodePatchField(modelReasoningEffort, in: &container, forKey: .modelReasoningEffort)
        try Self.encodePatchField(effort, in: &container, forKey: .effort)
        try Self.encodePatchField(serviceTier, in: &container, forKey: .serviceTier)
        try container.encodeIfPresent(permissionMode, forKey: .permissionMode)
        try container.encodeIfPresent(collaborationMode, forKey: .collaborationMode)
        try container.encodeIfPresent(copilotAgentMode, forKey: .copilotAgentMode)
        try container.encodeIfPresent(backgroundTaskCount, forKey: .backgroundTaskCount)
        try container.encodeIfPresent(scratchlistUpdatedAt, forKey: .scratchlistUpdatedAt)
    }

    private static func decodePatchField<Value: Codable & Equatable & Sendable>(
        _ type: Value.Type,
        in container: KeyedDecodingContainer<CodingKeys>,
        forKey key: CodingKeys
    ) throws -> PatchField<Value>? {
        guard container.contains(key) else { return nil }
        if try container.decodeNil(forKey: key) { return .null }
        return .value(try container.decode(Value.self, forKey: key))
    }

    private static func encodePatchField<Value: Codable & Equatable & Sendable>(
        _ field: PatchField<Value>?,
        in container: inout KeyedEncodingContainer<CodingKeys>,
        forKey key: CodingKeys
    ) throws {
        guard let field else { return }
        switch field {
        case .null:
            try container.encodeNil(forKey: key)
        case .value(let value):
            try container.encode(value, forKey: key)
        }
    }
}

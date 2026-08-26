import Foundation

// Chat pipeline types — port of web/src/chat/types.ts.
//
// TS `unknown` fields are `JSONValue`; the TS `undefined` vs JSON `null`
// distinction is preserved wherever the normative projection can observe it
// (`JSONValue?` where `nil` == absent/`undefined` and `.null` == JSON null).
// Fields the projection cannot observe (timing, presentation) collapse
// `null`/`undefined` into plain optionals.

// MARK: - Usage

/// Port of `UsageData` (types.ts). Field names keep the wire snake_case
/// identity in comments; Swift naming is camelCase.
public struct UsageData: Equatable, Sendable {
    /// `input_tokens`
    public var inputTokens: Double
    /// `output_tokens`
    public var outputTokens: Double
    /// `cache_creation_input_tokens`
    public var cacheCreationInputTokens: Double?
    /// `cache_read_input_tokens`
    public var cacheReadInputTokens: Double?
    /// `context_tokens`
    public var contextTokens: Double?
    /// `context_window`
    public var contextWindow: Double?
    /// `thread_id`
    public var threadId: String?
    /// `scope_role`
    public var scopeRole: String?
    /// `service_tier`
    public var serviceTier: String?

    public init(
        inputTokens: Double,
        outputTokens: Double,
        cacheCreationInputTokens: Double? = nil,
        cacheReadInputTokens: Double? = nil,
        contextTokens: Double? = nil,
        contextWindow: Double? = nil,
        threadId: String? = nil,
        scopeRole: String? = nil,
        serviceTier: String? = nil
    ) {
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cacheCreationInputTokens = cacheCreationInputTokens
        self.cacheReadInputTokens = cacheReadInputTokens
        self.contextTokens = contextTokens
        self.contextWindow = contextWindow
        self.threadId = threadId
        self.scopeRole = scopeRole
        self.serviceTier = serviceTier
    }
}

// MARK: - AgentEvent

/// Port of the `AgentEvent` union (types.ts).
///
/// The web keeps events as raw records: the `'event'` payload family passes
/// `data` through verbatim (extra keys included — the union's last member is
/// `{type: string} & Record<string, unknown>`), and the projection emits the
/// object untouched. To reproduce that byte-for-byte, the port stores the
/// full object and layers a typed view on top:
///   - `object` — the event exactly as the reference would hold it
///   - `kind` + typed accessors — the discriminated view reducers switch on
///   - static constructors — the synthesized shapes (system subtypes, codex
///     events, limit parsing, …) with exactly the reference's key sets.
public struct AgentEvent: Equatable, Sendable {
    /// The full event record, `type` key included.
    public var object: [String: JSONValue]

    public init(object: [String: JSONValue]) {
        self.object = object
    }

    public var type: String {
        object["type"]?.stringValue ?? ""
    }

    public subscript(key: String) -> JSONValue? {
        object[key]
    }

    public var wireValue: JSONValue { .object(object) }

    /// Typed view over `type` for exhaustive switching in consumers.
    public enum Kind: Equatable, Sendable {
        case switchMode
        case message
        case error
        case titleChanged
        case limitReached
        case limitWarning
        case ready
        case apiError
        case turnDuration
        case microcompact
        case compact
        case compactSummary
        case recap
        case threadGoalUpdated
        case threadGoalCleared
        case abortRestore
        case tokenCount
        case agentRunStart
        case agentRunUpdate
        case agentRunTrace
        case custom(String)
    }

    public var kind: Kind {
        switch type {
        case "switch": return .switchMode
        case "message": return .message
        case "error": return .error
        case "title-changed": return .titleChanged
        case "limit-reached": return .limitReached
        case "limit-warning": return .limitWarning
        case "ready": return .ready
        case "api-error": return .apiError
        case "turn-duration": return .turnDuration
        case "microcompact": return .microcompact
        case "compact": return .compact
        case "compact-summary": return .compactSummary
        case "recap": return .recap
        case "thread-goal-updated": return .threadGoalUpdated
        case "thread-goal-cleared": return .threadGoalCleared
        case "abort-restore": return .abortRestore
        case "token-count": return .tokenCount
        case "agent-run-start": return .agentRunStart
        case "agent-run-update": return .agentRunUpdate
        case "agent-run-trace": return .agentRunTrace
        default: return .custom(type)
        }
    }

    // Typed constructors — key sets mirror normalizeAgent.ts / the reducers.

    public static func message(_ text: String) -> AgentEvent {
        AgentEvent(object: ["type": .string("message"), "message": .string(text)])
    }

    public static func error(_ text: String) -> AgentEvent {
        AgentEvent(object: ["type": .string("error"), "message": .string(text)])
    }

    public static func titleChanged(_ title: String) -> AgentEvent {
        AgentEvent(object: ["type": .string("title-changed"), "title": .string(title)])
    }

    public static func limitReached(endsAt: Double, limitType: String) -> AgentEvent {
        AgentEvent(object: [
            "type": .string("limit-reached"),
            "endsAt": .number(endsAt),
            "limitType": .string(limitType),
        ])
    }

    public static func limitWarning(utilization: Double, endsAt: Double, limitType: String) -> AgentEvent {
        AgentEvent(object: [
            "type": .string("limit-warning"),
            "utilization": .number(utilization),
            "endsAt": .number(endsAt),
            "limitType": .string(limitType),
        ])
    }

    /// `error` is carried verbatim; an absent wire value omits the key
    /// (JSON.stringify drops `undefined` properties).
    public static func apiError(retryAttempt: Double, maxRetries: Double, error: JSONValue?) -> AgentEvent {
        var object: [String: JSONValue] = [
            "type": .string("api-error"),
            "retryAttempt": .number(retryAttempt),
            "maxRetries": .number(maxRetries),
        ]
        if let error { object["error"] = error }
        return AgentEvent(object: object)
    }

    public static func turnDuration(durationMs: Double, targetMessageId: String?) -> AgentEvent {
        var object: [String: JSONValue] = [
            "type": .string("turn-duration"),
            "durationMs": .number(durationMs),
        ]
        if let targetMessageId { object["targetMessageId"] = .string(targetMessageId) }
        return AgentEvent(object: object)
    }

    public static func microcompact(trigger: String, preTokens: Double, tokensSaved: Double) -> AgentEvent {
        AgentEvent(object: [
            "type": .string("microcompact"),
            "trigger": .string(trigger),
            "preTokens": .number(preTokens),
            "tokensSaved": .number(tokensSaved),
        ])
    }

    public static func compact(trigger: String, preTokens: Double) -> AgentEvent {
        AgentEvent(object: [
            "type": .string("compact"),
            "trigger": .string(trigger),
            "preTokens": .number(preTokens),
        ])
    }

    public static func compactSummary(summary: String, tokensBefore: Double?, estimatedTokensAfter: Double?) -> AgentEvent {
        var object: [String: JSONValue] = [
            "type": .string("compact-summary"),
            "summary": .string(summary),
        ]
        if let tokensBefore { object["tokensBefore"] = .number(tokensBefore) }
        if let estimatedTokensAfter { object["estimatedTokensAfter"] = .number(estimatedTokensAfter) }
        return AgentEvent(object: object)
    }

    public static func recap(text: String) -> AgentEvent {
        AgentEvent(object: ["type": .string("recap"), "text": .string(text)])
    }

    public static func ready(agentId: String) -> AgentEvent {
        AgentEvent(object: ["type": .string("ready"), "agentId": .string(agentId)])
    }

    public static func tokenCount(info: JSONValue?) -> AgentEvent {
        var object: [String: JSONValue] = ["type": .string("token-count")]
        if let info { object["info"] = info }
        return AgentEvent(object: object)
    }

    public static func threadGoalUpdated(threadId: String, turnId: String?, goal: JSONValue) -> AgentEvent {
        var object: [String: JSONValue] = [
            "type": .string("thread-goal-updated"),
            "threadId": .string(threadId),
            "goal": goal,
        ]
        if let turnId { object["turnId"] = .string(turnId) }
        return AgentEvent(object: object)
    }

    public static func threadGoalCleared(threadId: String?) -> AgentEvent {
        var object: [String: JSONValue] = ["type": .string("thread-goal-cleared")]
        if let threadId { object["threadId"] = .string(threadId) }
        return AgentEvent(object: object)
    }
}

// MARK: - Tool permission

public enum ToolPermissionStatus: String, Equatable, Sendable {
    case pending
    case approved
    case denied
    case canceled
}

/// Permission decision values shared with `AgentStateCompletedRequest`.
public typealias ToolPermissionDecision = AgentStateCompletedRequest.Decision

/// Port of `ToolResultPermission` (types.ts) — the `permissions` object a
/// Claude tool_result block may embed.
public struct ToolResultPermission: Equatable, Sendable {
    public enum Result: String, Equatable, Sendable {
        case approved
        case denied
    }

    public var date: Double
    public var result: Result
    public var mode: String?
    public var allowedTools: [String]?
    public var decision: ToolPermissionDecision?

    public init(
        date: Double,
        result: Result,
        mode: String? = nil,
        allowedTools: [String]? = nil,
        decision: ToolPermissionDecision? = nil
    ) {
        self.date = date
        self.result = result
        self.mode = mode
        self.allowedTools = allowedTools
        self.decision = decision
    }
}

/// Port of `ToolPermission` (types.ts).
///
/// The reference merges permission objects with JS object spread, where a key
/// present with an `undefined` value still OVERWRITES the base's value.
/// `presentKeys` records which optional keys a given construction site
/// carried (mirroring the TS object literals), so `spreading(_:with:)` can
/// reproduce spread semantics exactly. `id`/`status` are present at every
/// site and excluded from the set.
public struct ToolPermission: Equatable, Sendable {
    public struct PresentKeys: OptionSet, Equatable, Sendable {
        public let rawValue: Int
        public init(rawValue: Int) { self.rawValue = rawValue }

        public static let reason = PresentKeys(rawValue: 1 << 0)
        public static let mode = PresentKeys(rawValue: 1 << 1)
        public static let decision = PresentKeys(rawValue: 1 << 2)
        public static let allowedTools = PresentKeys(rawValue: 1 << 3)
        public static let answers = PresentKeys(rawValue: 1 << 4)
        public static let date = PresentKeys(rawValue: 1 << 5)
        public static let createdAt = PresentKeys(rawValue: 1 << 6)
        public static let completedAt = PresentKeys(rawValue: 1 << 7)
    }

    public var id: String
    public var status: ToolPermissionStatus
    public var reason: String?
    public var mode: String?
    public var allowedTools: [String]?
    public var decision: ToolPermissionDecision?
    /// Two wire shapes, kept raw: flat `{q: [answers]}` (AskUserQuestion) or
    /// nested `{q: {answers: [...]}}` (request_user_input).
    public var answers: JSONValue?
    public var date: Double?
    public var createdAt: Int?
    public var completedAt: Int?
    public var presentKeys: PresentKeys

    public init(
        id: String,
        status: ToolPermissionStatus,
        reason: String? = nil,
        mode: String? = nil,
        allowedTools: [String]? = nil,
        decision: ToolPermissionDecision? = nil,
        answers: JSONValue? = nil,
        date: Double? = nil,
        createdAt: Int? = nil,
        completedAt: Int? = nil,
        presentKeys: PresentKeys = []
    ) {
        self.id = id
        self.status = status
        self.reason = reason
        self.mode = mode
        self.allowedTools = allowedTools
        self.decision = decision
        self.answers = answers
        self.date = date
        self.createdAt = createdAt
        self.completedAt = completedAt
        self.presentKeys = presentKeys
    }

    /// JS `{ ...base, ...seed }`: the seed's value wins for every key the
    /// seed carries (even when that value is `undefined`); the base's value
    /// survives for keys the seed does not carry.
    public static func spreading(_ base: ToolPermission?, with seed: ToolPermission) -> ToolPermission {
        guard let base else { return seed }
        var merged = seed
        if !seed.presentKeys.contains(.reason) { merged.reason = base.reason }
        if !seed.presentKeys.contains(.mode) { merged.mode = base.mode }
        if !seed.presentKeys.contains(.decision) { merged.decision = base.decision }
        if !seed.presentKeys.contains(.allowedTools) { merged.allowedTools = base.allowedTools }
        if !seed.presentKeys.contains(.answers) { merged.answers = base.answers }
        if !seed.presentKeys.contains(.date) { merged.date = base.date }
        if !seed.presentKeys.contains(.createdAt) { merged.createdAt = base.createdAt }
        if !seed.presentKeys.contains(.completedAt) { merged.completedAt = base.completedAt }
        merged.presentKeys = base.presentKeys.union(seed.presentKeys)
        return merged
    }
}

// MARK: - Normalized agent content

/// Port of the `ToolUse` member of `NormalizedAgentContent`.
public struct ToolUseContent: Equatable, Sendable {
    public var id: String
    public var name: String
    /// `nil` == the tool_use block had no `input` key (TS `undefined`).
    public var input: JSONValue?
    public var description: String?
    public var nativeTitle: String?
    public var nativeKind: String?
    /// `nil` == no `progress` key on the wire payload.
    public var progress: JSONValue?
    public var uuid: String
    public var parentUUID: String?

    public init(
        id: String,
        name: String,
        input: JSONValue? = nil,
        description: String? = nil,
        nativeTitle: String? = nil,
        nativeKind: String? = nil,
        progress: JSONValue? = nil,
        uuid: String,
        parentUUID: String? = nil
    ) {
        self.id = id
        self.name = name
        self.input = input
        self.description = description
        self.nativeTitle = nativeTitle
        self.nativeKind = nativeKind
        self.progress = progress
        self.uuid = uuid
        self.parentUUID = parentUUID
    }
}

/// Port of the `ToolResult` member of `NormalizedAgentContent`.
public struct ToolResultContent: Equatable, Sendable {
    public var toolUseId: String
    /// `nil` == the tool_result carried no content (TS `undefined`);
    /// `.null` == an explicit JSON null result.
    public var content: JSONValue?
    public var isError: Bool
    public var uuid: String
    public var parentUUID: String?
    public var permissions: ToolResultPermission?

    public init(
        toolUseId: String,
        content: JSONValue? = nil,
        isError: Bool = false,
        uuid: String,
        parentUUID: String? = nil,
        permissions: ToolResultPermission? = nil
    ) {
        self.toolUseId = toolUseId
        self.content = content
        self.isError = isError
        self.uuid = uuid
        self.parentUUID = parentUUID
        self.permissions = permissions
    }
}

/// Port of `GeneratedImageContent`.
public struct GeneratedImageContent: Equatable, Sendable {
    public var imageId: String
    public var fileName: String
    public var mimeType: String?
    public var uuid: String
    public var parentUUID: String?
    public var source: InlineMediaSource?

    public init(
        imageId: String,
        fileName: String,
        mimeType: String? = nil,
        uuid: String,
        parentUUID: String? = nil,
        source: InlineMediaSource? = nil
    ) {
        self.imageId = imageId
        self.fileName = fileName
        self.mimeType = mimeType
        self.uuid = uuid
        self.parentUUID = parentUUID
        self.source = source
    }
}

/// Port of `InlineMediaSource` (web/src/chat/inlineMediaSource.ts).
public struct InlineMediaSource: Equatable, Sendable {
    public enum Ingress: String, Equatable, Sendable {
        case mcp
        case acp
        case toolResult = "tool_result"
    }

    public var ingress: Ingress
    public var flavor: String?
    public var toolCallId: String?
    public var toolName: String?

    public init(ingress: Ingress, flavor: String? = nil, toolCallId: String? = nil, toolName: String? = nil) {
        self.ingress = ingress
        self.flavor = flavor
        self.toolCallId = toolCallId
        self.toolName = toolName
    }

    /// Port of `inlineMediaSourceFromWire`.
    public static func fromWire(_ value: JSONValue?) -> InlineMediaSource? {
        guard let record = value?.objectValue else { return nil }
        let rawIngress = record["ingress"]?.stringValue ?? record["path"]?.stringValue
        guard let rawIngress, let ingress = Ingress(rawValue: rawIngress) else { return nil }
        let toolCallId = record["toolCallId"]?.stringValue ?? record["tool_call_id"]?.stringValue
        let toolName = record["toolName"]?.stringValue ?? record["tool_name"]?.stringValue
        return InlineMediaSource(
            ingress: ingress,
            flavor: record["flavor"]?.stringValue,
            toolCallId: toolCallId,
            toolName: toolName
        )
    }
}

/// Port of `CodexReviewFinding`.
public struct CodexReviewFinding: Equatable, Sendable {
    public var title: String
    public var body: String
    public var priority: Double?
    public var confidenceScore: Double?
    public var filePath: String?
    public var lineStart: Double?
    public var lineEnd: Double?

    public init(
        title: String,
        body: String,
        priority: Double? = nil,
        confidenceScore: Double? = nil,
        filePath: String? = nil,
        lineStart: Double? = nil,
        lineEnd: Double? = nil
    ) {
        self.title = title
        self.body = body
        self.priority = priority
        self.confidenceScore = confidenceScore
        self.filePath = filePath
        self.lineStart = lineStart
        self.lineEnd = lineEnd
    }
}

/// Port of `CodexReview`. The TS object stores explicit `null`s for absent
/// members and the projection carries the object verbatim, so
/// `wireValue` emits every key with `null` where the optional is `nil`.
public struct CodexReview: Equatable, Sendable {
    public var findings: [CodexReviewFinding]
    public var overallCorrectness: String?
    public var overallExplanation: String?
    public var overallConfidenceScore: Double?

    public init(
        findings: [CodexReviewFinding],
        overallCorrectness: String? = nil,
        overallExplanation: String? = nil,
        overallConfidenceScore: Double? = nil
    ) {
        self.findings = findings
        self.overallCorrectness = overallCorrectness
        self.overallExplanation = overallExplanation
        self.overallConfidenceScore = overallConfidenceScore
    }

    // Built stepwise (not as one literal) — the nested dictionary/`??`
    // expression exceeded the Swift 6 type-checker budget on Linux.
    public var wireValue: JSONValue {
        var object: [String: JSONValue] = [:]
        object["findings"] = .array(findings.map(Self.findingWireValue(_:)))
        object["overallCorrectness"] = overallCorrectness.map { JSONValue.string($0) } ?? .null
        object["overallExplanation"] = overallExplanation.map { JSONValue.string($0) } ?? .null
        object["overallConfidenceScore"] = overallConfidenceScore.map { JSONValue.number($0) } ?? .null
        return .object(object)
    }

    private static func findingWireValue(_ finding: CodexReviewFinding) -> JSONValue {
        var object: [String: JSONValue] = [:]
        object["title"] = .string(finding.title)
        object["body"] = .string(finding.body)
        object["priority"] = finding.priority.map { JSONValue.number($0) } ?? .null
        object["confidenceScore"] = finding.confidenceScore.map { JSONValue.number($0) } ?? .null
        object["filePath"] = finding.filePath.map { JSONValue.string($0) } ?? .null
        object["lineStart"] = finding.lineStart.map { JSONValue.number($0) } ?? .null
        object["lineEnd"] = finding.lineEnd.map { JSONValue.number($0) } ?? .null
        return .object(object)
    }
}

/// Port of `NormalizedAgentContent`.
public enum NormalizedAgentContent: Equatable, Sendable {
    case text(TextContent)
    case reasoning(TextContent)
    case toolCall(ToolUseContent)
    case toolResult(ToolResultContent)
    case generatedImage(GeneratedImageContent)
    case codexReview(review: CodexReview, uuid: String, parentUUID: String?)
    case summary(String)
    case sidechain(SidechainContent)

    public struct TextContent: Equatable, Sendable {
        public var text: String
        public var uuid: String
        public var streamId: String?
        public var parentUUID: String?

        public init(text: String, uuid: String, streamId: String? = nil, parentUUID: String? = nil) {
            self.text = text
            self.uuid = uuid
            self.streamId = streamId
            self.parentUUID = parentUUID
        }
    }

    public struct SidechainContent: Equatable, Sendable {
        public var uuid: String
        public var parentUUID: String?
        public var prompt: String

        public init(uuid: String, parentUUID: String? = nil, prompt: String) {
            self.uuid = uuid
            self.parentUUID = parentUUID
            self.prompt = prompt
        }
    }

    /// `content[0].uuid` access in the tracer — the summary member has none.
    public var uuid: String? {
        switch self {
        case .text(let value), .reasoning(let value): return value.uuid
        case .toolCall(let value): return value.uuid
        case .toolResult(let value): return value.uuid
        case .generatedImage(let value): return value.uuid
        case .codexReview(_, let uuid, _): return uuid
        case .summary: return nil
        case .sidechain(let value): return value.uuid
        }
    }

    public var parentUUID: String? {
        switch self {
        case .text(let value), .reasoning(let value): return value.parentUUID
        case .toolCall(let value): return value.parentUUID
        case .toolResult(let value): return value.parentUUID
        case .generatedImage(let value): return value.parentUUID
        case .codexReview(_, _, let parentUUID): return parentUUID
        case .summary: return nil
        case .sidechain(let value): return value.parentUUID
        }
    }
}

// MARK: - Normalized message

/// Port of `NormalizedMessage` (types.ts) with the tracer's `sidechainId`
/// folded in (the TS `TracedMessage` is a spread-extension of it).
public struct NormalizedMessage: Equatable, Sendable {
    public enum Content: Equatable, Sendable {
        case user(text: String, attachments: [AttachmentMetadata]?)
        case agent([NormalizedAgentContent])
        case event(AgentEvent)
    }

    public var id: String
    public var localId: String?
    public var createdAt: Int
    public var content: Content
    public var isSidechain: Bool
    /// SDK `parent_tool_use_id` — groups sidechain messages under their
    /// parent Agent/Task card.
    public var parentToolUseId: String?
    public var meta: JSONValue?
    public var usage: UsageData?
    /// Client send-state (web optimistic rows). Never present on wire pages.
    public var status: String?
    public var originalText: String?
    public var invokedAt: Int?
    public var model: String?
    /// Execution-machine wall clock (epoch ms) parsed from the Claude
    /// entry's own `timestamp`; `nil` when unparseable.
    public var agentTimestamp: Int?
    /// Tracer output: the Task/Agent message id this sidechain message
    /// groups under.
    public var sidechainId: String?

    public init(
        id: String,
        localId: String? = nil,
        createdAt: Int,
        content: Content,
        isSidechain: Bool = false,
        parentToolUseId: String? = nil,
        meta: JSONValue? = nil,
        usage: UsageData? = nil,
        status: String? = nil,
        originalText: String? = nil,
        invokedAt: Int? = nil,
        model: String? = nil,
        agentTimestamp: Int? = nil,
        sidechainId: String? = nil
    ) {
        self.id = id
        self.localId = localId
        self.createdAt = createdAt
        self.content = content
        self.isSidechain = isSidechain
        self.parentToolUseId = parentToolUseId
        self.meta = meta
        self.usage = usage
        self.status = status
        self.originalText = originalText
        self.invokedAt = invokedAt
        self.model = model
        self.agentTimestamp = agentTimestamp
        self.sidechainId = sidechainId
    }

    public var agentContent: [NormalizedAgentContent]? {
        if case .agent(let items) = content { return items }
        return nil
    }

    public var eventContent: AgentEvent? {
        if case .event(let event) = content { return event }
        return nil
    }
}

// MARK: - ChatToolCall

public enum ToolCallState: String, Equatable, Sendable {
    case pending
    case running
    case completed
    case error
}

/// Port of `ChatToolCall` (types.ts).
public struct ChatToolCall: Equatable, Sendable {
    public var id: String
    public var name: String
    public var state: ToolCallState
    /// `nil` == TS `undefined` (key omitted by the projection); `.null` ==
    /// an explicit JSON null input (kept by the projection).
    public var input: JSONValue?
    public var createdAt: Int
    public var startedAt: Int?
    public var completedAt: Int?
    public var execStartedAt: Int?
    public var execCompletedAt: Int?
    public var description: String?
    public var nativeTitle: String?
    public var nativeKind: String?
    /// Same `nil`-vs-`.null` contract as `input`.
    public var result: JSONValue?
    public var permission: ToolPermission?

    public init(
        id: String,
        name: String,
        state: ToolCallState,
        input: JSONValue? = nil,
        createdAt: Int,
        startedAt: Int? = nil,
        completedAt: Int? = nil,
        execStartedAt: Int? = nil,
        execCompletedAt: Int? = nil,
        description: String? = nil,
        nativeTitle: String? = nil,
        nativeKind: String? = nil,
        result: JSONValue? = nil,
        permission: ToolPermission? = nil
    ) {
        self.id = id
        self.name = name
        self.state = state
        self.input = input
        self.createdAt = createdAt
        self.startedAt = startedAt
        self.completedAt = completedAt
        self.execStartedAt = execStartedAt
        self.execCompletedAt = execCompletedAt
        self.description = description
        self.nativeTitle = nativeTitle
        self.nativeKind = nativeKind
        self.result = result
        self.permission = permission
    }
}

// MARK: - Chat blocks

public struct UserTextBlock: Equatable, Sendable {
    public var id: String
    public var localId: String?
    public var createdAt: Int
    public var invokedAt: Int?
    public var text: String
    public var attachments: [AttachmentMetadata]?
    public var status: String?
    public var originalText: String?
    public var meta: JSONValue?
}

public struct AgentTextBlock: Equatable, Sendable {
    public var id: String
    public var localId: String?
    public var createdAt: Int
    public var invokedAt: Int?
    public var durationMs: Int?
    public var usage: UsageData?
    public var model: String?
    public var text: String
    public var meta: JSONValue?
}

public struct AgentReasoningBlock: Equatable, Sendable {
    public var id: String
    public var localId: String?
    public var createdAt: Int
    public var invokedAt: Int?
    public var durationMs: Int?
    public var usage: UsageData?
    public var model: String?
    public var text: String
    public var meta: JSONValue?
}

public struct CodexReviewBlock: Equatable, Sendable {
    public var id: String
    public var localId: String?
    public var createdAt: Int
    public var invokedAt: Int?
    public var durationMs: Int?
    public var usage: UsageData?
    public var model: String?
    public var review: CodexReview
    public var meta: JSONValue?
}

public struct CliOutputBlock: Equatable, Sendable {
    public enum Source: String, Equatable, Sendable {
        case user
        case assistant
    }

    public var id: String
    public var localId: String?
    public var createdAt: Int
    public var invokedAt: Int?
    public var durationMs: Int?
    public var usage: UsageData?
    public var model: String?
    public var text: String
    public var source: Source
    public var meta: JSONValue?
}

public struct GeneratedImageBlock: Equatable, Sendable {
    public var id: String
    public var localId: String?
    public var createdAt: Int
    public var invokedAt: Int?
    public var imageId: String
    public var fileName: String
    public var mimeType: String?
    public var source: InlineMediaSource?
    public var meta: JSONValue?
}

public struct AgentEventBlock: Equatable, Sendable {
    public var id: String
    public var createdAt: Int
    public var invokedAt: Int?
    public var model: String?
    public var event: AgentEvent
    public var meta: JSONValue?
}

public struct ToolCallBlock: Equatable, Sendable {
    public var id: String
    public var localId: String?
    public var createdAt: Int
    public var invokedAt: Int?
    public var durationMs: Int?
    public var usage: UsageData?
    public var model: String?
    public var tool: ChatToolCall
    public var children: [ChatBlock]
    public var meta: JSONValue?
}

/// Port of the `ChatBlock` union (types.ts).
public enum ChatBlock: Equatable, Sendable {
    case userText(UserTextBlock)
    case agentText(AgentTextBlock)
    case agentReasoning(AgentReasoningBlock)
    case codexReview(CodexReviewBlock)
    case cliOutput(CliOutputBlock)
    case toolCall(ToolCallBlock)
    case generatedImage(GeneratedImageBlock)
    case agentEvent(AgentEventBlock)

    /// The TS `kind` discriminator string.
    public var kind: String {
        switch self {
        case .userText: return "user-text"
        case .agentText: return "agent-text"
        case .agentReasoning: return "agent-reasoning"
        case .codexReview: return "codex-review"
        case .cliOutput: return "cli-output"
        case .toolCall: return "tool-call"
        case .generatedImage: return "generated-image"
        case .agentEvent: return "agent-event"
        }
    }

    public var id: String {
        switch self {
        case .userText(let block): return block.id
        case .agentText(let block): return block.id
        case .agentReasoning(let block): return block.id
        case .codexReview(let block): return block.id
        case .cliOutput(let block): return block.id
        case .toolCall(let block): return block.id
        case .generatedImage(let block): return block.id
        case .agentEvent(let block): return block.id
        }
    }

    public var createdAt: Int {
        switch self {
        case .userText(let block): return block.createdAt
        case .agentText(let block): return block.createdAt
        case .agentReasoning(let block): return block.createdAt
        case .codexReview(let block): return block.createdAt
        case .cliOutput(let block): return block.createdAt
        case .toolCall(let block): return block.createdAt
        case .generatedImage(let block): return block.createdAt
        case .agentEvent(let block): return block.createdAt
        }
    }

    public var invokedAt: Int? {
        switch self {
        case .userText(let block): return block.invokedAt
        case .agentText(let block): return block.invokedAt
        case .agentReasoning(let block): return block.invokedAt
        case .codexReview(let block): return block.invokedAt
        case .cliOutput(let block): return block.invokedAt
        case .toolCall(let block): return block.invokedAt
        case .generatedImage(let block): return block.invokedAt
        case .agentEvent(let block): return block.invokedAt
        }
    }

    // Settable case accessors so reducer code can mutate blocks in place
    // through `BlockBox` (get–modify–set through optional chaining).

    public var asToolCall: ToolCallBlock? {
        get { if case .toolCall(let value) = self { return value }; return nil }
        set { if let newValue { self = .toolCall(newValue) } }
    }

    public var asAgentText: AgentTextBlock? {
        get { if case .agentText(let value) = self { return value }; return nil }
        set { if let newValue { self = .agentText(newValue) } }
    }

    public var asAgentReasoning: AgentReasoningBlock? {
        get { if case .agentReasoning(let value) = self { return value }; return nil }
        set { if let newValue { self = .agentReasoning(newValue) } }
    }

    public var asCliOutput: CliOutputBlock? {
        get { if case .cliOutput(let value) = self { return value }; return nil }
        set { if let newValue { self = .cliOutput(newValue) } }
    }

    public var asCodexReview: CodexReviewBlock? {
        get { if case .codexReview(let value) = self { return value }; return nil }
        set { if let newValue { self = .codexReview(newValue) } }
    }

    public var asAgentEvent: AgentEventBlock? {
        get { if case .agentEvent(let value) = self { return value }; return nil }
        set { if let newValue { self = .agentEvent(newValue) } }
    }
}

// MARK: - Latest usage

/// Port of `LatestUsage` (reducer.ts).
public struct LatestUsage: Equatable, Sendable {
    public var inputTokens: Double
    public var outputTokens: Double
    public var cacheCreation: Double
    public var cacheRead: Double
    public var contextSize: Double
    public var contextWindow: Double?
    public var model: String?
    public var timestamp: Int

    public init(
        inputTokens: Double,
        outputTokens: Double,
        cacheCreation: Double,
        cacheRead: Double,
        contextSize: Double,
        contextWindow: Double? = nil,
        model: String? = nil,
        timestamp: Int
    ) {
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cacheCreation = cacheCreation
        self.cacheRead = cacheRead
        self.contextSize = contextSize
        self.contextWindow = contextWindow
        self.model = model
        self.timestamp = timestamp
    }
}

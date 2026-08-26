import Foundation

/// A pending tool-approval / user-input request raised by the agent.
///
/// Mirrors `AgentStateRequestSchema` (`shared/src/schemas.ts`). Permission
/// requests are NOT messages: they live on `Session.agentState.requests`
/// keyed by request id and are resolved over
/// `POST /api/sessions/:id/permissions/:requestId/approve|deny`.
public struct AgentStateRequest: Codable, Equatable, Sendable {
    public var tool: String
    /// Free-form tool arguments (`z.unknown()` on the wire).
    public var arguments: JSONValue?
    /// Epoch ms when the request was raised; older CLIs omit it.
    public var createdAt: Int?

    public init(tool: String, arguments: JSONValue? = nil, createdAt: Int? = nil) {
        self.tool = tool
        self.arguments = arguments
        self.createdAt = createdAt
    }
}

/// A resolved permission request, moved from `requests` to
/// `completedRequests` once decided.
///
/// Mirrors `AgentStateCompletedRequestSchema` (`shared/src/schemas.ts`).
public struct AgentStateCompletedRequest: Codable, Equatable, Sendable {
    public enum Status: String, Codable, Sendable {
        case canceled
        case denied
        case approved
    }

    public enum Decision: String, Codable, Sendable {
        case approved
        case approvedForSession = "approved_for_session"
        case denied
        case abort
    }

    public var tool: String
    public var arguments: JSONValue?
    public var createdAt: Int?
    public var completedAt: Int?
    public var status: Status
    public var reason: String?
    /// Permission mode switched to while approving, when any.
    public var mode: String?
    public var decision: Decision?
    public var allowTools: [String]?
    /// Two wire formats, kept raw:
    /// flat `{question: [answers]}` (AskUserQuestion) or
    /// nested `{question: {answers: [...]}}` (request_user_input).
    public var answers: JSONValue?

    public init(
        tool: String,
        arguments: JSONValue? = nil,
        createdAt: Int? = nil,
        completedAt: Int? = nil,
        status: Status,
        reason: String? = nil,
        mode: String? = nil,
        decision: Decision? = nil,
        allowTools: [String]? = nil,
        answers: JSONValue? = nil
    ) {
        self.tool = tool
        self.arguments = arguments
        self.createdAt = createdAt
        self.completedAt = completedAt
        self.status = status
        self.reason = reason
        self.mode = mode
        self.decision = decision
        self.allowTools = allowTools
        self.answers = answers
    }
}

/// Agent-owned session state carried on `Session.agentState` and patched over
/// SSE under the `agentStateVersion` gate.
///
/// Mirrors `AgentStateSchema` (`shared/src/schemas.ts:195-203`).
public struct AgentState: Codable, Equatable, Sendable {
    /// `true` while the terminal owns the session (remote control paused).
    public var controlledByUser: Bool?
    /// Launch mode the session was started in (persisted for reopen/resume).
    public var startingMode: SessionStartingMode?
    /// Pending requests keyed by request id.
    public var requests: [String: AgentStateRequest]?
    /// Resolved requests keyed by request id.
    public var completedRequests: [String: AgentStateCompletedRequest]?

    public init(
        controlledByUser: Bool? = nil,
        startingMode: SessionStartingMode? = nil,
        requests: [String: AgentStateRequest]? = nil,
        completedRequests: [String: AgentStateCompletedRequest]? = nil
    ) {
        self.controlledByUser = controlledByUser
        self.startingMode = startingMode
        self.requests = requests
        self.completedRequests = completedRequests
    }
}

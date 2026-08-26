import Foundation

/// Classification of a pending request for list badges.
public enum PendingRequestKind: String, Codable, Sendable {
    case permission
    case input
}

/// A capped, list-friendly view of one pending tool request.
///
/// Mirrors `PendingRequest` (`shared/src/sessionSummary.ts`).
public struct PendingRequest: Codable, Equatable, Sendable {
    public var id: String
    public var kind: PendingRequestKind
    public var tool: String
    /// Epoch ms when the request was raised (falls back server-side to the
    /// session's `updatedAt` for requests stored without `createdAt`).
    public var since: Int

    public init(id: String, kind: PendingRequestKind, tool: String, since: Int) {
        self.id = id
        self.kind = kind
        self.tool = tool
        self.since = since
    }
}

/// Todo completion counters shown on the session row.
public struct TodoProgress: Codable, Equatable, Sendable {
    public var completed: Int
    public var total: Int

    public init(completed: Int, total: Int) {
        self.completed = completed
        self.total = total
    }
}

/// Metadata subset embedded in a session-list row.
///
/// Mirrors `SessionSummaryMetadata` (`shared/src/sessionSummary.ts`).
public struct SessionSummaryMetadata: Codable, Equatable, Sendable {
    /// The `summary` field carries only the text in list rows.
    public struct Summary: Codable, Equatable, Sendable {
        public var text: String

        public init(text: String) {
            self.text = text
        }
    }

    public var name: String?
    public var path: String
    public var machineId: String?
    public var summary: Summary?
    public var flavor: String?
    public var worktree: WorktreeMetadata?
    /// Native agent session id resolved per flavor by the hub.
    public var agentSessionId: String?
    public var lifecycleState: String?
    public var hapiMcpUrl: String?

    public init(
        name: String? = nil,
        path: String,
        machineId: String? = nil,
        summary: Summary? = nil,
        flavor: String? = nil,
        worktree: WorktreeMetadata? = nil,
        agentSessionId: String? = nil,
        lifecycleState: String? = nil,
        hapiMcpUrl: String? = nil
    ) {
        self.name = name
        self.path = path
        self.machineId = machineId
        self.summary = summary
        self.flavor = flavor
        self.worktree = worktree
        self.agentSessionId = agentSessionId
        self.lifecycleState = lifecycleState
        self.hapiMcpUrl = hapiMcpUrl
    }
}

/// One row of `GET /api/sessions`.
///
/// Mirrors `SessionSummary` (`shared/src/sessionSummary.ts`). The summary is
/// hub-derived: badges must use `pendingRequestsCount` (authoritative total),
/// never `pendingRequests.count` (capped at 5, oldest first).
public struct SessionSummary: Codable, Equatable, Sendable {
    /// Server-side cap on `pendingRequests` entries
    /// (`PENDING_REQUEST_SUMMARY_CAP`, `shared/src/sessionSummary.ts`).
    public static let pendingRequestSummaryCap = 5

    public var id: String
    public var active: Bool
    public var thinking: Bool
    public var activeAt: Int
    public var updatedAt: Int
    public var pinned: Bool?
    public var globalPinned: Bool?
    public var metadata: SessionSummaryMetadata?
    /// Watermark mirrors of the detail record so structured SSE patches can
    /// be gated without a detail fetch.
    public var metadataVersion: Int
    public var agentStateVersion: Int
    public var todosUpdatedAt: Int
    public var todoProgress: TodoProgress?
    public var pendingRequestsCount: Int
    public var pendingRequestKinds: [PendingRequestKind]
    public var pendingRequests: [PendingRequest]
    public var backgroundTaskCount: Int
    public var futureScheduledMessageCount: Int
    /// Epoch ms of the soonest uninvoked scheduled message, or `nil`.
    public var nextScheduledAt: Int?
    public var model: String?
    public var modelReasoningEffort: String?
    public var effort: String?

    public init(
        id: String,
        active: Bool,
        thinking: Bool,
        activeAt: Int,
        updatedAt: Int,
        pinned: Bool? = nil,
        globalPinned: Bool? = nil,
        metadata: SessionSummaryMetadata? = nil,
        metadataVersion: Int,
        agentStateVersion: Int,
        todosUpdatedAt: Int,
        todoProgress: TodoProgress? = nil,
        pendingRequestsCount: Int,
        pendingRequestKinds: [PendingRequestKind] = [],
        pendingRequests: [PendingRequest] = [],
        backgroundTaskCount: Int = 0,
        futureScheduledMessageCount: Int = 0,
        nextScheduledAt: Int? = nil,
        model: String? = nil,
        modelReasoningEffort: String? = nil,
        effort: String? = nil
    ) {
        self.id = id
        self.active = active
        self.thinking = thinking
        self.activeAt = activeAt
        self.updatedAt = updatedAt
        self.pinned = pinned
        self.globalPinned = globalPinned
        self.metadata = metadata
        self.metadataVersion = metadataVersion
        self.agentStateVersion = agentStateVersion
        self.todosUpdatedAt = todosUpdatedAt
        self.todoProgress = todoProgress
        self.pendingRequestsCount = pendingRequestsCount
        self.pendingRequestKinds = pendingRequestKinds
        self.pendingRequests = pendingRequests
        self.backgroundTaskCount = backgroundTaskCount
        self.futureScheduledMessageCount = futureScheduledMessageCount
        self.nextScheduledAt = nextScheduledAt
        self.model = model
        self.modelReasoningEffort = modelReasoningEffort
        self.effort = effort
    }
}

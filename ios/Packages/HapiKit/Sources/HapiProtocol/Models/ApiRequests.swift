import Foundation

// Request bodies for the REST surface (`docs/api/client-contract/rest.md`).
// Field names mirror the Zod schemas in `shared/src/apiTypes.ts` one-to-one,
// so no CodingKeys are needed anywhere in this file. Single-field bodies
// (`{name}`, `{text}`, ...) stay private to the endpoint layer; only shapes
// that are multi-field or shared across features live here.

/// How a sent message is delivered while the agent is busy.
///
/// Mirrors `MessageDeliveryModeSchema` (`shared/src/apiTypes.ts`).
public enum MessageDeliveryMode: String, Codable, Sendable {
    case queue
    case steer
}

/// Body of `POST /api/sessions/:id/messages`.
///
/// Mirrors `SendMessageRequestSchema` (`shared/src/apiTypes.ts`). Server-side
/// refinements (text or attachments required; `scheduledAt` requires
/// `localId`, must be within 7 days, excludes attachments and steer) are not
/// re-validated client-side — the hub answers 400 on violation.
public struct SendMessageRequest: Codable, Equatable, Sendable {
    public var text: String
    /// Client-generated id for optimistic reconciliation.
    public var localId: String?
    public var attachments: [AttachmentMetadata]?
    /// Future send time (epoch ms).
    public var scheduledAt: Int?
    public var deliveryMode: MessageDeliveryMode?

    public init(
        text: String,
        localId: String? = nil,
        attachments: [AttachmentMetadata]? = nil,
        scheduledAt: Int? = nil,
        deliveryMode: MessageDeliveryMode? = nil
    ) {
        self.text = text
        self.localId = localId
        self.attachments = attachments
        self.scheduledAt = scheduledAt
        self.deliveryMode = deliveryMode
    }
}

/// Decision value carried by permission approve/deny bodies.
///
/// Same wire values as the completed-request record, so the request side
/// reuses that enum (`'approved' | 'approved_for_session' | 'denied' | 'abort'`).
public typealias PermissionDecision = AgentStateCompletedRequest.Decision

/// Body of `POST /api/sessions/:id/permissions/:requestId/approve`.
///
/// `answers` has two wire formats depending on the requesting tool —
/// flat `{question: [answers]}` (AskUserQuestion) or nested
/// `{question: {answers: [...]}}` (request_user_input) — and is therefore
/// kept as raw ``JSONValue``.
public struct PermissionApproveRequest: Codable, Equatable, Sendable {
    /// Optionally switch permission mode while approving.
    public var mode: PermissionMode?
    public var allowTools: [String]?
    public var decision: PermissionDecision?
    public var answers: JSONValue?

    public init(
        mode: PermissionMode? = nil,
        allowTools: [String]? = nil,
        decision: PermissionDecision? = nil,
        answers: JSONValue? = nil
    ) {
        self.mode = mode
        self.allowTools = allowTools
        self.decision = decision
        self.answers = answers
    }
}

/// Body of `POST /api/sessions/:id/permissions/:requestId/deny`.
public struct PermissionDenyRequest: Codable, Equatable, Sendable {
    public var decision: PermissionDecision?

    public init(decision: PermissionDecision? = nil) {
        self.decision = decision
    }
}

/// The `model` value of `POST /api/sessions/:id/model`:
/// a plain model id or a `{provider, modelId}` catalog reference.
/// (`null` — reset to default — is expressed by the request wrapper, not here.)
public enum ModelSelection: Equatable, Sendable {
    case id(String)
    case catalogReference(provider: String, modelId: String)
}

extension ModelSelection: Codable {
    private struct CatalogReference: Codable {
        let provider: String
        let modelId: String
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let id = try? container.decode(String.self) {
            self = .id(id)
            return
        }
        if let reference = try? container.decode(CatalogReference.self) {
            self = .catalogReference(provider: reference.provider, modelId: reference.modelId)
            return
        }
        throw DecodingError.dataCorruptedError(
            in: container,
            debugDescription: "Model selection is neither a string nor {provider, modelId}"
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .id(let id):
            try container.encode(id)
        case .catalogReference(let provider, let modelId):
            try container.encode(CatalogReference(provider: provider, modelId: modelId))
        }
    }
}

/// Codex service tier (`POST /api/sessions/:id/service-tier`, spawn request).
public enum ServiceTier: String, Codable, Sendable {
    case fast
    case standard
}

/// Pin mode of `PUT /api/sessions/:id/pin`.
public enum SessionPinMode: String, Codable, Sendable {
    case none
    case project
    case global
}

/// `sessionType` of the spawn request.
public enum SpawnSessionType: String, Codable, Sendable {
    case simple
    case worktree
}

/// `startingMode` of the spawn request (`agy` accepts only `remote`).
public enum SpawnStartingMode: String, Codable, Sendable {
    case remote
    case pty
}

/// Body of `POST /api/machines/:id/spawn`.
///
/// Mirrors `SpawnSessionRequestSchema` (`shared/src/apiTypes.ts`).
public struct SpawnRequest: Codable, Equatable, Sendable {
    public var directory: String
    public var agent: AgentFlavor?
    public var model: String?
    public var effort: String?
    public var modelReasoningEffort: String?
    public var yolo: Bool?
    public var permissionMode: PermissionMode?
    public var sessionType: SpawnSessionType?
    public var worktreeName: String?
    public var serviceTier: ServiceTier?
    public var collaborationMode: CodexCollaborationMode?
    public var copilotAgentMode: CopilotAgentMode?
    public var startingMode: SpawnStartingMode?

    public init(
        directory: String,
        agent: AgentFlavor? = nil,
        model: String? = nil,
        effort: String? = nil,
        modelReasoningEffort: String? = nil,
        yolo: Bool? = nil,
        permissionMode: PermissionMode? = nil,
        sessionType: SpawnSessionType? = nil,
        worktreeName: String? = nil,
        serviceTier: ServiceTier? = nil,
        collaborationMode: CodexCollaborationMode? = nil,
        copilotAgentMode: CopilotAgentMode? = nil,
        startingMode: SpawnStartingMode? = nil
    ) {
        self.directory = directory
        self.agent = agent
        self.model = model
        self.effort = effort
        self.modelReasoningEffort = modelReasoningEffort
        self.yolo = yolo
        self.permissionMode = permissionMode
        self.sessionType = sessionType
        self.worktreeName = worktreeName
        self.serviceTier = serviceTier
        self.collaborationMode = collaborationMode
        self.copilotAgentMode = copilotAgentMode
        self.startingMode = startingMode
    }
}

/// Compound-cursor query of `GET /api/sessions/:id/messages`.
///
/// Mirrors `MessagesQuerySchema` (`shared/src/apiTypes.ts`): every cursor is a
/// `(seq, at)` pair that travels together; `epoch` is only meaningful with an
/// `after` cursor; `until` bounds an `after` catch-up. Full semantics in
/// `docs/api/client-contract/pagination.md`.
public struct MessagesQuery: Equatable, Sendable {
    /// Page size (1–200, server default 50).
    public var limit: Int?
    public var beforeSeq: Int?
    public var beforeAt: Int?
    public var afterSeq: Int?
    public var afterAt: Int?
    public var untilSeq: Int?
    public var untilAt: Int?
    public var epoch: Int?

    public init(
        limit: Int? = nil,
        beforeSeq: Int? = nil,
        beforeAt: Int? = nil,
        afterSeq: Int? = nil,
        afterAt: Int? = nil,
        untilSeq: Int? = nil,
        untilAt: Int? = nil,
        epoch: Int? = nil
    ) {
        self.limit = limit
        self.beforeSeq = beforeSeq
        self.beforeAt = beforeAt
        self.afterSeq = afterSeq
        self.afterAt = afterAt
        self.untilSeq = untilSeq
        self.untilAt = untilAt
        self.epoch = epoch
    }

    /// Newest page (no cursor).
    public static func latest(limit: Int? = nil) -> MessagesQuery {
        MessagesQuery(limit: limit)
    }

    /// Page of history strictly older than the `(seq, at)` position.
    public static func before(seq: Int, at: Int, limit: Int? = nil) -> MessagesQuery {
        MessagesQuery(limit: limit, beforeSeq: seq, beforeAt: at)
    }

    /// Catch-up page strictly newer than the `(seq, at)` position.
    /// Pass the cached `epoch` so the server can answer `reset: true` when the
    /// session history was rewritten.
    public static func after(
        seq: Int,
        at: Int,
        epoch: Int? = nil,
        untilSeq: Int? = nil,
        untilAt: Int? = nil,
        limit: Int? = nil
    ) -> MessagesQuery {
        MessagesQuery(
            limit: limit,
            afterSeq: seq,
            afterAt: at,
            untilSeq: untilSeq,
            untilAt: untilAt,
            epoch: epoch
        )
    }
}

/// Visibility value of `POST /api/visibility`.
public enum VisibilityState: String, Codable, Sendable {
    case visible
    case hidden
}

/// Body of `POST /api/visibility`.
///
/// `subscriptionId` comes from the SSE `connection-changed` handshake and is
/// new on every reconnect; a stale id answers 404.
public struct VisibilityRequest: Codable, Equatable, Sendable {
    public var subscriptionId: String
    public var visibility: VisibilityState

    public init(subscriptionId: String, visibility: VisibilityState) {
        self.subscriptionId = subscriptionId
        self.visibility = visibility
    }
}

/// Body of `POST /api/sessions/:id/upload` (JSON + base64, not multipart).
///
/// Mirrors `UploadFileRequestSchema`; decoded size limit is 50 MB (413 above).
public struct UploadFileRequest: Codable, Equatable, Sendable {
    public var filename: String
    /// Base64-encoded file content.
    public var content: String
    public var mimeType: String

    public init(filename: String, content: String, mimeType: String) {
        self.filename = filename
        self.content = content
        self.mimeType = mimeType
    }
}

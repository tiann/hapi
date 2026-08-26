import Foundation
import HapiProtocol

/// One `GET /api/sessions/:id/messages` request. The three variants are the
/// only shapes the reference client ever issues
/// (`docs/api/client-contract/pagination.md`): the window controller cannot
/// produce an invalid parameter combination by construction, and the
/// pagination fixture harness asserts these against the recorded
/// `expectedRequests` — `.after` always carries the `until` keys (explicitly
/// null on the first catch-up request), the other variants never do.
/// Mirror of the Android port's `MessagesQuery` sealed interface
/// (`app/hapi/data/api/MessagesApi.kt`).
public enum MessagesPageQuery: Equatable, Sendable {
    /// Newest page, no cursor.
    case latest(limit: Int)
    /// Rows strictly older than the compound cursor.
    case before(beforeAt: Int, beforeSeq: Int, limit: Int)
    /// Tail catch-up: rows strictly newer than the cursor, snapshot-bounded.
    case after(afterAt: Int, afterSeq: Int, untilAt: Int?, untilSeq: Int?, epoch: Int, limit: Int)

    /// The flat REST query (`MessagesQuerySchema`) this variant serializes
    /// to. Null `until` halves are omitted from the URL, like the web client.
    public var restQuery: MessagesQuery {
        switch self {
        case .latest(let limit):
            return .latest(limit: limit)
        case .before(let beforeAt, let beforeSeq, let limit):
            return .before(seq: beforeSeq, at: beforeAt, limit: limit)
        case .after(let afterAt, let afterSeq, let untilAt, let untilSeq, let epoch, let limit):
            return .after(
                seq: afterSeq,
                at: afterAt,
                epoch: epoch,
                untilSeq: untilSeq,
                untilAt: untilAt,
                limit: limit
            )
        }
    }
}

/// Minimal seam over the two message endpoints the window controller drives —
/// implemented by ``APIClient`` in production and by a scripted fake in the
/// pagination fixture harness. Extracted (instead of depending on the
/// concrete client) so the REAL orchestration is what the fixtures replay.
/// Mirror of the Android port's `MessagesApi`.
public protocol MessagesProviding: Sendable {
    /// `GET /api/sessions/:id/messages`.
    func messages(sessionId: String, query: MessagesPageQuery) async throws -> MessagesResponse

    /// `POST /api/sessions/:id/messages/queued-state`.
    func queuedState(sessionId: String, localIds: [String]) async throws -> QueuedStateResponse
}

extension APIClient: MessagesProviding {
    public func messages(sessionId: String, query: MessagesPageQuery) async throws -> MessagesResponse {
        try await messages(sessionId: sessionId, query: query.restQuery)
    }

    // `queuedState(sessionId:localIds:)` from Endpoints/MessageEndpoints.swift
    // already satisfies the second requirement.
}

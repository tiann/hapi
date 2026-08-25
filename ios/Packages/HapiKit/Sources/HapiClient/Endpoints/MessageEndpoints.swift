import Foundation
import HapiProtocol

extension MessagesQuery {
    /// Query items in the reference client's insertion order
    /// (`web/src/api/client.ts` `getMessages`), so request URLs are
    /// byte-comparable across clients.
    var queryItems: [URLQueryItem] {
        var items: [URLQueryItem] = []
        func append(_ name: String, _ value: Int?) {
            if let value {
                items.append(URLQueryItem(name: name, value: String(value)))
            }
        }
        append("beforeAt", beforeAt)
        append("beforeSeq", beforeSeq)
        append("afterAt", afterAt)
        append("afterSeq", afterSeq)
        append("untilAt", untilAt)
        append("untilSeq", untilSeq)
        append("epoch", epoch)
        append("limit", limit)
        return items
    }
}

/// Message paging, sending, and queue operations
/// (`docs/api/client-contract/rest.md`, `pagination.md`).
extension APIClient {
    /// `GET /api/sessions/:id/messages` with a compound cursor. When the
    /// page comes back with `reset: true`, discard the local window — the
    /// requested epoch no longer exists.
    public func messages(sessionId: String, query: MessagesQuery = .latest()) async throws -> MessagesResponse {
        try await request(
            .get,
            "/api/sessions/\(encodePathComponent(sessionId))/messages",
            query: query.queryItems
        )
    }

    /// `POST /api/sessions/:id/messages`. Answers `{ok: true}` only — the
    /// stored message arrives via SSE (`message-received`), reconciled with
    /// the optimistic row through `localId`.
    public func sendMessage(sessionId: String, _ message: SendMessageRequest) async throws {
        try await requestVoid(
            .post,
            "/api/sessions/\(encodePathComponent(sessionId))/messages",
            body: message
        )
    }

    /// Convenience overload of ``sendMessage(sessionId:_:)``.
    public func sendMessage(
        sessionId: String,
        text: String,
        localId: String? = nil,
        attachments: [AttachmentMetadata]? = nil,
        scheduledAt: Int? = nil,
        deliveryMode: MessageDeliveryMode? = nil
    ) async throws {
        try await sendMessage(
            sessionId: sessionId,
            SendMessageRequest(
                text: text,
                localId: localId,
                attachments: attachments,
                scheduledAt: scheduledAt,
                deliveryMode: deliveryMode
            )
        )
    }

    /// `DELETE /api/sessions/:id/messages/:messageId` — cancel a queued
    /// message. `.invoked` means the cancel came too late.
    public func cancelMessage(sessionId: String, messageId: String) async throws -> CancelMessageResponse {
        try await request(
            .delete,
            "/api/sessions/\(encodePathComponent(sessionId))/messages/\(encodePathComponent(messageId))"
        )
    }

    /// `POST /api/sessions/:id/messages/:messageId/retry` — explicitly retry
    /// an indeterminate delivery.
    public func retryIndeterminateMessage(sessionId: String, messageId: String) async throws -> RetryIndeterminateMessageResponse {
        try await request(
            .post,
            "/api/sessions/\(encodePathComponent(sessionId))/messages/\(encodePathComponent(messageId))/retry"
        )
    }

    /// `POST /api/sessions/:id/messages/:messageId/steer` — promote a queued
    /// message to steer delivery.
    public func steerMessage(sessionId: String, messageId: String) async throws -> SteerQueuedMessageResponse {
        try await request(
            .post,
            "/api/sessions/\(encodePathComponent(sessionId))/messages/\(encodePathComponent(messageId))/steer"
        )
    }

    /// `POST /api/sessions/:id/messages/queued-state` — resync optimistic
    /// sends after a reconnect (≤ 1000 localIds).
    public func queuedState(sessionId: String, localIds: [String]) async throws -> QueuedStateResponse {
        struct QueuedStateRequest: Encodable {
            let localIds: [String]
        }
        return try await request(
            .post,
            "/api/sessions/\(encodePathComponent(sessionId))/messages/queued-state",
            body: QueuedStateRequest(localIds: localIds)
        )
    }
}

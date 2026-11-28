/// Operator-facing fields of the Hub's `metadata.lastModelError`. The replay
/// prompt stays on the Hub and CLI. Historical transcript events have no action ID.
public struct SessionModelError: Codable, Equatable, Sendable {
    public var eventId: String
    public var kind: String
    public var transient: Bool
    public var rawSnippet: String
    public var priorAssistantClaimsDone: Bool
    public var bridgedForEventId: String?
    public var retriedAndFailed: Bool?
    public var supersededByUserTurn: Bool?
    public var bridgeable: Bool?
    public var acknowledgedAt: Double?

    public var recovered: Bool { bridgedForEventId == eventId && retriedAndFailed != true }

    public func canBridge(sessionActive: Bool) -> Bool {
        sessionActive && acknowledgedAt == nil && !eventId.isEmpty && transient
            && !recovered && retriedAndFailed != true && supersededByUserTurn != true && bridgeable != false
    }
}

extension Session {
    public var visibleCursorModelError: SessionModelError? {
        guard metadata?.flavor == "cursor", let error = metadata?.lastModelError,
              !error.eventId.isEmpty, error.acknowledgedAt == nil else { return nil }
        return error
    }
}

import HapiProtocol

public struct RewindConversationResponse: Decodable, Sendable {
    public let session: Session
    public let pending: Bool?
}

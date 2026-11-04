import Foundation

public struct SessionReadState: Codable, Equatable, Sendable {
    public var readRevision: Int
    public var manualUnread: Bool
    public var version: Int

    public init(readRevision: Int = 0, manualUnread: Bool = false, version: Int = 0) {
        self.readRevision = readRevision
        self.manualUnread = manualUnread
        self.version = version
    }

    public static func merge(_ current: Self?, _ incoming: Self?) -> Self? {
        guard let incoming else { return current }
        guard let current else { return incoming }
        var next = incoming.version > current.version ? incoming : current
        next.readRevision = max(current.readRevision, incoming.readRevision)
        return next
    }
}

public struct SessionReadStateRequest: Codable, Equatable, Sendable {
    public var type: String
    public var readRevision: Int?
    public var expectedVersion: Int

    public init(type: String = "read", readRevision: Int? = nil, expectedVersion: Int) {
        self.type = type
        self.readRevision = readRevision
        self.expectedVersion = expectedVersion
    }
}

public struct SessionReadStateResponse: Codable, Equatable, Sendable {
    public var readState: SessionReadState
    public var contentRevision: Int
}

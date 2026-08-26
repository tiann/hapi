import Foundation

/// One entry of the agent's TodoWrite list, carried on `Session.todos`.
///
/// Mirrors `TodoItemSchema` (`shared/src/schemas.ts:207-215`). The zod schema
/// defaults `priority` to `medium` and `id` to `""` when absent; decoding
/// applies the same defaults so the parsed shape matches the web client's.
public struct TodoItem: Codable, Equatable, Sendable {
    public enum Status: String, Codable, Sendable {
        case pending
        case inProgress = "in_progress"
        case completed
    }

    public enum Priority: String, Codable, Sendable {
        case high
        case medium
        case low
    }

    public var content: String
    public var status: Status
    public var priority: Priority
    public var id: String
    /// Present-tense label shown while the item is in progress.
    public var activeForm: String?

    public init(
        content: String,
        status: Status,
        priority: Priority = .medium,
        id: String = "",
        activeForm: String? = nil
    ) {
        self.content = content
        self.status = status
        self.priority = priority
        self.id = id
        self.activeForm = activeForm
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        content = try container.decode(String.self, forKey: .content)
        status = try container.decode(Status.self, forKey: .status)
        priority = try container.decodeIfPresent(Priority.self, forKey: .priority) ?? .medium
        id = try container.decodeIfPresent(String.self, forKey: .id) ?? ""
        activeForm = try container.decodeIfPresent(String.self, forKey: .activeForm)
    }
}

import Foundation

// Port of the envelope helpers the chat pipeline uses from
// shared/src/messages.ts: role-wrapped envelope unwrapping, the Claude
// chat-visibility filter, and the redundant goal-status text test.

/// Port of `RoleWrappedRecord`.
public struct RoleWrappedRecord: Equatable, Sendable {
    public var role: String
    public var content: JSONValue
    public var meta: JSONValue?

    public init(role: String, content: JSONValue, meta: JSONValue? = nil) {
        self.role = role
        self.content = content
        self.meta = meta
    }
}

private func asRoleWrappedRecord(_ value: JSONValue?) -> RoleWrappedRecord? {
    guard let object = value?.objectValue else { return nil }
    guard let role = object["role"]?.stringValue else { return nil }
    // `'content' in value` — key presence, any value (JSON knows no undefined).
    guard let content = object["content"] else { return nil }
    return RoleWrappedRecord(role: role, content: content, meta: object["meta"])
}

/// Port of `unwrapRoleWrappedRecordEnvelope`: the value itself, or the
/// wrapped record probed at `message`, `data.message`, `payload.message`.
public func unwrapRoleWrappedRecordEnvelope(_ value: JSONValue) -> RoleWrappedRecord? {
    if let record = asRoleWrappedRecord(value) { return record }
    guard value.objectValue != nil else { return nil }

    if let record = asRoleWrappedRecord(value["message"]) { return record }
    if let record = asRoleWrappedRecord(value["data"]?["message"]) { return record }
    if let record = asRoleWrappedRecord(value["payload"]?["message"]) { return record }
    return nil
}

/// Port of `VISIBLE_CLAUDE_SYSTEM_SUBTYPES`.
private let visibleClaudeSystemSubtypes: Set<String> = [
    "api_error",
    "turn_duration",
    "microcompact_boundary",
    "compact_boundary",
    "away_summary",
]

/// Port of `isClaudeChatVisibleSystemSubtype`.
public func isClaudeChatVisibleSystemSubtype(_ subtype: JSONValue?) -> Bool {
    guard let subtype = subtype?.stringValue else { return false }
    return visibleClaudeSystemSubtypes.contains(subtype)
}

/// Port of `isClaudeChatVisibleMessage` — `type`/`subtype` straight off the
/// wire record (non-string `type` values compare unequal, like in JS).
public func isClaudeChatVisibleMessage(type: JSONValue?, subtype: JSONValue?) -> Bool {
    if type == .string("rate_limit_event") { return false }
    if type == .string("tool_progress") { return false }
    if type != .string("system") { return true }
    return isClaudeChatVisibleSystemSubtype(subtype)
}

/// Port of `isRedundantGoalStatusMessageText`. `·` is U+00B7.
public func isRedundantGoalStatusMessageText(_ value: String?) -> Bool {
    guard let value else { return false }
    let message = value.jsTrimmed
    if message == "Goal cleared" { return true }
    return goalStatusRegex.test(message)
}

private let goalStatusRegex = JSRegex(
    "\\AGoal (active|paused|complete|blocked|limited by (?:budget|usage))(?:\\z|\\s+\u{00B7}\\s+)"
)

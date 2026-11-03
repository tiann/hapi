import Foundation
import HapiProtocol

public struct ComposerMentionSuggestion: Equatable, Sendable, Identifiable {
    public enum Source: Equatable, Sendable {
        case session(active: Bool)
        case file
    }

    public var id: String
    public var text: String
    public var label: String
    public var detail: String
    public var source: Source

    public init(id: String, text: String, label: String, detail: String, source: Source) {
        self.id = id
        self.text = text
        self.label = label
        self.detail = detail
        self.source = source
    }
}

/// Native counterpart of web `findActiveWord`, `matchSessionsForMention` and
/// composer serialization. Offsets use UTF-16, like UIKit and the web editor.
public enum ComposerMentionSuggestions {
    public struct Query: Equatable, Sendable {
        public var search: String
        public var range: NSRange
    }

    public struct Edit: Equatable, Sendable {
        public var text: String
        public var selection: NSRange
    }

    public static func query(in text: String, selection: NSRange) -> Query? {
        let content = text as NSString
        guard selection.length == 0, selection.location > 0,
              selection.location <= content.length else { return nil }
        let stops = CharacterSet(charactersIn: "\n\r,()[]{}<>;!?\u{FFFC}")
        func char(_ index: Int) -> String { content.substring(with: NSRange(location: index, length: 1)) }
        func isStop(_ value: String) -> Bool { value.rangeOfCharacter(from: stops) != nil }
        var index = selection.location - 1
        var spaces = 0
        while index >= 0 {
            let value = char(index)
            if isStop(value) { return nil }
            if value == " " {
                spaces += 1
                if spaces > 1 { return nil }
            }
            if value == "@", index == 0 || [" ", "\n", "\u{FFFC}"].contains(char(index - 1)) {
                let active = content.substring(with: NSRange(location: index + 1, length: selection.location - index - 1))
                guard !active.hasSuffix(" ") else { return nil }
                var end = selection.location
                // Dots/slashes remain part of file queries (including while typing).
                while end < content.length, char(end) != " ", !isStop(char(end)) { end += 1 }
                return Query(search: active, range: NSRange(location: index, length: end - index))
            }
            index -= 1
        }
        return nil
    }

    /// Sessions serialize exactly like web rich mentions, not just `@title`.
    /// Plain text keeps the existing draft/queue/scratchlist/send paths lossless.
    public static func sessionReference(title: String, id: String) -> String {
        let normalized = title.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        var label = ""
        for character in normalized {
            guard label.utf16.count + character.utf16.count <= 120 else { break }
            label.append(character)
        }
        if label.isEmpty { label = String(id.prefix(8)) }
        label = label.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "[", with: "\\[")
            .replacingOccurrences(of: "]", with: "\\]")
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")
        let path = id.addingPercentEncoding(withAllowedCharacters: allowed) ?? id
        return "[\(label)](/sessions/\(path))"
    }

    public static func sessions(
        _ sessions: [SessionSummary], query: String, excluding sessionId: String,
        machineLabel: (String?) -> String = { $0.map { String($0.prefix(8)) } ?? "" },
        limit: Int = 20
    ) -> [ComposerMentionSuggestion] {
        // Same native-session deduplication as web prepareSidebarSessions:
        // active → selected → global/project pin → updatedAt. Dedup BEFORE
        // content filtering so an empty live replacement hides its stale twin.
        var keys: [String: Int] = [:]
        var candidates: [SessionSummary] = []
        func preferred(_ a: SessionSummary, to b: SessionSummary) -> Bool {
            if a.active != b.active { return a.active }
            if (a.id == sessionId) != (b.id == sessionId) { return a.id == sessionId }
            if (a.globalPinned == true) != (b.globalPinned == true) { return a.globalPinned == true }
            if (a.pinned == true) != (b.pinned == true) { return a.pinned == true }
            return a.updatedAt > b.updatedAt
        }
        for session in sessions {
            let agentId = session.metadata?.agentSessionId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if agentId.isEmpty { candidates.append(session); continue }
            let key = "\(session.metadata?.flavor ?? "unknown"):\(agentId)"
            if let index = keys[key] {
                if preferred(session, to: candidates[index]) { candidates[index] = session }
            } else {
                keys[key] = candidates.count
                candidates.append(session)
            }
        }
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let matches = SessionListSearch.scoreIndex(sessions: candidates, query: normalized, machineLabel: machineLabel)
        let scored = candidates.enumerated().compactMap { index, session -> (SessionSummary, Double, Int)? in
            guard session.id != sessionId, session.hasConversationContent == true else { return nil }
            if normalized.isEmpty {
                guard session.metadata?.lifecycleState != "archived" else { return nil }
                return (session, Double(session.updatedAt) + (session.active ? 1_000_000_000 : 0), index)
            }
            guard matches?.matches(session.id) == true else { return nil }
            let title = SessionListSearch.sessionTitle(session).lowercased()
            let id = session.id.lowercased()
            var score = 150.0
            if title == normalized { score = 500 }
            else if title.hasPrefix(normalized) { score = 400 }
            else if title.contains(normalized) { score = 300 }
            else if id.hasPrefix(normalized) { score = 200 }
            else if id.contains(normalized) { score = 100 }
            if session.active { score += 50 }
            if session.metadata?.lifecycleState == "archived" { score -= 25 }
            return (session, score * 1e13 + Double(session.updatedAt), index)
        }
        return scored.sorted { $0.1 == $1.1 ? $0.2 < $1.2 : $0.1 > $1.1 }.prefix(max(0, limit)).map { session, _, _ in
            let title = SessionListSearch.sessionTitle(session)
            return ComposerMentionSuggestion(
                id: "session:\(session.id)", text: sessionReference(title: title, id: session.id),
                label: "@\(title)", detail: String(session.id.prefix(8)), source: .session(active: session.active)
            )
        }
    }

    public static func files(_ files: [FileSearchItem], flavor: String) -> [ComposerMentionSuggestion] {
        guard flavor == "codex" || flavor == "copilot" else { return [] }
        var seen: Set<String> = []
        return files.compactMap { file in
            guard seen.insert(file.fullPath).inserted else { return nil }
            let escaped = file.fullPath.replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "\"", with: "\\\"")
            let text = flavor == "copilot" ? "@\(file.fullPath)" : "@\"\(escaped)\""
            return ComposerMentionSuggestion(id: "file:\(file.fullPath)", text: text,
                label: "@\(file.fileName)", detail: file.filePath.isEmpty ? file.fullPath : file.filePath, source: .file)
        }
    }

    public static func inserting(_ suggestion: ComposerMentionSuggestion, into text: String, selection: NSRange) -> Edit? {
        guard let query = query(in: text, selection: selection), let range = Range(query.range, in: text) else { return nil }
        let suffix = text[range.upperBound...]
        let insertion = suggestion.text + (suffix.hasPrefix(" ") ? "" : " ")
        return Edit(text: text.replacingCharacters(in: range, with: insertion),
            selection: NSRange(location: query.range.location + insertion.utf16.count, length: 0))
    }
}

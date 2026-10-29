import Foundation
import HapiProtocol

/// Session-list relevance search — port of `web/src/lib/sessionListSearch.ts`
/// (+ the `shared/src/search.ts` wildcard matcher) via the Android
/// `SessionListSearch`. Substring inclusion is the gate (AND across terms);
/// field weights plus boundary and title-phrase bonuses only rank.
public enum SessionListSearch {
    enum Field: CaseIterable {
        case title, worktreeLabel, summary, flavor, machine, path, id

        var weight: Double {
            switch self {
            case .title: 10
            case .worktreeLabel: 5
            case .summary: 3
            case .flavor, .machine: 2
            case .path: 1
            case .id: 0.5
            }
        }
    }

    /// Extra multiplier when a term sits on an alphanumeric token boundary.
    static let boundaryBonus = 1.75
    /// Contiguous multi-word query inside the title.
    static let titlePhraseBonus = 25.0
    /// Exact (normalized) title match.
    static let exactTitleBonus = 50.0

    /// Relevance of the matched sessions; absent ids did not match.
    public struct ScoreIndex: Equatable, Sendable {
        public let scores: [String: Double]

        public func matches(_ sessionId: String) -> Bool {
            scores[sessionId] != nil
        }
    }

    // MARK: - Titles

    /// `getSessionTitle` (`web/src/lib/sessionTitle.ts`): name → summary
    /// text → path tail → id prefix.
    public static func sessionTitle(_ summary: SessionSummary) -> String {
        if let name = summary.metadata?.name, !name.isEmpty {
            return name
        }
        if let text = summary.metadata?.summary?.text, !text.isEmpty {
            return text
        }
        if let path = summary.metadata?.path,
           let tail = path.split(separator: "/").last(where: { !$0.isEmpty }) {
            return String(tail)
        }
        return String(summary.id.prefix(8))
    }

    /// `getWorktreeSessionLabel`: worktree name, else its path's last segment.
    static func worktreeLabel(_ summary: SessionSummary) -> String? {
        guard let worktree = summary.metadata?.worktree else { return nil }
        let name = worktree.name.trimmingCharacters(in: .whitespacesAndNewlines)
        if !name.isEmpty { return name }
        let path = worktree.worktreePath ?? summary.metadata?.path ?? ""
        return path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init)
    }

    // MARK: - Matching primitives

    public static func isWildcard(_ query: String) -> Bool {
        query.contains("*") || query.contains("?")
    }

    /// Wildcard match on Unicode scalars: `?` takes one, `*` any run.
    static func matchesWildcard(_ value: String, pattern: String) -> Bool {
        let input = Array(value.lowercased().unicodeScalars)
        let tokens = Array(pattern.lowercased().unicodeScalars)
        var inputIndex = 0
        var tokenIndex = 0
        var starIndex = -1
        var retryInputIndex = 0
        while inputIndex < input.count {
            let token = tokenIndex < tokens.count ? tokens[tokenIndex] : nil
            if let token, token == "?" || token == input[inputIndex] {
                inputIndex += 1
                tokenIndex += 1
            } else if token == "*" {
                starIndex = tokenIndex
                tokenIndex += 1
                retryInputIndex = inputIndex
            } else if starIndex >= 0 {
                tokenIndex = starIndex + 1
                retryInputIndex += 1
                inputIndex = retryInputIndex
            } else {
                return false
            }
        }
        while tokenIndex < tokens.count, tokens[tokenIndex] == "*" {
            tokenIndex += 1
        }
        return tokenIndex == tokens.count
    }

    static func matchesQuery(_ value: String, _ query: String) -> Bool {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return true }
        return isWildcard(trimmed)
            ? matchesWildcard(value, pattern: trimmed)
            : value.lowercased().contains(trimmed.lowercased())
    }

    /// True when `query` sits on an ASCII alphanumeric boundary (`home`
    /// matches "Home Assistant", not "homelab").
    static func hasBoundaryMatch(_ value: String, _ query: String) -> Bool {
        if query.isEmpty { return true }
        let haystack = Array(value.lowercased().unicodeScalars)
        let needle = Array(query.lowercased().unicodeScalars)
        guard needle.count <= haystack.count else { return false }
        func isWordScalar(_ scalar: Unicode.Scalar) -> Bool {
            (97...122).contains(scalar.value) || (48...57).contains(scalar.value) // a-z, 0-9
        }
        for start in 0...(haystack.count - needle.count)
        where haystack[start..<(start + needle.count)].elementsEqual(needle) {
            let end = start + needle.count
            let before = start == 0 || !isWordScalar(haystack[start - 1])
            let after = end == haystack.count || !isWordScalar(haystack[end])
            if before && after { return true }
        }
        return false
    }

    static func tokenize(_ query: String) -> [String] {
        query.lowercased()
            .split(whereSeparator: { $0.isWhitespace })
            .map(String.init)
    }

    static func fields(_ summary: SessionSummary, machineLabel: String) -> [Field: [String]] {
        let metadata = summary.metadata
        let paths = [metadata?.path, metadata?.worktree?.basePath, metadata?.worktree?.worktreePath]
            .compactMap { $0 }
        let values: [Field: [String?]] = [
            .title: [sessionTitle(summary)],
            .worktreeLabel: [worktreeLabel(summary)],
            .summary: [metadata?.summary?.text],
            .flavor: [metadata?.flavor],
            .machine: [machineLabel],
            .path: paths,
            .id: [summary.id],
        ]
        return values.mapValues { $0.compactMap { $0 }.filter { !$0.isEmpty } }
    }

    // MARK: - Scoring

    /// Best field contribution of one term (post-bonus, so a boundary hit on
    /// a lighter field can beat a mid-token hit on a heavier one).
    private static func bestHit(_ fields: [Field: [String]], term: String, wildcard: Bool) -> Double {
        var best = 0.0
        for field in Field.allCases {
            let values = fields[field] ?? []
            let matched = wildcard
                ? values.contains { matchesQuery($0, term) }
                : values.contains { $0.lowercased().contains(term) }
            guard matched else { continue }
            let boundary = wildcard || values.contains { hasBoundaryMatch($0, term) }
            best = max(best, field.weight * (boundary ? boundaryBonus : 1))
        }
        return best
    }

    private static func titleBonus(_ titles: [String], normalizedQuery: String) -> Double {
        var best = 0.0
        for title in titles {
            let normalized = title.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if normalized == normalizedQuery {
                best = max(best, exactTitleBonus)
            } else if normalizedQuery.contains(" "), normalized.contains(normalizedQuery) {
                best = max(best, titlePhraseBonus)
            }
        }
        return best
    }

    /// Scores `sessions` against `query`; nil for a blank query (no search).
    public static func scoreIndex(
        sessions: [SessionSummary],
        query: String,
        machineLabel: (String?) -> String
    ) -> ScoreIndex? {
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !normalized.isEmpty else { return nil }
        let wildcard = isWildcard(normalized)
        let terms = wildcard ? [normalized] : tokenize(normalized)
        var scores: [String: Double] = [:]
        for session in sessions {
            let fields = fields(session, machineLabel: machineLabel(session.metadata?.machineId))
            var score = 0.0
            var matchedAll = true
            for term in terms {
                let hit = bestHit(fields, term: term, wildcard: wildcard)
                guard hit > 0 else {
                    matchedAll = false
                    break
                }
                score += hit
            }
            guard matchedAll else { continue }
            if !wildcard {
                score += titleBonus(fields[.title] ?? [], normalizedQuery: normalized)
            }
            scores[session.id] = score
        }
        return ScoreIndex(scores: scores)
    }

    /// Matched sessions by relevance (then recency), keeping global pins,
    /// project pins and ordinary rows in separate sections.
    public static func rank(_ sessions: [SessionSummary], by index: ScoreIndex) -> [SessionSummary] {
        let matched = sessions.filter { index.matches($0.id) }
        func sorted(_ group: [SessionSummary]) -> [SessionSummary] {
            group.sorted { lhs, rhs in
                let left = index.scores[lhs.id] ?? 0
                let right = index.scores[rhs.id] ?? 0
                return left != right ? left > right : lhs.updatedAt > rhs.updatedAt
            }
        }
        let globalPins = matched.filter { $0.globalPinned == true }
        let projectPins = matched.filter { $0.globalPinned != true && $0.pinned == true }
        let ordinary = matched.filter { $0.globalPinned != true && $0.pinned != true }
        return sorted(globalPins) + sorted(projectPins) + sorted(ordinary)
    }
}

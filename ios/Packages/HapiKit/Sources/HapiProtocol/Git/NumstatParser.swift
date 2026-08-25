import Foundation

// Parser for raw `git diff --numstat` stdout
// (`GET /api/sessions/:id/git-diff-numstat?staged=`), the behavioral twin of
// `parseNumStat`/`createDiffStatsMap` in `web/src/lib/gitParsers.ts` and a
// line-for-line transcription of the tested Android port
// (`android/core/protocol/.../git/NumstatParser.kt`): binary files report
// `-\t-` and count as 0/0, rename paths come in either the brace form
// (`src/{old => new}/x.ts`) or the plain form (`old.txt => new.txt`), and the
// stats map indexes the raw spelling plus both normalized paths so the
// status-list merge finds them under the post-image path.

/// One numstat row.
public struct DiffFileStat: Equatable, Sendable {
    /// Raw path column, rename arrows included.
    public var file: String
    public var changes: Int
    public var insertions: Int
    public var deletions: Int
    public var binary: Bool

    public init(file: String, changes: Int, insertions: Int, deletions: Int, binary: Bool) {
        self.file = file
        self.changes = changes
        self.insertions = insertions
        self.deletions = deletions
        self.binary = binary
    }
}

public struct DiffSummary: Equatable, Sendable {
    public var files: [DiffFileStat]
    public var insertions: Int
    public var deletions: Int
    public var changes: Int
    /// Number of files listed.
    public var changed: Int

    public init(files: [DiffFileStat], insertions: Int, deletions: Int, changes: Int, changed: Int) {
        self.files = files
        self.insertions = insertions
        self.deletions = deletions
        self.changes = changes
        self.changed = changed
    }
}

/// Per-path counts for the Changes-list merge (web `createDiffStatsMap` values).
public struct DiffLineStats: Equatable, Sendable {
    public var added: Int
    public var removed: Int
    public var binary: Bool

    public init(added: Int, removed: Int, binary: Bool) {
        self.added = added
        self.removed = removed
        self.binary = binary
    }
}

public enum NumstatParser {
    // NSRegularExpression is immutable and thread-safe; nonisolated(unsafe)
    // sidesteps SDK-dependent Sendable annotation gaps under Swift 6 (same
    // pattern as HapiUI's UnifiedDiffParser).
    nonisolated(unsafe) private static let numstatLine = try! NSRegularExpression(
        pattern: #"^(\d+|-)\t(\d+|-)\t(.*)$"#
    )
    nonisolated(unsafe) private static let braceRename = try! NSRegularExpression(
        pattern: #"\{([^{}]+?)\s*=>\s*([^{}]+?)\}"#
    )

    /// Numstat stdout → per-file counts + totals (`parseNumStat`).
    public static func parse(_ numStatOutput: String) -> DiffSummary {
        var files: [DiffFileStat] = []
        var insertionsTotal = 0
        var deletionsTotal = 0
        var changesTotal = 0

        let lines = numStatOutput
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .components(separatedBy: "\n")
            .filter { !$0.isEmpty }
        for line in lines {
            guard let groups = GitRegex.groups(numstatLine, in: line) else { continue }
            let insertionsText = groups[1]
            let deletionsText = groups[2]
            let file = groups[3]

            let isBinary = insertionsText == "-" || deletionsText == "-"
            let insertions = isBinary ? 0 : (Int(insertionsText) ?? 0)
            let deletions = isBinary ? 0 : (Int(deletionsText) ?? 0)
            let changes = insertions + deletions

            files.append(DiffFileStat(
                file: file,
                changes: changes,
                insertions: insertions,
                deletions: deletions,
                binary: isBinary
            ))
            insertionsTotal += insertions
            deletionsTotal += deletions
            changesTotal += changes
        }

        return DiffSummary(
            files: files,
            insertions: insertionsTotal,
            deletions: deletionsTotal,
            changes: changesTotal,
            changed: files.count
        )
    }

    /// Counts keyed by every spelling of each path — the raw column plus the
    /// normalized new/old paths of a rename (`createDiffStatsMap`), so lookups
    /// by porcelain-status path always hit.
    public static func statsMap(_ summary: DiffSummary) -> [String: DiffLineStats] {
        var stats: [String: DiffLineStats] = [:]

        for file in summary.files {
            let stat = DiffLineStats(added: file.insertions, removed: file.deletions, binary: file.binary)
            let paths = normalizePath(file.file)
            stats[file.file] = stat
            if !paths.newPath.isEmpty && paths.newPath != file.file {
                stats[paths.newPath] = stat
            }
            if let oldPath = paths.oldPath, !oldPath.isEmpty,
               oldPath != file.file, oldPath != paths.newPath {
                stats[oldPath] = stat
            }
        }

        return stats
    }

    public struct NormalizedPaths: Equatable, Sendable {
        public var newPath: String
        public var oldPath: String?

        public init(newPath: String, oldPath: String? = nil) {
            self.newPath = newPath
            self.oldPath = oldPath
        }
    }

    /// `src/{old => new}/x.ts` / `old.txt => new.txt` → post/pre-image paths.
    public static func normalizePath(_ rawPath: String) -> NormalizedPaths {
        let trimmed = rawPath.trimmingCharacters(in: .whitespacesAndNewlines)

        if trimmed.contains("{") && trimmed.contains("=>") && trimmed.contains("}") {
            let newPath = replaceBraceRenames(in: trimmed, keepingGroup: 2)
            let oldPath = replaceBraceRenames(in: trimmed, keepingGroup: 1)
            return NormalizedPaths(newPath: newPath, oldPath: oldPath)
        }

        if trimmed.contains("=>") {
            // The Kotlin/web references split on `\s*=>\s*` and trim each
            // side; splitting on the bare arrow and trimming is equivalent
            // for the first/last components used here.
            let parts = trimmed.components(separatedBy: "=>")
            let oldPath = parts.first?.trimmingCharacters(in: .whitespaces)
            let newPath = parts.last?.trimmingCharacters(in: .whitespaces)
            if let newPath, !newPath.isEmpty {
                return NormalizedPaths(newPath: newPath, oldPath: oldPath)
            }
        }

        return NormalizedPaths(newPath: trimmed)
    }

    /// Replaces every `{old => new}` segment with the trimmed requested group
    /// (the Kotlin `Regex.replace` lambda equivalent).
    private static func replaceBraceRenames(in text: String, keepingGroup group: Int) -> String {
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        var result = ""
        var cursor = text.startIndex
        braceRename.enumerateMatches(in: text, range: range) { match, _, _ in
            guard let match,
                  let matchRange = Range(match.range, in: text),
                  let groupRange = Range(match.range(at: group), in: text) else { return }
            result += text[cursor..<matchRange.lowerBound]
            result += text[groupRange].trimmingCharacters(in: .whitespaces)
            cursor = matchRange.upperBound
        }
        result += text[cursor...]
        return result
    }
}

/// Tiny shared helper for the git parsers: full-line regex match → Kotlin
/// `groupValues`-style array (index 0 is the whole match; unmatched optional
/// groups come back as empty strings).
enum GitRegex {
    static func groups(_ regex: NSRegularExpression, in line: String) -> [String]? {
        let range = NSRange(line.startIndex..<line.endIndex, in: line)
        guard let match = regex.firstMatch(in: line, range: range) else { return nil }
        var values: [String] = []
        values.reserveCapacity(match.numberOfRanges)
        for index in 0..<match.numberOfRanges {
            if let groupRange = Range(match.range(at: index), in: line) {
                values.append(String(line[groupRange]))
            } else {
                values.append("")
            }
        }
        return values
    }
}

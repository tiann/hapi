import Foundation

/// Unified-diff model for rendering (`git diff` output, agent `unified_diff`
/// tool inputs). Pure value types + a tolerant parser.
///
/// Semantics cross-checked against the web client:
/// - hunk/line handling mirrors `CodexDiffView.parseUnifiedDiff`
///   (`+`/`-`/` ` lines, empty in-hunk lines count as context, the
///   `\ No newline at end of file` marker is not content),
/// - rename/copy and binary handling mirrors `gitParsers.ts` (`R`/`C` both
///   map to "renamed"; binary files report 0 additions / 0 deletions, like
///   numstat's `-` markers).
///
/// Placement note: this lives in HapiUI (not HapiProtocol) because it is a
/// rendering model; the porcelain-v2 status / numstat parsers from
/// `gitParsers.ts` belong to the files/git work package (A-M4a).
public struct DiffLine: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case context
        case addition
        case deletion
        /// `\ No newline at end of file` — metadata, not content.
        case noNewlineMarker
    }

    public var kind: Kind
    public var text: String
    /// 1-based line number in the old file (nil for additions / markers).
    public var oldNumber: Int?
    /// 1-based line number in the new file (nil for deletions / markers).
    public var newNumber: Int?

    public init(kind: Kind, text: String, oldNumber: Int? = nil, newNumber: Int? = nil) {
        self.kind = kind
        self.text = text
        self.oldNumber = oldNumber
        self.newNumber = newNumber
    }
}

public struct DiffHunk: Equatable, Sendable {
    public var oldStart: Int
    public var oldCount: Int
    public var newStart: Int
    public var newCount: Int
    /// Trailing text on the `@@` line (usually the enclosing function).
    public var sectionHeading: String?
    public var lines: [DiffLine]

    public init(
        oldStart: Int,
        oldCount: Int,
        newStart: Int,
        newCount: Int,
        sectionHeading: String? = nil,
        lines: [DiffLine] = []
    ) {
        self.oldStart = oldStart
        self.oldCount = oldCount
        self.newStart = newStart
        self.newCount = newCount
        self.sectionHeading = sectionHeading
        self.lines = lines
    }

    /// Reconstructed `@@ -a,b +c,d @@ heading` header for display.
    public var header: String {
        var text = "@@ -\(oldStart),\(oldCount) +\(newStart),\(newCount) @@"
        if let sectionHeading, !sectionHeading.isEmpty {
            text += " \(sectionHeading)"
        }
        return text
    }
}

public struct DiffFile: Equatable, Sendable {
    public enum ChangeKind: Equatable, Sendable {
        case modified
        case added
        case deleted
        /// Covers git rename AND copy entries (gitParsers maps R/C the same).
        case renamed
    }

    /// Old path (nil for added files / bare hunk-only diffs).
    public var oldPath: String?
    /// New path (nil for deleted files / bare hunk-only diffs).
    public var newPath: String?
    public var kind: ChangeKind
    public var isBinary: Bool
    public var hunks: [DiffHunk]

    public init(
        oldPath: String? = nil,
        newPath: String? = nil,
        kind: ChangeKind = .modified,
        isBinary: Bool = false,
        hunks: [DiffHunk] = []
    ) {
        self.oldPath = oldPath
        self.newPath = newPath
        self.kind = kind
        self.isBinary = isBinary
        self.hunks = hunks
    }

    public var additions: Int {
        hunks.reduce(0) { total, hunk in
            total + hunk.lines.filter { $0.kind == .addition }.count
        }
    }

    public var deletions: Int {
        hunks.reduce(0) { total, hunk in
            total + hunk.lines.filter { $0.kind == .deletion }.count
        }
    }

    /// Header label: `old → new` for renames, else the surviving path.
    public var displayPath: String {
        if kind == .renamed, let oldPath, let newPath, oldPath != newPath {
            return "\(oldPath) → \(newPath)"
        }
        return newPath ?? oldPath ?? "diff"
    }
}

// MARK: - Parser

public enum UnifiedDiffParser {
    // NSRegularExpression is immutable and thread-safe; nonisolated(unsafe)
    // sidesteps SDK-dependent Sendable annotation gaps under Swift 6.
    nonisolated(unsafe) private static let hunkHeaderRegex = try! NSRegularExpression(
        pattern: #"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: (.*))?$"#
    )
    nonisolated(unsafe) private static let diffGitRegex = try! NSRegularExpression(
        pattern: #"^diff --git (?:"?a/)?(.*?)"? (?:"?b/)?(.*?)"?$"#
    )

    /// Parse a unified diff (optionally with git extended headers, optionally
    /// multi-file, optionally headerless "bare" hunks as produced by agent
    /// `unified_diff` inputs). Tolerant: unknown lines outside hunks are
    /// ignored; hunks are closed when their declared line counts are consumed.
    public static func parse(_ text: String) -> [DiffFile] {
        var lines = text.components(separatedBy: "\n")
        // A trailing newline yields one empty trailing element — drop it so it
        // is not mistaken for an in-hunk empty context line.
        if lines.last == "" { lines.removeLast() }

        var files: [DiffFile] = []
        var current: DiffFile? = nil
        var hunk: DiffHunk? = nil
        var oldRemaining = 0
        var newRemaining = 0
        var oldNumber = 0
        var newNumber = 0

        func closeHunk() {
            if let finished = hunk {
                current?.hunks.append(finished)
            }
            hunk = nil
            oldRemaining = 0
            newRemaining = 0
        }

        func closeFile() {
            closeHunk()
            if let finished = current {
                // Keep only entries that describe an actual change; a stray
                // `--- prose` line outside any diff must not become a file.
                let meaningful = !finished.hunks.isEmpty
                    || finished.isBinary
                    || finished.kind != .modified
                    || (finished.oldPath != nil && finished.newPath != nil)
                if meaningful {
                    files.append(finished)
                }
            }
            current = nil
        }

        func ensureFile() {
            if current == nil {
                current = DiffFile()
            }
        }

        for line in lines {
            var inHunk = hunk != nil && (oldRemaining > 0 || newRemaining > 0)

            // In-hunk content must start with +/-/space/backslash (or be an
            // empty context line). A structural line while counts are still
            // open means the declared counts were wrong (hand-written / LLM
            // diffs) — close the hunk and dispatch the line normally.
            if inHunk, line.hasPrefix("diff --git ") || line.hasPrefix("@@") {
                closeHunk()
                inHunk = false
            }

            if !inHunk, line.hasPrefix("diff --git ") {
                closeFile()
                current = DiffFile()
                let range = NSRange(line.startIndex..<line.endIndex, in: line)
                if let match = diffGitRegex.firstMatch(in: line, range: range),
                   let oldRange = Range(match.range(at: 1), in: line),
                   let newRange = Range(match.range(at: 2), in: line) {
                    current?.oldPath = String(line[oldRange])
                    current?.newPath = String(line[newRange])
                }
                continue
            }

            if inHunk {
                guard var openHunk = hunk else { continue }
                if line.hasPrefix("+") {
                    newNumber += 1
                    newRemaining -= 1
                    openHunk.lines.append(DiffLine(
                        kind: .addition,
                        text: String(line.dropFirst()),
                        newNumber: newNumber
                    ))
                } else if line.hasPrefix("-") {
                    oldNumber += 1
                    oldRemaining -= 1
                    openHunk.lines.append(DiffLine(
                        kind: .deletion,
                        text: String(line.dropFirst()),
                        oldNumber: oldNumber
                    ))
                } else if line.hasPrefix("\\") {
                    openHunk.lines.append(DiffLine(kind: .noNewlineMarker, text: String(line)))
                } else if line.hasPrefix(" ") || line.isEmpty {
                    // Empty in-hunk lines are context whose leading space was
                    // trimmed in transit (CodexDiffView parity).
                    oldNumber += 1
                    newNumber += 1
                    oldRemaining -= 1
                    newRemaining -= 1
                    openHunk.lines.append(DiffLine(
                        kind: .context,
                        text: line.isEmpty ? "" : String(line.dropFirst()),
                        oldNumber: oldNumber,
                        newNumber: newNumber
                    ))
                } else {
                    // Malformed content (counts promised more lines than
                    // delivered, and this is no structural line either) —
                    // close the hunk and drop the offending line.
                    hunk = openHunk
                    closeHunk()
                    continue
                }
                hunk = openHunk
                if oldRemaining <= 0 && newRemaining <= 0 {
                    closeHunk()
                }
                continue
            }

            if line.hasPrefix("@@") {
                let range = NSRange(line.startIndex..<line.endIndex, in: line)
                guard let match = hunkHeaderRegex.firstMatch(in: line, range: range) else { continue }
                closeHunk()
                ensureFile()

                func group(_ index: Int) -> String? {
                    guard let groupRange = Range(match.range(at: index), in: line) else { return nil }
                    return String(line[groupRange])
                }
                let oldStart = group(1).flatMap(Int.init) ?? 0
                let oldCount = group(2).flatMap(Int.init) ?? 1
                let newStart = group(3).flatMap(Int.init) ?? 0
                let newCount = group(4).flatMap(Int.init) ?? 1
                hunk = DiffHunk(
                    oldStart: oldStart,
                    oldCount: oldCount,
                    newStart: newStart,
                    newCount: newCount,
                    sectionHeading: group(5)
                )
                oldRemaining = oldCount
                newRemaining = newCount
                oldNumber = oldStart - 1
                newNumber = newStart - 1
                // Zero-length sides (e.g. `@@ -0,0 +1,3 @@`) start counting
                // from the declared position.
                if oldCount == 0 { oldNumber = oldStart }
                if newCount == 0 { newNumber = newStart }
                if oldRemaining <= 0 && newRemaining <= 0 {
                    closeHunk()
                }
                continue
            }

            if line.hasPrefix("\\"), let lastHunkIndex = current?.hunks.indices.last {
                // `\ No newline at end of file` directly after a closed hunk.
                current?.hunks[lastHunkIndex].lines.append(
                    DiffLine(kind: .noNewlineMarker, text: String(line))
                )
                continue
            }

            if line.hasPrefix("--- ") {
                ensureFile()
                let path = cleanHeaderPath(String(line.dropFirst(4)))
                current?.oldPath = path
                if path == nil, current?.kind == .modified {
                    current?.kind = .added
                }
                continue
            }

            if line.hasPrefix("+++ ") {
                ensureFile()
                let path = cleanHeaderPath(String(line.dropFirst(4)))
                current?.newPath = path
                if path == nil, current?.kind == .modified {
                    current?.kind = .deleted
                }
                continue
            }

            if line.hasPrefix("new file mode") {
                if current?.kind == .modified { current?.kind = .added }
                continue
            }
            if line.hasPrefix("deleted file mode") {
                if current?.kind == .modified { current?.kind = .deleted }
                continue
            }
            if line.hasPrefix("rename from ") || line.hasPrefix("copy from ") {
                ensureFile()
                current?.kind = .renamed
                let prefixLength = line.hasPrefix("rename from ") ? 12 : 10
                current?.oldPath = String(line.dropFirst(prefixLength))
                continue
            }
            if line.hasPrefix("rename to ") || line.hasPrefix("copy to ") {
                ensureFile()
                current?.kind = .renamed
                let prefixLength = line.hasPrefix("rename to ") ? 10 : 8
                current?.newPath = String(line.dropFirst(prefixLength))
                continue
            }
            if line.hasPrefix("Binary files ") || line == "GIT binary patch" {
                ensureFile()
                current?.isBinary = true
                continue
            }
            if line.hasPrefix("index ")
                || line.hasPrefix("old mode")
                || line.hasPrefix("new mode")
                || line.hasPrefix("similarity index")
                || line.hasPrefix("dissimilarity index") {
                continue
            }

            // Anything else outside a hunk (prose, blank separators) — ignore.
        }

        closeFile()
        return files
    }

    /// Strip `a/` / `b/` prefixes, surrounding quotes and tab-appended
    /// metadata from `---` / `+++` header paths; `/dev/null` → nil.
    static func cleanHeaderPath(_ raw: String) -> String? {
        var path = raw
        if let tab = path.firstIndex(of: "\t") {
            path = String(path[..<tab])
        }
        path = path.trimmingCharacters(in: .whitespaces)
        if path.hasPrefix("\"") && path.hasSuffix("\"") && path.count >= 2 {
            path = String(path.dropFirst().dropLast())
        }
        if path == "/dev/null" { return nil }
        if path.hasPrefix("a/") || path.hasPrefix("b/") {
            path = String(path.dropFirst(2))
        }
        return path.isEmpty ? nil : path
    }
}

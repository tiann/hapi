import Foundation

// Parser for the raw `git status --porcelain=v2 --branch` stdout the hub
// relays verbatim in `GET /api/sessions/:id/git-status`
// (`GitCommandResponse.stdout`). Behavioral twin of
// `parseStatusSummaryV2`/`buildGitStatusFiles` in `web/src/lib/gitParsers.ts`,
// transcribed from the tested Android port
// (`android/core/protocol/.../git/GitStatusParser.kt`) — including its
// quirks, which the port reproduces on purpose so all clients render
// identical lists:
//
// - Rename/copy (`2`) records assign the first tab-separated path to
//   `GitFileEntryV2.from` and the second to `GitFileEntryV2.path` (the web
//   parser's reading of the `<path><sep><origPath>` payload).
// - Unmerged (`u`) records surface in both staged and unstaged lists when
//   both XY letters are set (e.g. `UU`).
// - Untracked entries ending in `/` are kept in `GitStatusSummary.notAdded`
//   but dropped from the merged `GitStatusFiles`.

/// One `1 ` / `2 ` / `u ` record: XY letters + path(s).
public struct GitFileEntryV2: Equatable, Sendable {
    public var path: String
    /// Index (staged) status letter; `.` = unmodified.
    public var index: String
    /// Working-tree status letter; `.` = unmodified.
    public var workingDir: String
    /// Pre-image path of a rename/copy record.
    public var from: String?

    public init(path: String, index: String, workingDir: String, from: String? = nil) {
        self.path = path
        self.index = index
        self.workingDir = workingDir
        self.from = from
    }
}

/// `# branch.*` header lines.
public struct GitBranchInfo: Equatable, Sendable {
    public var oid: String?
    /// Branch name, or `(detached)` / `(initial)`.
    public var head: String?
    public var upstream: String?
    public var ahead: Int?
    public var behind: Int?

    public init(
        oid: String? = nil,
        head: String? = nil,
        upstream: String? = nil,
        ahead: Int? = nil,
        behind: Int? = nil
    ) {
        self.oid = oid
        self.head = head
        self.upstream = upstream
        self.ahead = ahead
        self.behind = behind
    }
}

public struct GitStatusSummary: Equatable, Sendable {
    public var files: [GitFileEntryV2]
    /// `? ` untracked paths (directories keep their trailing `/`).
    public var notAdded: [String]
    /// `! ` ignored paths (only present with `--ignored`).
    public var ignored: [String]
    public var branch: GitBranchInfo

    public init(files: [GitFileEntryV2], notAdded: [String], ignored: [String], branch: GitBranchInfo) {
        self.files = files
        self.notAdded = notAdded
        self.ignored = ignored
        self.branch = branch
    }
}

/// Display status derived from one XY letter (`getFileStatus` in the web parser).
public enum GitFileChange: Equatable, Sendable {
    case modified
    case added
    case deleted
    case renamed
    case untracked
    case conflicted
}

/// One row of the Changes list (web `GitFileStatus`, `web/src/types/api.ts`).
public struct GitFileStatus: Equatable, Sendable {
    /// Last path segment (`app.ts`).
    public var fileName: String
    /// Directory part without trailing slash; empty at the repo root.
    public var filePath: String
    public var fullPath: String
    public var status: GitFileChange
    public var isStaged: Bool
    public var linesAdded: Int
    public var linesRemoved: Int
    public var oldPath: String?

    public init(
        fileName: String,
        filePath: String,
        fullPath: String,
        status: GitFileChange,
        isStaged: Bool,
        linesAdded: Int,
        linesRemoved: Int,
        oldPath: String? = nil
    ) {
        self.fileName = fileName
        self.filePath = filePath
        self.fullPath = fullPath
        self.status = status
        self.isStaged = isStaged
        self.linesAdded = linesAdded
        self.linesRemoved = linesRemoved
        self.oldPath = oldPath
    }
}

/// Merged status + numstat model the Changes tab renders (web `GitStatusFiles`).
public struct GitStatusFiles: Equatable, Sendable {
    public var stagedFiles: [GitFileStatus]
    public var unstagedFiles: [GitFileStatus]
    /// Branch name; nil for detached HEAD / unborn branch.
    public var branch: String?
    public var totalStaged: Int
    public var totalUnstaged: Int

    public init(
        stagedFiles: [GitFileStatus],
        unstagedFiles: [GitFileStatus],
        branch: String?,
        totalStaged: Int,
        totalUnstaged: Int
    ) {
        self.stagedFiles = stagedFiles
        self.unstagedFiles = unstagedFiles
        self.branch = branch
        self.totalStaged = totalStaged
        self.totalUnstaged = totalUnstaged
    }
}

public enum GitStatusParser {
    nonisolated(unsafe) private static let branchOid = try! NSRegularExpression(
        pattern: #"^# branch\.oid (.+)$"#
    )
    nonisolated(unsafe) private static let branchHead = try! NSRegularExpression(
        pattern: #"^# branch\.head (.+)$"#
    )
    nonisolated(unsafe) private static let branchUpstream = try! NSRegularExpression(
        pattern: #"^# branch\.upstream (.+)$"#
    )
    nonisolated(unsafe) private static let branchAB = try! NSRegularExpression(
        pattern: #"^# branch\.ab \+(\d+) -(\d+)$"#
    )

    nonisolated(unsafe) private static let ordinaryChange = try! NSRegularExpression(
        pattern: #"^1 (.)(.) (.{4}) (\d{6}) (\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) (.+)$"#
    )
    nonisolated(unsafe) private static let renameCopy = try! NSRegularExpression(
        pattern: #"^2 (.)(.) (.{4}) (\d{6}) (\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([RC])(\d{1,3}) (.+)\t(.+)$"#
    )
    nonisolated(unsafe) private static let unmerged = try! NSRegularExpression(
        pattern: #"^u (.)(.) (.{4}) (\d{6}) (\d{6}) (\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([0-9a-f]+) (.+)$"#
    )
    nonisolated(unsafe) private static let untracked = try! NSRegularExpression(
        pattern: #"^\? (.+)$"#
    )
    nonisolated(unsafe) private static let ignoredEntry = try! NSRegularExpression(
        pattern: #"^! (.+)$"#
    )

    /// Porcelain-v2 stdout → structured summary (`parseStatusSummaryV2`).
    public static func parse(_ statusOutput: String) -> GitStatusSummary {
        var files: [GitFileEntryV2] = []
        var notAdded: [String] = []
        var ignored: [String] = []
        var branch = GitBranchInfo()

        let lines = statusOutput
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .components(separatedBy: "\n")
            .filter { !$0.isEmpty }
        for line in lines {
            if line.hasPrefix("# branch.oid ") {
                if let groups = GitRegex.groups(branchOid, in: line) {
                    branch.oid = groups[1]
                }
            } else if line.hasPrefix("# branch.head ") {
                if let groups = GitRegex.groups(branchHead, in: line) {
                    branch.head = groups[1]
                }
            } else if line.hasPrefix("# branch.upstream ") {
                if let groups = GitRegex.groups(branchUpstream, in: line) {
                    branch.upstream = groups[1]
                }
            } else if line.hasPrefix("# branch.ab ") {
                if let groups = GitRegex.groups(branchAB, in: line),
                   let ahead = Int(groups[1]),
                   let behind = Int(groups[2]) {
                    branch.ahead = ahead
                    branch.behind = behind
                }
            } else if line.hasPrefix("1 ") {
                if let groups = GitRegex.groups(ordinaryChange, in: line) {
                    files.append(GitFileEntryV2(
                        path: groups[9],
                        index: groups[1],
                        workingDir: groups[2]
                    ))
                }
            } else if line.hasPrefix("2 ") {
                if let groups = GitRegex.groups(renameCopy, in: line) {
                    files.append(GitFileEntryV2(
                        path: groups[12],
                        index: groups[1],
                        workingDir: groups[2],
                        from: groups[11]
                    ))
                }
            } else if line.hasPrefix("u ") {
                if let groups = GitRegex.groups(unmerged, in: line) {
                    files.append(GitFileEntryV2(
                        path: groups[11],
                        index: groups[1],
                        workingDir: groups[2]
                    ))
                }
            } else if line.hasPrefix("? ") {
                if let groups = GitRegex.groups(untracked, in: line) {
                    notAdded.append(groups[1])
                }
            } else if line.hasPrefix("! ") {
                if let groups = GitRegex.groups(ignoredEntry, in: line) {
                    ignored.append(groups[1])
                }
            }
        }

        return GitStatusSummary(files: files, notAdded: notAdded, ignored: ignored, branch: branch)
    }

    /// Branch name to display; nil for `(detached)` / `(initial)` (`getCurrentBranchV2`).
    public static func currentBranch(_ summary: GitStatusSummary) -> String? {
        guard let head = summary.branch.head else { return nil }
        if head == "(detached)" || head == "(initial)" { return nil }
        return head
    }

    /// Status stdout + the two `git diff --numstat` stdouts → the Changes-tab
    /// model (`buildGitStatusFiles`): staged/unstaged split by XY letter, line
    /// counts merged from the matching numstat side, untracked files appended
    /// to the unstaged list (directories skipped).
    public static func buildGitStatusFiles(
        statusOutput: String,
        unstagedDiffOutput: String,
        stagedDiffOutput: String
    ) -> GitStatusFiles {
        let summary = parse(statusOutput)
        let branchName = currentBranch(summary)

        let unstagedStats = NumstatParser.statsMap(NumstatParser.parse(unstagedDiffOutput))
        let stagedStats = NumstatParser.statsMap(NumstatParser.parse(stagedDiffOutput))
        let noStats = DiffLineStats(added: 0, removed: 0, binary: false)

        var stagedFiles: [GitFileStatus] = []
        var unstagedFiles: [GitFileStatus] = []

        for file in summary.files {
            let parts = file.path.components(separatedBy: "/")
            let lastPart = parts.last ?? file.path
            let fileName = lastPart.isEmpty ? file.path : lastPart
            let filePath = parts.dropLast().joined(separator: "/")

            if file.index != " " && file.index != "." && file.index != "?" {
                let stats = stagedStats[file.path] ?? noStats
                stagedFiles.append(GitFileStatus(
                    fileName: fileName,
                    filePath: filePath,
                    fullPath: file.path,
                    status: fileStatus(file.index),
                    isStaged: true,
                    linesAdded: stats.added,
                    linesRemoved: stats.removed,
                    oldPath: file.from
                ))
            }

            if file.workingDir != " " && file.workingDir != "." {
                let stats = unstagedStats[file.path] ?? noStats
                unstagedFiles.append(GitFileStatus(
                    fileName: fileName,
                    filePath: filePath,
                    fullPath: file.path,
                    status: fileStatus(file.workingDir),
                    isStaged: false,
                    linesAdded: stats.added,
                    linesRemoved: stats.removed,
                    oldPath: file.from
                ))
            }
        }

        for untrackedPath in summary.notAdded {
            if untrackedPath.hasSuffix("/") { continue } // untracked directories are not rows
            let parts = untrackedPath.components(separatedBy: "/")
            let lastPart = parts.last ?? untrackedPath
            unstagedFiles.append(GitFileStatus(
                fileName: lastPart.isEmpty ? untrackedPath : lastPart,
                filePath: parts.dropLast().joined(separator: "/"),
                fullPath: untrackedPath,
                status: .untracked,
                isStaged: false,
                linesAdded: 0,
                linesRemoved: 0
            ))
        }

        return GitStatusFiles(
            stagedFiles: stagedFiles,
            unstagedFiles: unstagedFiles,
            branch: branchName,
            totalStaged: stagedFiles.count,
            totalUnstaged: unstagedFiles.count
        )
    }

    private static func fileStatus(_ statusLetter: String) -> GitFileChange {
        switch statusLetter {
        case "M": .modified
        case "A": .added
        case "D": .deleted
        case "R", "C": .renamed
        case "?": .untracked
        case "U": .conflicted
        default: .modified
        }
    }
}

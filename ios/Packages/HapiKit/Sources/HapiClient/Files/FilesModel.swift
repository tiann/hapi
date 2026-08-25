import Foundation
import HapiProtocol
import Observation

// The files screen's published state types live at file scope (not nested in
// the @MainActor model) so they stay nonisolated and their Equatable/
// Identifiable conformances are unproblematic — same layout as
// ChatInteractionState.swift.

/// Changes tab (web `useGitStatusFiles` + `files.tsx` Changes list).
public struct FilesChangesState: Equatable, Sendable {
    public var isLoading: Bool
    /// nil after load ⇒ git unavailable for this session (not a repo / no path).
    public var status: GitStatusFiles?
    /// Banner text: status failure, or partial numstat failures.
    public var error: String?

    public init(isLoading: Bool = true, status: GitStatusFiles? = nil, error: String? = nil) {
        self.isLoading = isLoading
        self.status = status
        self.error = error
    }
}

/// One row of the flattened Browse tree.
public enum FilesBrowseRow: Equatable, Sendable, Identifiable {
    /// `path` is session-root-relative (`src/app`).
    case directory(path: String, name: String, depth: Int, isExpanded: Bool)
    case file(path: String, name: String, depth: Int, size: Int?, modified: Double?)
    /// Placeholder while a directory listing is in flight.
    case loading(parentPath: String, depth: Int)
    /// Inline listing failure for one directory (web `DirectoryErrorRow`).
    case failure(parentPath: String, depth: Int, message: String)

    public var id: String {
        switch self {
        case .directory(let path, _, _, _): "dir:\(path)"
        case .file(let path, _, _, _, _): "file:\(path)"
        case .loading(let parentPath, _): "loading:\(parentPath)"
        case .failure(let parentPath, _, _): "error:\(parentPath)"
        }
    }

    public var depth: Int {
        switch self {
        case .directory(_, _, let depth, _): depth
        case .file(_, _, let depth, _, _): depth
        case .loading(_, let depth): depth
        case .failure(_, let depth, _): depth
        }
    }
}

public struct FilesBrowseState: Equatable, Sendable {
    public var rows: [FilesBrowseRow]
    public var showHidden: Bool

    public init(rows: [FilesBrowseRow] = [], showHidden: Bool = false) {
        self.rows = rows
        self.showHidden = showHidden
    }
}

/// Search tab (debounced `GET /files?query=`).
public struct FilesSearchState: Equatable, Sendable {
    public var query: String
    public var isLoading: Bool
    public var results: [FileSearchItem]
    public var error: String?
    /// True once a search for the current query completed (drives the empty state).
    public var hasSearched: Bool

    public init(
        query: String = "",
        isLoading: Bool = false,
        results: [FileSearchItem] = [],
        error: String? = nil,
        hasSearched: Bool = false
    ) {
        self.query = query
        self.isLoading = isLoading
        self.results = results
        self.error = error
        self.hasSearched = hasSearched
    }
}

/// Files screen state (A-M4a): three independent tabs over the session's
/// git/files endpoints, mirroring the Android `FilesViewModel` (which mirrors
/// web `files.tsx`):
///
/// - **Changes** ports `useGitStatusFiles` — status + both numstat sides
///   fetched (numstats in parallel) and merged in `HapiProtocol`'s
///   `GitStatusParser.buildGitStatusFiles`; a failed numstat side degrades to
///   zero counts plus a banner note, never a failed tab.
/// - **Browse** is a lazily-expanded directory tree flattened to rows
///   (dirs-first case-insensitive name sort like web `directory-sort.ts`,
///   per-node cache, plus a hidden-file toggle).
/// - **Search** debounces the ripgrep-backed `/files` query (300 ms,
///   limit 200 — the web `useSessionFileSearch` defaults).
///
/// Lives in HapiKit (not the app target) so the whole surface runs under
/// `swift test` against a fake ``FilesRequesting``.
@MainActor @Observable
public final class FilesModel {
    public typealias ChangesState = FilesChangesState
    public typealias BrowseRow = FilesBrowseRow
    public typealias BrowseState = FilesBrowseState
    public typealias SearchState = FilesSearchState

    // MARK: - Observable state

    public private(set) var changes = ChangesState()
    public private(set) var browse = BrowseState()
    public private(set) var search = SearchState()

    // MARK: - Wiring

    public static let defaultSearchDebounce: Duration = .milliseconds(300)
    /// Web default limit (`useSessionFileSearch`).
    public static let searchLimit = 200
    private static let rootPath = ""

    private let sessionId: String
    private let requester: any FilesRequesting
    private let searchDebounce: Duration

    /// Absent from the map = never requested; entries nil while loading.
    private struct DirNode {
        var entries: [DirectoryEntry]?
        var errorMessage: String?
        var isLoading: Bool { entries == nil && errorMessage == nil }
    }

    private var nodes: [String: DirNode] = [:]
    private var expanded: Set<String> = []
    private var started = false
    @ObservationIgnored private var searchTask: Task<Void, Never>?

    public init(
        sessionId: String,
        requester: any FilesRequesting,
        searchDebounce: Duration = FilesModel.defaultSearchDebounce
    ) {
        self.sessionId = sessionId
        self.requester = requester
        self.searchDebounce = searchDebounce
    }

    public func start() {
        guard !started else { return }
        started = true
        refreshChanges()
        loadDirectory(Self.rootPath)
    }

    // MARK: - Changes

    public func refreshChanges() {
        Task { await self.loadChanges() }
    }

    private func loadChanges() async {
        changes.isLoading = true
        changes.error = nil

        let statusResult: GitCommandResponse
        do {
            statusResult = try await requester.gitStatus(sessionId: sessionId)
        } catch is CancellationError {
            return
        } catch {
            changes = ChangesState(
                isLoading: false,
                status: nil,
                error: Self.errorMessage(error) ?? "Git status unavailable"
            )
            return
        }
        guard statusResult.success else {
            changes = ChangesState(
                isLoading: false,
                status: nil,
                error: statusResult.error ?? statusResult.stderr ?? "Git status unavailable"
            )
            return
        }

        // Both numstat sides in parallel; a failed side degrades to zero
        // counts plus a banner note, never a failed tab (web parity).
        let requester = self.requester
        let sessionId = self.sessionId
        let unstagedFetch = Task { () -> Result<GitCommandResponse, any Error> in
            do { return .success(try await requester.gitDiffNumstat(sessionId: sessionId, staged: false)) }
            catch { return .failure(error) }
        }
        let stagedFetch = Task { () -> Result<GitCommandResponse, any Error> in
            do { return .success(try await requester.gitDiffNumstat(sessionId: sessionId, staged: true)) }
            catch { return .failure(error) }
        }
        let unstagedResult = await unstagedFetch.value
        let stagedResult = await stagedFetch.value

        let unstaged = try? unstagedResult.get()
        let staged = try? stagedResult.get()
        let status = GitStatusParser.buildGitStatusFiles(
            statusOutput: statusResult.stdout ?? "",
            unstagedDiffOutput: unstaged?.success == true ? (unstaged?.stdout ?? "") : "",
            stagedDiffOutput: staged?.success == true ? (staged?.stdout ?? "") : ""
        )

        var problems: [String] = []
        if unstaged?.success != true {
            let detail = Self.describeNumstatFailure(unstaged, Self.failureError(unstagedResult))
            problems.append("Unstaged diff unavailable: \(detail)")
        }
        if staged?.success != true {
            let detail = Self.describeNumstatFailure(staged, Self.failureError(stagedResult))
            problems.append("Staged diff unavailable: \(detail)")
        }

        changes = ChangesState(
            isLoading: false,
            status: status,
            error: problems.isEmpty ? nil : problems.joined(separator: " ")
        )
    }

    nonisolated private static func describeNumstatFailure(
        _ result: GitCommandResponse?,
        _ error: (any Error)?
    ) -> String {
        result?.error ?? result?.stderr ?? errorMessage(error) ?? "unknown error"
    }

    // MARK: - Browse

    public func toggleDirectory(path: String) {
        let wasExpanded = expanded.contains(path)
        if wasExpanded {
            expanded.remove(path)
        } else {
            expanded.insert(path)
        }
        if !wasExpanded && nodes[path] == nil {
            loadDirectory(path)
        } else {
            rebuildBrowse()
        }
    }

    public func setShowHidden(_ showHidden: Bool) {
        browse.showHidden = showHidden
        rebuildBrowse()
    }

    /// Re-lists the root and every expanded directory.
    public func refreshBrowse() {
        loadDirectory(Self.rootPath)
        for path in expanded {
            loadDirectory(path)
        }
    }

    private func loadDirectory(_ path: String) {
        nodes[path] = DirNode()
        rebuildBrowse()
        Task {
            let node: DirNode
            do {
                let response = try await self.requester.listSessionDirectory(
                    sessionId: self.sessionId,
                    path: path.isEmpty ? nil : path
                )
                if response.success {
                    node = DirNode(entries: response.entries ?? [])
                } else {
                    node = DirNode(errorMessage: response.error ?? "Failed to list directory")
                }
            } catch is CancellationError {
                return
            } catch {
                node = DirNode(errorMessage: Self.errorMessage(error) ?? "Failed to list directory")
            }
            self.nodes[path] = node
            self.rebuildBrowse()
        }
    }

    private func rebuildBrowse() {
        var rows: [BrowseRow] = []
        appendChildren(of: Self.rootPath, depth: 0, into: &rows)
        browse.rows = rows
    }

    private func appendChildren(of path: String, depth: Int, into rows: inout [BrowseRow]) {
        guard let node = nodes[path], !node.isLoading else {
            rows.append(.loading(parentPath: path, depth: depth))
            return
        }
        if let message = node.errorMessage {
            rows.append(.failure(parentPath: path, depth: depth, message: message))
            return
        }
        let showHidden = browse.showHidden
        let visible = (node.entries ?? [])
            .filter { showHidden || !$0.name.hasPrefix(".") }
            .sorted(by: Self.directoriesFirstByName)
        for entry in visible {
            let childPath = path.isEmpty ? entry.name : "\(path)/\(entry.name)"
            switch entry.type {
            case .directory:
                let isExpanded = expanded.contains(childPath)
                rows.append(.directory(
                    path: childPath,
                    name: entry.name,
                    depth: depth,
                    isExpanded: isExpanded
                ))
                if isExpanded {
                    appendChildren(of: childPath, depth: depth + 1, into: &rows)
                }
            case .file:
                rows.append(.file(
                    path: childPath,
                    name: entry.name,
                    depth: depth,
                    size: entry.size,
                    modified: entry.modified
                ))
            case .other:
                // Sockets, links, … are dropped, like the web tree.
                break
            }
        }
    }

    /// Dirs first, then case-insensitive name (web `sortDirectoryEntries`
    /// default); raw name as the deterministic tie-break.
    nonisolated private static func directoriesFirstByName(
        _ lhs: DirectoryEntry,
        _ rhs: DirectoryEntry
    ) -> Bool {
        let lhsIsDir = lhs.type == .directory
        let rhsIsDir = rhs.type == .directory
        if lhsIsDir != rhsIsDir { return lhsIsDir }
        let lhsName = lhs.name.lowercased()
        let rhsName = rhs.name.lowercased()
        if lhsName != rhsName { return lhsName < rhsName }
        return lhs.name < rhs.name
    }

    // MARK: - Search

    public func setSearchQuery(_ query: String) {
        search.query = query
        searchTask?.cancel()
        guard !Self.isBlank(query) else {
            searchTask = nil
            search = SearchState(query: query)
            return
        }
        let debounce = searchDebounce
        searchTask = Task { [weak self] in
            do {
                try await Task.sleep(for: debounce)
            } catch {
                return // superseded by newer input
            }
            await self?.runSearch(query: query)
        }
    }

    public func refreshSearch() {
        let query = search.query
        guard !Self.isBlank(query) else { return }
        Task { await self.runSearch(query: query) }
    }

    private func runSearch(query: String) async {
        search.isLoading = true
        search.error = nil
        do {
            let response = try await requester.searchSessionFiles(
                sessionId: sessionId,
                query: query,
                limit: Self.searchLimit
            )
            guard !Task.isCancelled else { return }
            if response.success {
                search.isLoading = false
                search.results = response.files ?? []
                search.error = nil
                search.hasSearched = true
            } else {
                search.isLoading = false
                search.results = []
                search.error = response.error ?? "Failed to search files"
                search.hasSearched = true
            }
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled else { return }
            search.isLoading = false
            search.results = []
            search.error = Self.errorMessage(error) ?? "Failed to search files"
            search.hasSearched = true
        }
    }

    // MARK: - Shared helpers

    nonisolated private static func isBlank(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The Kotlin `e.message` analogue: a human-readable message when the
    /// error carries one, nil otherwise (callers supply the fallback).
    nonisolated static func errorMessage(_ error: (any Error)?) -> String? {
        guard let error else { return nil }
        return (error as? LocalizedError)?.errorDescription
    }

    nonisolated private static func failureError<T>(_ result: Result<T, any Error>) -> (any Error)? {
        if case .failure(let error) = result { return error }
        return nil
    }
}

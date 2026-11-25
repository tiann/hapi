import Foundation
import HapiProtocol
import Observation

public protocol NewSessionDirectoryRequesting: MachineDirectoryRequesting {
    func machinePathsExist(machineId: String, paths: [String]) async throws -> MachinePathsExistsResponse
}

extension APIClient: NewSessionDirectoryRequesting {}

public enum DirectoryLookupState: Equatable, Sendable {
    case idle
    case loading
    case loaded
    case outsideRoots
    case failed(String)
}

/// Directory queries for the create form. Listing and existence checks run
/// independently, so a slow/failed listing cannot hide the path's validation.
/// Every response belongs to one machine and input revision.
@MainActor @Observable
public final class NewSessionDirectoryModel {
    public private(set) var suggestions: [String] = []
    public private(set) var lookupState: DirectoryLookupState = .idle
    public private(set) var exists: Bool?
    public private(set) var outsideWorkspaceRoots = false
    public private(set) var isCheckingExistence = false
    public private(set) var existenceError: String?

    private struct Input: Equatable {
        let machineId: String?
        let path: String
        let roots: [String]
        let showSuggestions: Bool
    }

    private struct ListingKey: Equatable {
        let machineId: String
        let parent: String
        let includeHidden: Bool
    }

    @ObservationIgnored private let requester: any NewSessionDirectoryRequesting
    @ObservationIgnored private let debounce: Duration
    @ObservationIgnored private let lookupError: String
    @ObservationIgnored private let checkError: String
    @ObservationIgnored private var input: Input?
    @ObservationIgnored private var requestVersion = 0
    @ObservationIgnored private var listingTask: Task<Void, Never>?
    @ObservationIgnored private var existenceTask: Task<Void, Never>?
    @ObservationIgnored private var cachedListing: (key: ListingKey, entries: [MachineDirectoryEntry])?

    public init(
        requester: any NewSessionDirectoryRequesting,
        debounce: Duration = .milliseconds(250),
        lookupError: String = "Failed to browse directories",
        checkError: String = "Failed to check directory"
    ) {
        self.requester = requester
        self.debounce = debounce
        self.lookupError = lookupError
        self.checkError = checkError
    }

    public func update(machine: Machine?, path: String, showSuggestions: Bool) {
        schedule(Input(
            machineId: machine?.id,
            path: RemoteDirectoryPath.expandHome(path, homeDirectory: machine?.metadata?.homeDir),
            roots: machine.map(RemoteDirectoryPath.browseRoots) ?? [],
            showSuggestions: showSuggestions
        ))
    }

    public func retry() {
        guard let input else { return }
        cachedListing = nil
        schedule(input, force: true)
    }

    public func stop() {
        listingTask?.cancel()
        existenceTask?.cancel()
        requestVersion += 1
        input = nil
        suggestions = []
        lookupState = .idle
        isCheckingExistence = false
        exists = nil
        outsideWorkspaceRoots = false
        existenceError = nil
    }

    /// The Create action's authoritative recheck supersedes the background probe.
    public func acceptExistence(
        _ result: MachinePathsExistsResponse,
        machineId: String,
        path: String
    ) {
        guard input?.machineId == machineId, input?.path == path else { return }
        existenceTask?.cancel()
        applyExistence(result, path: path)
    }

    private func applyExistence(_ result: MachinePathsExistsResponse, path: String) {
        exists = result.exists[path]
        outsideWorkspaceRoots = result.outsideWorkspaceRoots?.contains(path) == true
        isCheckingExistence = false
        existenceError = nil
    }

    private func schedule(_ next: Input, force: Bool = false) {
        guard force || input != next else { return }
        if input?.machineId != next.machineId || input?.roots != next.roots {
            cachedListing = nil
        }
        stop()
        input = next
        let version = requestVersion
        guard let machineId = next.machineId else { return }

        if !next.path.isEmpty {
            isCheckingExistence = true
            existenceTask = Task { [weak self, requester, debounce] in
                do {
                    try await Task.sleep(for: debounce)
                    try Task.checkCancellation()
                    let result = try await requester.machinePathsExist(machineId: machineId, paths: [next.path])
                    guard let self, self.isCurrent(version) else { return }
                    self.applyExistence(result, path: next.path)
                } catch {
                    guard let self, self.isCurrent(version) else { return }
                    self.isCheckingExistence = false
                    self.existenceError = (error as? LocalizedError)?.errorDescription ?? self.checkError
                }
            }
        }

        guard next.showSuggestions else { return }
        switch NewSessionLogic.directoryAutocompleteQuery(path: next.path, roots: next.roots) {
        case .none:
            return
        case .roots(let paths):
            suggestions = paths
            lookupState = .loaded
        case .outsideRoots:
            lookupState = .outsideRoots
        case .directory(let query):
            let key = ListingKey(machineId: machineId, parent: query.parent, includeHidden: query.includeHidden)
            if let cachedListing, cachedListing.key == key {
                applyListing(cachedListing.entries, query: query, path: next.path)
                return
            }
            lookupState = .loading
            listingTask = Task { [weak self, requester, debounce] in
                do {
                    try await Task.sleep(for: debounce)
                    try Task.checkCancellation()
                    let response = try await requester.listMachineDirectory(
                        machineId: machineId,
                        path: query.parent,
                        includeHidden: query.includeHidden
                    )
                    guard let self, self.isCurrent(version) else { return }
                    guard response.success else {
                        self.lookupState = .failed(response.error ?? self.lookupError)
                        return
                    }
                    let entries = response.entries ?? []
                    self.cachedListing = (key, entries)
                    self.applyListing(entries, query: query, path: next.path)
                } catch {
                    guard let self, self.isCurrent(version) else { return }
                    self.lookupState = .failed((error as? LocalizedError)?.errorDescription ?? self.lookupError)
                }
            }
        }
    }

    private func applyListing(_ entries: [MachineDirectoryEntry], query: NewSessionLogic.ParentQuery, path: String) {
        suggestions = NewSessionLogic.buildSuggestions(query: query, entries: entries)
            .filter { $0 != path }
        lookupState = .loaded
    }

    private func isCurrent(_ version: Int) -> Bool {
        !Task.isCancelled && requestVersion == version
    }
}

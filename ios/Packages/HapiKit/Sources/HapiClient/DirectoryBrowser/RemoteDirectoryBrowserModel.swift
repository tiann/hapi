import Foundation
import HapiProtocol
import Observation

public protocol MachineDirectoryRequesting: Sendable {
    func listMachineDirectory(
        machineId: String,
        path: String,
        includeHidden: Bool
    ) async throws -> MachineListDirectoryResponse
}

extension APIClient: MachineDirectoryRequesting {}

public struct RemoteDirectoryBreadcrumb: Identifiable, Equatable, Sendable {
    public let label: String
    public let path: String
    public var id: String { path }

    public init(label: String, path: String) {
        self.label = label
        self.path = path
    }
}

/** Pure remote-path operations shared by directory-browser consumers. */
public enum RemoteDirectoryPath {
    public static func browseRoots(for machine: Machine) -> [String] {
        let workspaceRoots = unique(
            machine.metadata?.workspaceRoots?
                .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
                ?? []
        )
        if !workspaceRoots.isEmpty { return workspaceRoots }
        if let home = machine.metadata?.homeDir,
           !home.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return [home]
        }
        return []
    }

    public static func join(parent: String, child: String) -> String {
        let separator = parent.contains("\\") && !parent.contains("/") ? "\\" : "/"
        return parent.hasSuffix("/") || parent.hasSuffix("\\")
            ? parent + child
            : parent + separator + child
    }

    public static func parent(_ path: String) -> String? {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != "/", !isDriveRoot(trimmed) else { return nil }

        var characters = Array(trimmed)
        while characters.count > 1, let last = characters.last, isPathSeparator(last) {
            if characters.count == 3, characters[1] == ":" { break }
            characters.removeLast()
        }
        let withoutTrailing = String(characters)
        let isUNC = withoutTrailing.hasPrefix("\\\\") || withoutTrailing.hasPrefix("//")
        if isUNC {
            let components = String(withoutTrailing.dropFirst(2))
                .split(whereSeparator: isPathSeparator)
            if components.count <= 2 { return nil }
        }
        guard let separatorIndex = characters.lastIndex(where: isPathSeparator) else { return nil }
        if separatorIndex == 0 { return String(characters.prefix(1)) }
        if separatorIndex == 2, characters.count >= 2, characters[1] == ":" {
            return String(characters.prefix(3))
        }
        return String(characters[..<separatorIndex])
    }

    /** Lexical UI boundary; the runner remains authoritative and resolves symlinks. */
    public static func isWithinRoot(path: String, root: String) -> Bool {
        func normalize(_ value: String) -> String {
            var slashed = value
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .replacingOccurrences(of: "\\", with: "/")
            while slashed.count > 1, slashed.hasSuffix("/"), !isDriveRoot(slashed) {
                slashed.removeLast()
            }
            return slashed
        }

        var normalizedPath = normalize(path)
        var normalizedRoot = normalize(root)
        guard !normalizedPath.isEmpty, !normalizedRoot.isEmpty else { return false }
        let caseInsensitive = isDriveAbsolute(normalizedRoot) || normalizedRoot.hasPrefix("//")
        if caseInsensitive {
            normalizedPath = normalizedPath.lowercased()
            normalizedRoot = normalizedRoot.lowercased()
        }
        let rootPrefix = normalizedRoot.hasSuffix("/") ? normalizedRoot : normalizedRoot + "/"
        return normalizedPath == normalizedRoot || normalizedPath.hasPrefix(rootPrefix)
    }

    private static func unique(_ paths: [String]) -> [String] {
        var seen: Set<String> = []
        return paths.filter { seen.insert($0).inserted }
    }

    private static func isPathSeparator(_ character: Character) -> Bool {
        character == "/" || character == "\\"
    }

    private static func isDriveRoot(_ value: String) -> Bool {
        let characters = Array(value)
        return characters.count == 3
            && characters[0].isLetter
            && characters[1] == ":"
            && isPathSeparator(characters[2])
    }

    private static func isDriveAbsolute(_ value: String) -> Bool {
        let characters = Array(value)
        return characters.count >= 3
            && characters[0].isLetter
            && characters[1] == ":"
            && isPathSeparator(characters[2])
    }
}

/**
 * Reusable runner-backed directory navigation state machine.
 *
 * Consumers own presentation and selection handling. Navigation is lexically
 * confined to ``roots``; the runner performs canonical symlink-aware checks.
 */
@MainActor @Observable
public final class RemoteDirectoryBrowserModel {
    public private(set) var isPresented = false
    public private(set) var path = ""
    public private(set) var roots: [String] = []
    public private(set) var breadcrumbs: [RemoteDirectoryBreadcrumb] = []
    public private(set) var entries: [MachineDirectoryEntry] = []
    public private(set) var isLoading = false
    public private(set) var error: String?
    public private(set) var includeHidden = false
    public private(set) var canGoUp = false

    private let requester: any MachineDirectoryRequesting
    private let fallbackError: String
    private var machineId: String?
    @ObservationIgnored private var loadTask: Task<Void, Never>?
    @ObservationIgnored private var requestVersion = 0

    public init(
        requester: any MachineDirectoryRequesting,
        fallbackError: String = "Failed to browse directories"
    ) {
        self.requester = requester
        self.fallbackError = fallbackError
    }

    public func open(machineId: String, roots: [String], initialPath: String? = nil) {
        close()
        let usableRoots = unique(roots.filter {
            !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        })
        let selectedInitialPath = initialPath.flatMap { candidate in
            usableRoots.contains { RemoteDirectoryPath.isWithinRoot(path: candidate, root: $0) }
                ? candidate
                : nil
        }
        guard let path = selectedInitialPath ?? usableRoots.first else { return }
        self.machineId = machineId
        self.isPresented = true
        self.path = path
        self.roots = usableRoots
        load(path)
    }

    public func close() {
        loadTask?.cancel()
        requestVersion += 1
        machineId = nil
        isPresented = false
        path = ""
        roots = []
        breadcrumbs = []
        entries = []
        isLoading = false
        error = nil
        includeHidden = false
        canGoUp = false
    }

    public func navigate(to path: String) {
        guard isPresented,
              roots.contains(where: { RemoteDirectoryPath.isWithinRoot(path: path, root: $0) })
        else {
            return
        }
        load(path)
    }

    public func navigateEntry(_ name: String) {
        navigate(to: RemoteDirectoryPath.join(parent: path, child: name))
    }

    public func navigateUp() {
        guard let parent = RemoteDirectoryPath.parent(path),
              roots.contains(where: { RemoteDirectoryPath.isWithinRoot(path: parent, root: $0) })
        else {
            return
        }
        navigate(to: parent)
    }

    public func refresh() {
        load(path)
    }

    public func setIncludeHidden(_ includeHidden: Bool) {
        guard isPresented else { return }
        self.includeHidden = includeHidden
        load(path)
    }

    private func load(_ path: String) {
        guard let machineId,
              isPresented,
              roots.contains(where: { RemoteDirectoryPath.isWithinRoot(path: path, root: $0) })
        else {
            return
        }
        loadTask?.cancel()
        requestVersion += 1
        let currentRequest = requestVersion
        let requestedIncludeHidden = includeHidden
        let browseRoots = roots
        self.path = path
        entries = []
        isLoading = true
        error = nil
        breadcrumbs = makeBreadcrumbs(path: path, roots: browseRoots)
        canGoUp = RemoteDirectoryPath.parent(path).map { parent in
            browseRoots.contains { RemoteDirectoryPath.isWithinRoot(path: parent, root: $0) }
        } ?? false

        loadTask = Task { [weak self] in
            guard let self else { return }
            let response: MachineListDirectoryResponse
            do {
                response = try await self.requester.listMachineDirectory(
                    machineId: machineId,
                    path: path,
                    includeHidden: requestedIncludeHidden
                )
            } catch is CancellationError {
                return
            } catch {
                guard self.isCurrent(
                    currentRequest,
                    machineId: machineId,
                    path: path,
                    includeHidden: requestedIncludeHidden
                ) else {
                    return
                }
                self.isLoading = false
                self.error = (error as? LocalizedError)?.errorDescription ?? self.fallbackError
                return
            }
            guard self.isCurrent(
                currentRequest,
                machineId: machineId,
                path: path,
                includeHidden: requestedIncludeHidden
            ) else {
                return
            }
            guard response.success else {
                self.isLoading = false
                self.error = response.error ?? self.fallbackError
                return
            }
            self.isLoading = false
            self.entries = (response.entries ?? [])
                .filter { $0.type == .directory }
                .sorted {
                    $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
                }
        }
    }

    private func isCurrent(
        _ request: Int,
        machineId: String,
        path: String,
        includeHidden: Bool
    ) -> Bool {
        requestVersion == request
            && self.machineId == machineId
            && isPresented
            && self.path == path
            && self.includeHidden == includeHidden
    }

    private func makeBreadcrumbs(path: String, roots: [String]) -> [RemoteDirectoryBreadcrumb] {
        guard let root = roots
            .filter({ RemoteDirectoryPath.isWithinRoot(path: path, root: $0) })
            .max(by: { $0.count < $1.count })
        else {
            return [RemoteDirectoryBreadcrumb(label: path, path: path)]
        }
        var result = [RemoteDirectoryBreadcrumb(label: root, path: root)]
        let relative = String(path.dropFirst(root.count))
            .trimmingCharacters(in: CharacterSet(charactersIn: "/\\"))
        var cursor = root
        for segment in relative.split(whereSeparator: { $0 == "/" || $0 == "\\" }) {
            cursor = RemoteDirectoryPath.join(parent: cursor, child: String(segment))
            result.append(RemoteDirectoryBreadcrumb(label: String(segment), path: cursor))
        }
        return result
    }

    private func unique(_ values: [String]) -> [String] {
        var seen: Set<String> = []
        return values.filter { seen.insert($0).inserted }
    }
}

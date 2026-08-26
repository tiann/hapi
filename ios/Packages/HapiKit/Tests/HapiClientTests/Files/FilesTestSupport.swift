import Foundation
import HapiClient
import HapiProtocol

// Shared fakes/helpers of the files-feature model suites (A-M4a), mirroring
// the Android `FakeFilesGateway`.

struct DiffFileCall: Equatable, Sendable {
    var path: String
    var staged: Bool?
}

struct SearchCall: Equatable, Sendable {
    var query: String
    var limit: Int
}

/// A transport-level failure with a message, like the Android
/// `IllegalStateException("offline")` used by the reference tests.
struct FakeTransportError: Error, LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// Scripted `FilesRequesting` double: fixed responses per endpoint plus call
/// recording. An actor so the models' concurrent loads stay data-race free.
actor FakeFilesGateway: FilesRequesting {
    private var statusResult = GitCommandResponse(success: true, stdout: "")
    private var unstagedNumstat = GitCommandResponse(success: true, stdout: "")
    private var stagedNumstat = GitCommandResponse(success: true, stdout: "")
    private var diffFileResult = GitCommandResponse(success: true, stdout: "")
    private var readFileResult = FileReadResponse(success: true, content: "")
    private var searchResult = FileSearchResponse(success: true, files: [])
    /// Keyed by requested path; nil key = session root.
    private var directories: [String?: ListDirectoryResponse] = [:]
    private var statusError: (any Error)?

    private(set) var diffFileCalls: [DiffFileCall] = []
    private(set) var searchCalls: [SearchCall] = []
    private(set) var listDirectoryCalls: [String?] = []
    private(set) var numstatCalls: [Bool] = []

    // MARK: Scripting

    func setStatus(_ response: GitCommandResponse) { statusResult = response }
    func setUnstagedNumstat(_ response: GitCommandResponse) { unstagedNumstat = response }
    func setStagedNumstat(_ response: GitCommandResponse) { stagedNumstat = response }
    func setDiffFile(_ response: GitCommandResponse) { diffFileResult = response }
    func setReadFile(_ response: FileReadResponse) { readFileResult = response }
    func setSearch(_ response: FileSearchResponse) { searchResult = response }
    func setDirectory(_ path: String?, _ response: ListDirectoryResponse) { directories[path] = response }
    func setStatusError(_ error: any Error) { statusError = error }

    // MARK: FilesRequesting

    func gitStatus(sessionId: String) async throws -> GitCommandResponse {
        if let statusError { throw statusError }
        return statusResult
    }

    func gitDiffNumstat(sessionId: String, staged: Bool) async throws -> GitCommandResponse {
        numstatCalls.append(staged)
        return staged ? stagedNumstat : unstagedNumstat
    }

    func gitDiffFile(sessionId: String, path: String, staged: Bool?) async throws -> GitCommandResponse {
        diffFileCalls.append(DiffFileCall(path: path, staged: staged))
        return diffFileResult
    }

    func readSessionFile(sessionId: String, path: String) async throws -> FileReadResponse {
        readFileResult
    }

    func searchSessionFiles(sessionId: String, query: String, limit: Int) async throws -> FileSearchResponse {
        searchCalls.append(SearchCall(query: query, limit: limit))
        return searchResult
    }

    func listSessionDirectory(sessionId: String, path: String?) async throws -> ListDirectoryResponse {
        listDirectoryCalls.append(path)
        return directories[path] ?? ListDirectoryResponse(success: true, entries: [])
    }
}

/// Polls `condition` (10 ms cadence) until true or `timeout`; returns the
/// final verdict for `#expect` (same shape as the ChatInteractor suite's
/// helper; distinct name — `expectEventually`/`waitUntil` already exist in
/// this module with sync/@Sendable closures).
@MainActor
func filesEventually(
    timeout: Duration = .seconds(5),
    _ condition: @MainActor () async -> Bool
) async -> Bool {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: timeout)
    while clock.now < deadline {
        if await condition() { return true }
        try? await Task.sleep(for: .milliseconds(10))
    }
    return await condition()
}

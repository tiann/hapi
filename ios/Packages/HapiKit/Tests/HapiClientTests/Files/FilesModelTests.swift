import Foundation
import HapiClient
import HapiProtocol
import Testing

/// Transcription of the Android `FilesViewModelTest` suite against the real
/// `FilesModel` (only the gateway is faked). The Android suite runs on a
/// virtual-time dispatcher; here async settling is polled via
/// `filesEventually` and the debounce test uses a real (short) clock with
/// wide margins.
@Suite("FilesModel")
@MainActor
struct FilesModelTests {

    private func makeModel(
        _ gateway: FakeFilesGateway,
        searchDebounce: Duration = .milliseconds(200)
    ) -> FilesModel {
        FilesModel(sessionId: "s1", requester: gateway, searchDebounce: searchDebounce)
    }

    // MARK: - Changes

    private let porcelain = [
        "# branch.head main",
        "1 M. N... 100644 100644 100644 aaaaaaaa bbbbbbbb staged.txt",
        "1 .M N... 100644 100644 100644 cccccccc dddddddd unstaged.txt",
        "1 MM N... 100644 100644 100644 eeeeeeee ffffffff both.txt",
        "? fresh.txt",
    ].joined(separator: "\n")

    @Test func changesTabMergesStatusWithBothNumstatSides() async {
        let gateway = FakeFilesGateway()
        await gateway.setStatus(GitCommandResponse(success: true, stdout: porcelain))
        await gateway.setUnstagedNumstat(
            GitCommandResponse(success: true, stdout: "3\t1\tunstaged.txt\n2\t2\tboth.txt")
        )
        await gateway.setStagedNumstat(
            GitCommandResponse(success: true, stdout: "5\t0\tstaged.txt\n1\t0\tboth.txt")
        )
        let model = makeModel(gateway)
        model.start()

        #expect(await filesEventually { !model.changes.isLoading && model.changes.status != nil })
        let state = model.changes
        #expect(state.error == nil)
        let status = state.status
        #expect(status?.branch == "main")
        let numstatCalls = await gateway.numstatCalls
        #expect(numstatCalls.count == 2)
        #expect(Set(numstatCalls) == [false, true])

        // Staged side takes counts from the staged numstat.
        #expect(status?.stagedFiles.map(\.fullPath) == ["staged.txt", "both.txt"])
        #expect(status?.stagedFiles[0].linesAdded == 5)
        #expect(status?.stagedFiles[1].linesAdded == 1)

        // Unstaged side: modified + both + untracked appended last.
        #expect(status?.unstagedFiles.map(\.fullPath) == ["unstaged.txt", "both.txt", "fresh.txt"])
        #expect(status?.unstagedFiles[0].linesAdded == 3)
        #expect(status?.unstagedFiles[1].linesRemoved == 2)
        #expect(status?.unstagedFiles[2].status == .untracked)
    }

    @Test func statusFailureSurfacesErrorWithNoStatus() async {
        let gateway = FakeFilesGateway()
        await gateway.setStatus(GitCommandResponse(success: false, error: "Session path not available"))
        let model = makeModel(gateway)
        model.start()

        #expect(await filesEventually { !model.changes.isLoading })
        #expect(model.changes.status == nil)
        #expect(model.changes.error == "Session path not available")
        #expect(await gateway.numstatCalls.isEmpty)
    }

    @Test func numstatFailureDegradesToZeroCountsPlusBanner() async {
        let gateway = FakeFilesGateway()
        await gateway.setStatus(GitCommandResponse(success: true, stdout: porcelain))
        await gateway.setUnstagedNumstat(GitCommandResponse(success: false, stderr: "boom"))
        await gateway.setStagedNumstat(GitCommandResponse(success: true, stdout: "5\t0\tstaged.txt"))
        let model = makeModel(gateway)
        model.start()

        #expect(await filesEventually { !model.changes.isLoading && model.changes.status != nil })
        let status = model.changes.status
        #expect(status?.unstagedFiles[0].linesAdded == 0)
        #expect(status?.stagedFiles[0].linesAdded == 5)
        #expect(model.changes.error == "Unstaged diff unavailable: boom")
    }

    @Test func transportFailureOnStatusMapsToErrorState() async {
        let gateway = FakeFilesGateway()
        await gateway.setStatusError(FakeTransportError(message: "offline"))
        let model = makeModel(gateway)
        model.start()

        #expect(await filesEventually { !model.changes.isLoading })
        #expect(model.changes.status == nil)
        #expect(model.changes.error == "offline")
    }

    // MARK: - Browse

    private func dir(_ name: String) -> DirectoryEntry {
        DirectoryEntry(name: name, type: .directory)
    }

    private func file(_ name: String, size: Int? = nil) -> DirectoryEntry {
        DirectoryEntry(name: name, type: .file, size: size)
    }

    private func rowName(_ row: FilesModel.BrowseRow) -> String {
        switch row {
        case .directory(_, let name, _, _): name
        case .file(_, let name, _, _, _): name
        case .loading: "<loading>"
        case .failure: "<error>"
        }
    }

    @Test func rootListingSortsDirsFirstAndHidesDotEntriesByDefault() async {
        let gateway = FakeFilesGateway()
        await gateway.setDirectory(nil, ListDirectoryResponse(
            success: true,
            entries: [
                file("zeta.txt"),
                dir("src"),
                file(".env"),
                dir(".git"),
                file("Alpha.md"),
                DirectoryEntry(name: "weird-socket", type: .other),
            ]
        ))
        let model = makeModel(gateway)
        model.start()

        #expect(await filesEventually {
            model.browse.rows.map { self.rowName($0) } == ["src", "Alpha.md", "zeta.txt"]
        })
        if case .directory = model.browse.rows[0] {} else {
            Issue.record("first row should be the directory")
        }

        model.setShowHidden(true)
        #expect(model.browse.rows.map { self.rowName($0) } == [".git", "src", ".env", "Alpha.md", "zeta.txt"])
    }

    @Test func expandingADirectoryLazilyLoadsItExactlyOnce() async {
        let gateway = FakeFilesGateway()
        await gateway.setDirectory(nil, ListDirectoryResponse(success: true, entries: [dir("src")]))
        await gateway.setDirectory("src", ListDirectoryResponse(
            success: true,
            entries: [file("app.ts", size: 10)]
        ))
        let model = makeModel(gateway)
        model.start()
        #expect(await filesEventually { model.browse.rows.map { self.rowName($0) } == ["src"] })

        model.toggleDirectory(path: "src")
        #expect(await filesEventually {
            model.browse.rows.map { self.rowName($0) } == ["src", "app.ts"]
        })
        guard case .file(let path, _, let depth, let size, _) = model.browse.rows[1] else {
            Issue.record("expected a file row")
            return
        }
        #expect(depth == 1)
        #expect(path == "src/app.ts")
        #expect(size == 10)

        // Collapse and re-expand: entries come from the cache, no second call.
        model.toggleDirectory(path: "src")
        model.toggleDirectory(path: "src")
        #expect(model.browse.rows.map { self.rowName($0) } == ["src", "app.ts"])
        #expect(await gateway.listDirectoryCalls == [nil, "src"])
    }

    @Test func directoryFailureRendersAnInlineErrorRow() async {
        let gateway = FakeFilesGateway()
        await gateway.setDirectory(nil, ListDirectoryResponse(success: false, error: "denied"))
        let model = makeModel(gateway)
        model.start()

        #expect(await filesEventually {
            if case .failure(_, _, let message) = model.browse.rows.first { return message == "denied" }
            return false
        })
        #expect(model.browse.rows.count == 1)
    }

    // MARK: - Search

    @Test func searchDebouncesRapidTypingIntoASingleRequest() async {
        let gateway = FakeFilesGateway()
        await gateway.setSearch(FileSearchResponse(
            success: true,
            files: [
                FileSearchItem(fileName: "app.ts", filePath: "src", fullPath: "src/app.ts", fileType: "file"),
            ]
        ))
        // Wide margin: 50 ms keystroke gaps against a 400 ms debounce.
        let model = makeModel(gateway, searchDebounce: .milliseconds(400))
        model.start()

        model.setSearchQuery("a")
        try? await Task.sleep(for: .milliseconds(50))
        model.setSearchQuery("ap")
        try? await Task.sleep(for: .milliseconds(50))
        model.setSearchQuery("app")

        #expect(await filesEventually { model.search.hasSearched })
        #expect(await gateway.searchCalls == [SearchCall(query: "app", limit: 200)])
        #expect(model.search.query == "app")
        #expect(model.search.results.map(\.fullPath) == ["src/app.ts"])
    }

    @Test func clearingTheQueryResetsResultsWithoutARequest() async {
        let gateway = FakeFilesGateway()
        let model = makeModel(gateway, searchDebounce: .milliseconds(20))
        model.start()

        model.setSearchQuery("app")
        #expect(await filesEventually { await gateway.searchCalls.count == 1 })

        model.setSearchQuery("")
        try? await Task.sleep(for: .milliseconds(80))
        #expect(await gateway.searchCalls.count == 1)
        #expect(model.search.results.isEmpty)
        #expect(model.search.hasSearched == false)
    }

    @Test func searchFailureSurfacesTheError() async {
        let gateway = FakeFilesGateway()
        await gateway.setSearch(FileSearchResponse(success: false, error: "ripgrep missing"))
        let model = makeModel(gateway, searchDebounce: .milliseconds(20))
        model.start()

        model.setSearchQuery("x")
        #expect(await filesEventually { model.search.hasSearched })

        #expect(model.search.error == "ripgrep missing")
        #expect(model.search.results.isEmpty)
    }
}

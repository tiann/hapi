import Foundation
import HapiClient
import HapiProtocol
import Testing

private struct DirectoryBrowserCall: Equatable, Sendable {
    let machineId: String
    let path: String
    let includeHidden: Bool
}

private actor FakeMachineDirectoryRequester: MachineDirectoryRequesting {
    private(set) var calls: [DirectoryBrowserCall] = []

    func listMachineDirectory(
        machineId: String,
        path: String,
        includeHidden: Bool
    ) async throws -> MachineListDirectoryResponse {
        calls.append(DirectoryBrowserCall(
            machineId: machineId,
            path: path,
            includeHidden: includeHidden
        ))
        return MachineListDirectoryResponse(
            success: true,
            entries: [
                MachineDirectoryEntry(name: "repo", type: .directory),
                MachineDirectoryEntry(name: "README.md", type: .file),
            ]
        )
    }
}

@MainActor
private func directoryBrowserEventually(
    timeout: Duration = .seconds(5),
    _ condition: @MainActor () -> Bool
) async -> Bool {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: timeout)
    while clock.now < deadline {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(10))
    }
    return condition()
}

@Suite("RemoteDirectoryBrowserModel")
@MainActor
struct RemoteDirectoryBrowserModelTests {
    @Test func defaultDirectoryIsIndependentOfBrowseBoundaries() {
        var machine = Machine(
            id: "m", namespace: "test", seq: 1, createdAt: 0, updatedAt: 0,
            active: true, activeAt: 0,
            metadata: MachineMetadata(host: "m", platform: "linux", happyCliVersion: "test", homeDir: "/home/dev"),
            metadataVersion: 1, runnerStateVersion: 0
        )
        #expect(RemoteDirectoryPath.browseRoots(for: machine).isEmpty)
        #expect(RemoteDirectoryPath.defaultDirectory(for: machine) == "/home/dev")
        machine.metadata?.workspaceRoots = ["/data", "/work"]
        #expect(RemoteDirectoryPath.browseRoots(for: machine) == ["/data", "/work"])
        #expect(RemoteDirectoryPath.defaultDirectory(for: machine) == "/data")
        #expect(RemoteDirectoryPath.expandHome("~/repo", homeDirectory: "/remote/home") == "/remote/home/repo")
        #expect(RemoteDirectoryPath.expandHome("~", homeDirectory: "/remote/home") == "/remote/home")
        #expect(RemoteDirectoryPath.expandHome("~\\repo", homeDirectory: "D:\\Users\\dev") == "D:\\Users\\dev\\repo")
        #expect(RemoteDirectoryPath.filesystemRoot("D:\\Users\\dev") == "D:\\")
        #expect(RemoteDirectoryPath.filesystemRoot("\\\\server\\share\\repo") == "\\\\server\\share")
        #expect(!RemoteDirectoryPath.allowsBrowsing(path: "relative/path", roots: []))
    }

    @Test func unrestrictedBrowserPreservesExternalInputAndNavigatesAboveHome() async {
        let requester = FakeMachineDirectoryRequester()
        let model = RemoteDirectoryBrowserModel(requester: requester)
        model.open(machineId: "m", roots: [], initialPath: "/data/github/hapi", defaultPath: "/home/dev")
        #expect(await directoryBrowserEventually { !model.isLoading })
        #expect(model.path == "/data/github/hapi")
        #expect(model.breadcrumbs.map(\.path) == ["/", "/data", "/data/github", "/data/github/hapi"])
        model.navigate(to: "/home/dev")
        model.navigateUp()
        #expect(await directoryBrowserEventually { !model.isLoading })
        #expect(model.path == "/home")
        model.navigate(to: "/")
        #expect(await directoryBrowserEventually { !model.isLoading })
        #expect(!model.canGoUp)
        model.open(machineId: "m", roots: [], initialPath: "", defaultPath: "/home/dev")
        #expect(model.path == "/home/dev")
        model.close()
    }

    @Test func configuredRootsRemainBoundariesAndSupportSwitchingRoots() async {
        let requester = FakeMachineDirectoryRequester()
        let model = RemoteDirectoryBrowserModel(requester: requester)
        model.open(machineId: "m", roots: ["/data", "/work"], initialPath: "/home/dev", defaultPath: "/home/dev")
        #expect(await directoryBrowserEventually { !model.isLoading })
        #expect(model.path == "/data")
        #expect(!model.canGoUp)
        model.navigate(to: "/work/repo")
        #expect(await directoryBrowserEventually { !model.isLoading })
        #expect(model.breadcrumbs.map(\.path) == ["/work", "/work/repo"])
        model.navigateUp()
        #expect(await directoryBrowserEventually { !model.isLoading })
        #expect(model.path == "/work")
        #expect(!model.canGoUp)
        model.close()
    }

    @Test func pathBoundariesSupportPosixDriveAndUNCPaths() {
        #expect(RemoteDirectoryPath.isWithinRoot(path: "/workspace/repo", root: "/workspace"))
        #expect(!RemoteDirectoryPath.isWithinRoot(path: "/workspace-other/repo", root: "/workspace"))
        #expect(RemoteDirectoryPath.isWithinRoot(path: "/workspace", root: "/"))
        #expect(RemoteDirectoryPath.isWithinRoot(path: "c:\\Work\\Repo", root: "C:\\work"))
        #expect(!RemoteDirectoryPath.isWithinRoot(
            path: "C:\\workspace-other",
            root: "C:\\workspace"
        ))
        #expect(RemoteDirectoryPath.isWithinRoot(
            path: "\\\\SERVER\\Share\\Repo",
            root: "\\\\server\\share"
        ))
        #expect(RemoteDirectoryPath.parent("C:\\Users") == "C:\\")
        #expect(
            RemoteDirectoryPath.parent("\\\\server\\share\\repo")
                == "\\\\server\\share"
        )
    }

    @Test func modelOwnsNavigationLoadingAndHiddenDirectoryState() async {
        let requester = FakeMachineDirectoryRequester()
        let model = RemoteDirectoryBrowserModel(requester: requester)

        model.open(machineId: "machine-1", roots: ["/workspace"], initialPath: "/workspace")
        #expect(await directoryBrowserEventually { !model.isLoading })
        #expect(model.entries.map(\.name) == ["repo"])

        model.navigate(to: "/workspace-other")
        try? await Task.sleep(for: .milliseconds(20))
        #expect(await requester.calls.count == 1)

        model.navigateEntry("repo")
        #expect(await directoryBrowserEventually { !model.isLoading && model.path == "/workspace/repo" })
        #expect(model.canGoUp)

        model.setIncludeHidden(true)
        #expect(await directoryBrowserEventually { !model.isLoading })
        #expect(await requester.calls.last?.includeHidden == true)

        model.navigateUp()
        #expect(await directoryBrowserEventually { !model.isLoading && model.path == "/workspace" })

        model.close()
        #expect(!model.isPresented)
    }
}

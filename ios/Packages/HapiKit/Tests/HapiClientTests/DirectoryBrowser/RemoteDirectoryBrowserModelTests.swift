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

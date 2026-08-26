import Foundation
import HapiClient
import HapiProtocol
import Testing

/// Transcription of the Android `FileViewerViewModelTest` suite against the
/// real `FileViewerModel` (only the gateway is faked). One adaptation: on
/// iOS the unified-diff *parser* lives in HapiUI, so `DiffState.ready`
/// carries the raw stdout judged through the injected `hasRenderableDiff`
/// probe (parse-level assertions are covered by `HapiUITests/DiffModelTests`);
/// these tests use the default non-empty probe.
@Suite("FileViewerModel")
@MainActor
struct FileViewerModelTests {

    private func makeModel(
        _ gateway: FakeFilesGateway,
        path: String = "src/app.ts",
        staged: Bool? = nil,
        mode: FileViewerModel.Mode? = nil,
        line: Int? = nil
    ) -> FileViewerModel {
        FileViewerModel(
            sessionId: "s1",
            path: path,
            initialStaged: staged,
            initialMode: mode,
            focusLine: line,
            requester: gateway
        )
    }

    private func b64(_ text: String) -> String {
        Data(text.utf8).base64EncodedString()
    }

    private let sampleDiff = """
    diff --git a/src/app.ts b/src/app.ts
    --- a/src/app.ts
    +++ b/src/app.ts
    @@ -1,2 +1,2 @@
     keep
    -old
    +new
    """

    private func settled(_ model: FileViewerModel) async -> Bool {
        await filesEventually { model.diff != .loading && model.content != .loading }
    }

    @Test func parsesTheDiffAndStaysInDiffMode() async {
        let gateway = FakeFilesGateway()
        await gateway.setDiffFile(GitCommandResponse(success: true, stdout: sampleDiff))
        await gateway.setReadFile(FileReadResponse(success: true, content: b64("keep\nnew\n")))
        let model = makeModel(gateway)
        model.start()

        #expect(await settled(model))
        #expect(model.mode == .diff)
        #expect(model.diff == .ready(unifiedDiff: sampleDiff))
        #expect(await gateway.diffFileCalls == [DiffFileCall(path: "src/app.ts", staged: false)])
    }

    @Test func emptyDiffAutoFallsBackToFileMode() async {
        let gateway = FakeFilesGateway()
        await gateway.setDiffFile(GitCommandResponse(success: true, stdout: ""))
        await gateway.setReadFile(FileReadResponse(success: true, content: b64("hello")))
        let model = makeModel(gateway)
        model.start()

        #expect(await settled(model))
        #expect(model.mode == .file)
        #expect(model.diff == .empty)
        #expect(model.content == .text("hello", language: "ts", isMarkdown: false))
    }

    @Test func failedDiffAutoFallsBackToFileModeWithMessageKept() async {
        let gateway = FakeFilesGateway()
        await gateway.setDiffFile(GitCommandResponse(success: false, error: "not a repo"))
        await gateway.setReadFile(FileReadResponse(success: true, content: b64("x")))
        let model = makeModel(gateway)
        model.start()

        #expect(await settled(model))
        #expect(model.mode == .file)
        #expect(model.diff == .failed("not a repo"))
    }

    @Test func explicitFileModeFromTheRouteDisablesAutoBehavior() async {
        let gateway = FakeFilesGateway()
        await gateway.setDiffFile(GitCommandResponse(success: true, stdout: sampleDiff))
        await gateway.setReadFile(FileReadResponse(success: true, content: b64("body")))
        let model = makeModel(gateway, mode: .file, line: 12)
        model.start()

        #expect(await settled(model))
        #expect(model.mode == .file)
        #expect(model.focusLine == 12)
        // The diff still loaded, so the user can flip to it.
        #expect(model.diff == .ready(unifiedDiff: sampleDiff))
    }

    @Test func stagedToggleReloadsTheDiffForTheOtherSide() async {
        let gateway = FakeFilesGateway()
        await gateway.setDiffFile(GitCommandResponse(success: true, stdout: sampleDiff))
        await gateway.setReadFile(FileReadResponse(success: true, content: b64("x")))
        let model = makeModel(gateway, staged: false)
        model.start()
        #expect(await settled(model))

        model.setStaged(true)
        #expect(await filesEventually { await gateway.diffFileCalls.count == 2 })

        #expect(await gateway.diffFileCalls == [
            DiffFileCall(path: "src/app.ts", staged: false),
            DiffFileCall(path: "src/app.ts", staged: true),
        ])
        #expect(model.staged)

        // Same side again is a no-op.
        model.setStaged(true)
        try? await Task.sleep(for: .milliseconds(50))
        #expect(await gateway.diffFileCalls.count == 2)
    }

    @Test func markdownFilesFlagMarkdownAndDefaultToPreview() async {
        let gateway = FakeFilesGateway()
        await gateway.setDiffFile(GitCommandResponse(success: true, stdout: ""))
        await gateway.setReadFile(FileReadResponse(success: true, content: b64("# Title"), size: 7, modified: 123))
        let model = makeModel(gateway, path: "README.md")
        model.start()

        #expect(await settled(model))
        #expect(model.content == .text("# Title", language: "md", isMarkdown: true))
        #expect(model.markdownPreview)
        #expect(model.sizeBytes == 7)
        #expect(model.modifiedAt == 123)

        model.setMarkdownPreview(false)
        #expect(model.markdownPreview == false)
    }

    @Test func imageExtensionsDecodeToImageContent() async {
        let bytes = Data([1, 2, 3, 4])
        let gateway = FakeFilesGateway()
        await gateway.setDiffFile(GitCommandResponse(success: true, stdout: ""))
        await gateway.setReadFile(FileReadResponse(success: true, content: bytes.base64EncodedString()))
        let model = makeModel(gateway, path: "assets/logo.PNG")
        model.start()

        #expect(await settled(model))
        #expect(model.content == .image(data: bytes, mimeType: "image/png"))
        #expect(model.mode == .file)
    }

    @Test func nulBytesClassifyAsBinary() async {
        let gateway = FakeFilesGateway()
        await gateway.setDiffFile(GitCommandResponse(success: true, stdout: ""))
        await gateway.setReadFile(FileReadResponse(
            success: true,
            content: Data([104, 105, 0, 106]).base64EncodedString()
        ))
        let model = makeModel(gateway, path: "blob.bin")
        model.start()

        #expect(await settled(model))
        #expect(model.content == .binary)
    }

    @Test func readFailureSurfacesItsMessage() async {
        let gateway = FakeFilesGateway()
        await gateway.setDiffFile(GitCommandResponse(success: true, stdout: ""))
        await gateway.setReadFile(FileReadResponse(success: false, error: "File not found"))
        let model = makeModel(gateway)
        model.start()

        #expect(await settled(model))
        #expect(model.content == .failed("File not found"))
    }

    @Test func invalidBase64ClassifiesAsBinary() async {
        let gateway = FakeFilesGateway()
        await gateway.setDiffFile(GitCommandResponse(success: true, stdout: ""))
        await gateway.setReadFile(FileReadResponse(success: true, content: "%%%not-base64%%%"))
        let model = makeModel(gateway)
        model.start()

        #expect(await settled(model))
        #expect(model.content == .binary)
    }
}

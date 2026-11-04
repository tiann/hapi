import HapiClient
import HapiProtocol
import HapiUI
import Observation
import SwiftUI
import UIKit
import UniformTypeIdentifiers
import XCTest
@testable import Hapi

/// App-hosted platform coverage. The optional interactive test uses the real
/// composer and system pickers; HAPI_ATTACHMENT_TEST_URL opts into a disposable
/// loopback upload fixture, never a saved hub or the user's Keychain.
@MainActor
final class AttachmentUploadPresentationTests: XCTestCase {
    private actor FixtureHTTP: HTTPPerforming {
        var attempts = 0
        private var resumed: Set<String> = []
        private var resumeWaiter: CheckedContinuation<Void, Never>?
        private let gateResume: Bool
        private let target: String?
        private let resumeStatus: Int
        private(set) var resumeStarted = false
        private(set) var uploadSessions: [String] = []

        init(gateResume: Bool = false, target: String? = nil, resumeStatus: Int = 200) {
            self.gateResume = gateResume
            self.target = target
            self.resumeStatus = resumeStatus
        }

        func openResumeGate() { resumeWaiter?.resume(); resumeWaiter = nil }

        func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
            let path = request.url!.path
            let id = path.split(separator: "/").dropFirst(2).first.map(String.init) ?? ""
            if path.hasSuffix("/upload") { attempts += 1; uploadSessions.append(id) }
            let status: Int
            let body: String
            if path.hasSuffix("/resume") {
                resumeStarted = true
                if gateResume { await withCheckedContinuation { resumeWaiter = $0 } }
                status = resumeStatus
                resumed.insert(id)
                body = status == 200 ? "{\"sessionId\":\"\(target ?? id)\"}" : #"{"error":"Machine offline"}"#
            } else if path.hasSuffix("/upload"), id.hasSuffix("-inactive"), !resumed.contains(id) {
                status = 409
                body = #"{"error":"Session is inactive","code":"session_inactive"}"#
            } else if path.contains("-retry/"), attempts == 1 {
                status = 500
                body = #"{"success":false,"error":"Fixture upload failure — retry should succeed"}"#
            } else {
                status = 200
                body = path == "/api/sessions" ? #"{"sessions":[]}"# : path.hasSuffix("/upload")
                    ? #"{"success":true,"path":"/fixture/uploaded"}"#
                    : #"{"success":true}"#
            }
            return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status,
                httpVersion: nil, headerFields: ["Content-Type": "application/json"])!)
        }
    }

    private func interactor(suffix: String) throws -> ChatInteractor {
        let fixtureURL = ProcessInfo.processInfo.environment["HAPI_ATTACHMENT_TEST_URL"]
        let url = try XCTUnwrap(URL(string: fixtureURL ?? "https://attachment-fixture.invalid"))
        let performer: any HTTPPerforming = fixtureURL == nil ? FixtureHTTP() : URLSessionHTTPPerformer.shared
        let credentials = InMemoryCredentialStore()
        let payload = Data(#"{"uid":1,"exp":4102444800,"ns":"attachment-fixture"}"#.utf8).base64EncodedString()
        try credentials.store(HubCredentials(hubUrl: url.absoluteString, accessToken: "fixture-only",
            jwt: "e30.\(payload).fixture"))
        let auth = AuthManager(baseURL: url, credentialStore: credentials, performer: performer)
        let api = APIClient(baseURL: url, authManager: auth, performer: performer)
        return ChatInteractor(sessionId: "attachment-\(UUID().uuidString)-\(suffix)", api: api,
            sessionStore: SessionListStore(api: api), windows: MessageWindowControllers(provider: api))
    }

    private func wait(_ condition: () -> Bool) async throws {
        for _ in 0..<500 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("Timed out waiting for upload")
    }

    func testFilePreparationAndCameraDelegateJPEGUpload() async throws {
        let interactor = try interactor(suffix: "success")
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("probe-\(UUID().uuidString).txt")
        let content = Data("HAPI simulator attachment probe\n".utf8)
        try content.write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        guard case .ready(let preparedFile) = await AttachmentPreparer.prepare(fileURL: file) else {
            return XCTFail("File preparation failed")
        }
        XCTAssertEqual(preparedFile.bytes, content)
        interactor.attachments.add(preparedFile)

        var captured: Data?
        var dismissed = false
        let coordinator = CameraCaptureView.Coordinator(onCapture: { captured = $0 }, dismiss: { dismissed = true })
        let image = UIGraphicsImageRenderer(size: CGSize(width: 32, height: 32)).image { context in
            UIColor.orange.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 32, height: 32))
        }
        coordinator.imagePickerController(UIImagePickerController(), didFinishPickingMediaWithInfo: [.originalImage: image])
        XCTAssertTrue(dismissed)
        let jpeg = try XCTUnwrap(captured)
        guard case .ready(let preparedPhoto) = await AttachmentPreparer.prepare(data: jpeg,
            filename: AttachmentPreparer.cameraFilename(), mimeType: "image/jpeg") else {
            return XCTFail("Camera JPEG preparation failed")
        }
        XCTAssertNotNil(preparedPhoto.previewBytes)
        interactor.attachments.add(preparedPhoto)
        try await wait { !interactor.attachments.hasUnsettled }
        XCTAssertEqual(interactor.attachments.items.count, 2)
        XCTAssertTrue(interactor.attachments.allReady)
    }

    func testUploadFailureKeepsReasonAndRetrySucceeds() async throws {
        let interactor = try interactor(suffix: "retry")
        interactor.attachments.add(PreparedAttachment(filename: "retry-probe.txt", mimeType: "text/plain", bytes: Data("probe".utf8)))
        try await wait { interactor.attachments.items.first?.status == .failed }
        XCTAssertEqual(interactor.attachments.items.first?.errorMessage, "HTTP 500 (Fixture upload failure — retry should succeed)")
        let id = try XCTUnwrap(interactor.attachments.items.first?.id)
        interactor.attachments.retry(id)
        XCTAssertNil(interactor.attachments.items.first?.errorMessage)
        try await wait { interactor.attachments.allReady }
    }

    func testInactiveSessionResumesAndUploadsWithoutPermissionChanges() async throws {
        let interactor = try interactor(suffix: "inactive")
        interactor.attachments.add(PreparedAttachment(filename: "inactive-probe.txt", mimeType: "text/plain", bytes: Data("probe".utf8)))
        try await wait { interactor.attachments.allReady }
        XCTAssertNil(interactor.attachments.items.first?.errorMessage)
    }

    private func recoveryHub(performer: FixtureHTTP) throws -> HubSession {
        let url = "https://attachment-\(UUID().uuidString.lowercased()).invalid"
        let credentials = InMemoryCredentialStore()
        let payload = Data(#"{"uid":1,"exp":4102444800,"ns":"attachment-fixture"}"#.utf8).base64EncodedString()
        try credentials.store(HubCredentials(hubUrl: url, accessToken: "fixture-only", jwt: "e30.\(payload).fixture"))
        return try XCTUnwrap(HubSession(hubUrl: url, credentialStore: credentials, performer: performer))
    }

    private func waitForResume(_ performer: FixtureHTTP) async throws {
        for _ in 0..<500 {
            if await performer.resumeStarted { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("Timed out waiting for resume")
    }

    func testReplacementSessionKeepsComposerAndDefersMergedSourceRemoval() async throws {
        let performer = FixtureHTTP(gateResume: true, target: "replacement")
        let hub = try recoveryHub(performer: performer)
        defer { hub.shutdown() }
        let original = hub.makeChatInteractor(sessionId: "source-inactive")
        original.setComposerText("Keep my draft")
        var target: String?
        original.onEvent = { if case .sessionSuperseded(let id) = $0 { target = id } }
        original.attachments.add(PreparedAttachment(filename: "probe.txt", mimeType: "text/plain", bytes: Data("probe".utf8)))
        try await waitForResume(performer)
        // The Hub can publish this SSE event before /resume returns.
        hub.sessionStore.onSessionRemoved?(original.sessionId)
        XCTAssertNil(hub.sessionRemoval)
        original.setComposerText("Keep my latest typing")
        await performer.openResumeGate()
        try await wait { target == "replacement" && original.attachments.allReady }
        // Also tolerate source removal arriving after the HTTP response but
        // before SwiftUI has constructed the replacement screen.
        hub.sessionStore.onSessionRemoved?(original.sessionId)
        XCTAssertNil(hub.sessionRemoval)
        original.setComposerText("Typing while navigation is pending")
        let replacement = hub.makeChatInteractor(sessionId: try XCTUnwrap(target))
        XCTAssertTrue(replacement.attachments === original.attachments)
        XCTAssertEqual(replacement.composerText, "Typing while navigation is pending")
        XCTAssertEqual(replacement.attachments.items.count, 1)
        let uploadSessions = await performer.uploadSessions
        XCTAssertEqual(uploadSessions, ["source-inactive", "replacement"])
        replacement.sendMessage()
        try await wait { !replacement.isSending }
        try await Task.sleep(for: .milliseconds(400))
        // The source's pending debounce must not restore the sent draft.
        XCTAssertNil(UserDefaultsChatDrafts(scope: hub.hubUrl).load(sessionId: "replacement"))
    }

    func testFailedResumeReleasesDeferredRemoval() async throws {
        let performer = FixtureHTTP(gateResume: true, resumeStatus: 503)
        let hub = try recoveryHub(performer: performer)
        defer { hub.shutdown() }
        let original = hub.makeChatInteractor(sessionId: "source-inactive")
        original.attachments.add(PreparedAttachment(filename: "probe.txt", mimeType: "text/plain", bytes: Data("probe".utf8)))
        try await waitForResume(performer)
        hub.sessionStore.onSessionRemoved?(original.sessionId)
        XCTAssertNil(hub.sessionRemoval)
        await performer.openResumeGate()
        try await wait { original.attachments.items.first?.status == .failed }
        XCTAssertEqual(hub.sessionRemoval?.sessionId, original.sessionId)
        XCTAssertEqual(original.attachments.items.first?.errorMessage, "HTTP 503 (Machine offline)")
    }

    @Observable fileprivate final class Driver {
        let interactor: ChatInteractor
        var notice = "Choose a photo and a text file using +."
        var finished = false
        init(interactor: ChatInteractor) { self.interactor = interactor }
    }

    private struct ProbeDocument: FileDocument {
        static var readableContentTypes: [UTType] { [.plainText] }
        init() {}
        init(configuration: ReadConfiguration) throws {}
        func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
            FileWrapper(regularFileWithContents: Data("HAPI simulator file-picker probe\n".utf8))
        }
    }

    private struct PickerHarness: View {
        let driver: Driver
        @State private var exporting = false
        var body: some View {
            NavigationStack {
                VStack(spacing: 16) {
                    Text("Disposable upload fixture — no live conversation")
                    Text(driver.notice)
                    Button("Create test file in Files") { exporting = true }
                    Text("Tap + to check available attachment sources.")
                    Button("Finish verification") { driver.finished = true }
                    Spacer()
                }
                .padding()
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    ChatComposerView(interactor: driver.interactor)
                }
                .navigationTitle("Attachment verification")
                .navigationBarTitleDisplayMode(.inline)
                .fileExporter(isPresented: $exporting, document: ProbeDocument(), contentType: .plainText,
                    defaultFilename: "attachment-probe") { _ in }
            }
            .hapiTypography()
        }
    }

    private func capture(_ window: UIWindow, name: String) throws {
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(name).png")
        try XCTUnwrap(image.pngData()).write(to: url)
        let attachment = XCTAttachment(image: image)
        attachment.lifetime = .keepAlways
        attachment.name = name
        add(attachment)
        print("ATTACHMENT_CAPTURE=\(url.path)")
    }

    func testInteractiveFailureDetailsAndAvailableCamera() async throws {
        let env = ProcessInfo.processInfo.environment
        try XCTSkipUnless(env["HAPI_ATTACHMENT_TEST_URL"] != nil && env["HAPI_ATTACHMENT_INTERACTIVE"] == "1",
            "Opt-in manual error-details and camera presentation check")
        let driver = Driver(interactor: try interactor(suffix: "retry"))
        driver.notice = "Open the failed attachment's Details, retry, and check Camera using +. Then finish."
        driver.interactor.attachments.add(PreparedAttachment(filename: "retry-details.txt", mimeType: "text/plain", bytes: Data("probe".utf8)))
        try await wait { driver.interactor.attachments.items.first?.status == .failed }
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        let host = UIHostingController(rootView: PickerHarness(driver: driver))
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        print("ATTACHMENT_DETAILS_READY cameraAvailable=\(CameraCaptureView.isAvailable)")
        var inspectedFailure = false
        for _ in 0..<4800 {
            if !inspectedFailure, driver.interactor.attachments.items.first?.status == .failed {
                var presented = host.presentedViewController
                while let controller = presented {
                    if controller is UIAlertController {
                        inspectedFailure = true
                        try await Task.sleep(for: .milliseconds(400))
                        try capture(window, name: "attachment-failure-details")
                        break
                    }
                    presented = controller.presentedViewController
                }
            }
            if driver.finished {
                XCTAssertTrue(inspectedFailure, "Details must present without triggering a retry")
                XCTAssertTrue(driver.interactor.attachments.allReady)
                try capture(window, name: "attachment-retry-ready")
                return
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTFail("Interactive failure-details check timed out")
    }

    func testInteractiveSystemPickersOverHTTP() async throws {
        let env = ProcessInfo.processInfo.environment
        try XCTSkipUnless(env["HAPI_ATTACHMENT_TEST_URL"] != nil && env["HAPI_ATTACHMENT_INTERACTIVE"] == "1",
            "Opt-in manual system-picker check against a disposable upload fixture")
        let driver = Driver(interactor: try interactor(suffix: "picker"))
        driver.interactor.onEvent = { [weak driver] in
            if case .notice(let message) = $0 { driver?.notice = message }
        }
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        let host = UIHostingController(rootView: PickerHarness(driver: driver))
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        print("ATTACHMENT_PICKER_READY")
        var previous = ""
        for _ in 0..<4800 {
            let items = driver.interactor.attachments.items
            let summary = items.map { "\($0.filename):\($0.status):\($0.errorMessage ?? "")" }.joined(separator: " | ")
            if summary != previous { print("ATTACHMENT_PICKER_STATE=\(summary)"); previous = summary }
            if items.contains(where: { $0.mimeType.hasPrefix("image/") }),
               items.contains(where: { $0.filename.hasSuffix(".txt") }), driver.interactor.attachments.allReady {
                print("ATTACHMENT_PICKERS_SUCCEEDED")
                try await Task.sleep(for: .seconds(20))
                return
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTFail("Photo and file pickers did not both upload successfully: \(previous)")
    }
}

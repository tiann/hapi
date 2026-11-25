import HapiClient
import HapiUI
import Observation
import SwiftUI
import UIKit
import XCTest
@testable import Hapi
@testable import HapiProtocol

@MainActor
final class LongMessageLayoutTests: XCTestCase {
    @Observable @MainActor
    final class Driver {
        var showBubble = true
        @ObservationIgnored var open: ((UserTextBlock) -> Void)?
    }

    private struct ActionProbe: UIViewRepresentable {
        let driver: Driver
        func makeUIView(context: Context) -> UIView { UIView() }
        func updateUIView(_ view: UIView, context: Context) {
            driver.open = context.environment.openChatMessage
        }
    }

    private struct Harness: View {
        let driver: Driver
        let model: ChatModel
        let block: UserTextBlock
        var body: some View {
            Group {
                if driver.showBubble { UserTextBlockView(block: block) }
                else { Text("Row trimmed") }
            }
            .background(ActionProbe(driver: driver).frame(width: 0, height: 0))
            .modifier(MessagePresentationHost(model: model, owner: "chat"))
            .hapiTypography()
        }
    }

    private func block(_ text: String) -> UserTextBlock {
        UserTextBlock(id: "long-log", localId: nil, createdAt: 0, invokedAt: nil, text: text,
                      attachments: nil, status: nil, originalText: nil, meta: nil)
    }

    private var log: String {
        String(repeating: "2026-09-11T06:14:36.6177640Z CompileSwift /workspace/Hapi/ChatView.swift: error: actor isolation\n", count: 3_000)
    }

    func testLongLogRowStaysBoundedWhenRecreatedAndAtAccessibilitySizes() {
        for (width, size): (CGFloat, DynamicTypeSize) in [(320, .large), (390, .accessibility3)] {
            func measure(_ source: String) -> CGFloat {
                let host = UIHostingController(rootView: UserTextBlockView(block: block(source))
                    .hapiTypography().environment(\.dynamicTypeSize, size))
                return host.sizeThatFits(in: CGSize(width: width, height: CGFloat.greatestFiniteMagnitude)).height
            }
            let height = measure(log)
            XCTAssertGreaterThan(height, 100, "The actual preview and full-message affordance must render")
            XCTAssertLessThan(height, 1_800, "Even the accessibility-sized preview must stay bounded")
            XCTAssertEqual(measure(log + log), height, accuracy: 1,
                           "Recycling/longer payloads must not reintroduce unbounded layout")
        }
    }

    func testNormalMultiScreenPromptIsNotLineLimited() {
        let source = Array(repeating: "A normal prompt line.", count: 80).joined(separator: "\n")
        let host = UIHostingController(rootView: UserTextBlockView(block: block(source))
            .hapiTypography().environment(\.dynamicTypeSize, .large))
        let height = host.sizeThatFits(in: CGSize(width: 390, height: CGFloat.greatestFiniteMagnitude)).height
        XCTAssertGreaterThan(height, 1_400, "All 80 lines must render, not just the folded preview")
    }

    func testFullMessageSheetSurvivesItsBubbleBeingRemoved() async throws {
        let credentials = InMemoryCredentialStore()
        let hubURL = "http://127.0.0.1:1/long-message-\(UUID().uuidString)"
        let payload = Data(#"{"uid":1,"exp":4102444800,"ns":"test"}"#.utf8).base64EncodedString()
        try credentials.store(HubCredentials(hubUrl: "http://127.0.0.1:1", accessToken: "test", jwt: "e30.\(payload).test"))
        let hub = try XCTUnwrap(HubSession(hubUrl: hubURL, credentialStore: credentials, performer: UnusedMessageHTTP()))
        let model = ChatModel(session: hub, sessionId: "long-message")
        defer { model.stop(); hub.shutdown() }
        let driver = Driver()
        let source = block(log)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        let host = UIHostingController(rootView: Harness(driver: driver, model: model, block: source))
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        host.view.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(100))
        try XCTUnwrap(driver.open)(source)
        try await Task.sleep(for: .milliseconds(600))
        let sheet = try XCTUnwrap(host.presentedViewController)
        XCTAssertTrue(sheet.presentationController is UISheetPresentationController)
        XCTAssertTrue(model.isInspectingContent)
        driver.showBubble = false
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertTrue(host.presentedViewController === sheet)
        // Session removal invalidates the screen-owned route through SwiftUI,
        // just as Close/interactive dismissal does (not an out-of-band UIKit
        // dismiss, which doesn't update a SwiftUI sheet's binding).
        model.toolInspection.invalidate()
        for _ in 0..<100 {
            if host.presentedViewController == nil && !model.isInspectingContent { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertNil(host.presentedViewController)
        XCTAssertFalse(model.isInspectingContent)
        XCTAssertFalse(model.followsTail)
    }

    /// Optional local diagnostic, not a CI timing gate. The legacy path is
    /// deliberately unbounded to compare the same input on the same Simulator.
    func testProfileLegacyAndBoundedLayout() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["HAPI_LONG_MESSAGE_PROFILE"] == "1")
        let source: String
        if let path = ProcessInfo.processInfo.environment["HAPI_LONG_MESSAGE_FILE"] {
            source = try String(contentsOfFile: path, encoding: .utf8)
        } else {
            source = log
        }
        let legacy = AnyView(HStack(alignment: .bottom, spacing: 0) {
            Spacer(minLength: 48)
            Text(verbatim: source).font(.system(size: 16)).lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                .padding(.horizontal, 16).padding(.vertical, 12)
        })
        let bounded = AnyView(UserTextBlockView(block: block(source)).hapiTypography())
        for (name, root) in [("legacy", legacy), ("bounded", bounded)] {
            let start = CACurrentMediaTime()
            let host = UIHostingController(rootView: root)
            let size = host.sizeThatFits(in: CGSize(width: 370, height: CGFloat.greatestFiniteMagnitude))
            print("HAPI_LONG_MESSAGE_LAYOUT \(name) chars=\(source.count) height=\(size.height) ms=\((CACurrentMediaTime() - start) * 1_000)")
        }
    }
}

private actor UnusedMessageHTTP: HTTPPerforming {
    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        (Data(#"{"error":"unused test endpoint"}"#.utf8),
         HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: nil, headerFields: nil)!)
    }
}

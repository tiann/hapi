import HapiClient
import HapiProtocol
import Observation
import SwiftUI
import UIKit
import XCTest
@testable import Hapi

/// Real native sheets and lists over the non-networked config harness.
@MainActor
final class SessionConfigPresentationTests: XCTestCase {
    @Observable
    fileprivate final class Presentation {
        let model: SessionConfigModel
        var isPresented = false
        var notice: String?
        init(model: SessionConfigModel) { self.model = model }
    }

    private struct Host: View {
        let presentation: Presentation
        var size: DynamicTypeSize = .large
        var dark = false
        var locale = Locale(identifier: "en")

        var body: some View {
            @Bindable var presentation = presentation
            NavigationStack {
                Text("Session settings specimen")
                    .navigationTitle("HAPI")
                    .sheet(isPresented: $presentation.isPresented) {
                        SessionConfigView(model: presentation.model, notice: presentation.notice)
                            .environment(\.dynamicTypeSize, size)
                            .environment(\.locale, locale)
                    }
            }
            .environment(\.dynamicTypeSize, size)
            .environment(\.locale, locale)
            .preferredColorScheme(dark ? .dark : .light)
        }
    }

    func testRootIsThreeSummaryRowsAndNativeNavigationRestoresSheetHeight() async throws {
        let harness = try await SessionConfigTestHarness(model: "sonnet")
        let presentation = Presentation(model: harness.model)
        let (window, host) = try await show(Host(presentation: presentation))
        defer { window.isHidden = true }
        let sheet = try XCTUnwrap(host.presentedViewController)
        XCTAssertTrue(sheet.presentationController is UISheetPresentationController)
        let rootList = try XCTUnwrap(findList(sheet.view))
        XCTAssertEqual(itemCount(rootList), 3)
        XCTAssertEqual(rootList.indexPathsForVisibleItems.count, 3, "All summaries fit without scrolling")
        XCTAssertTrue(rootList.visibleCells.allSatisfy { $0.bounds.height >= 44 })
        let rootHeight = sheet.view.bounds.height
        try capture(window, name: "root")

        harness.model.path = [.model]
        try await settle()
        XCTAssertTrue(host.presentedViewController === sheet, "Push within the same sheet, not another modal")
        XCTAssertEqual(harness.model.detent, .large)
        XCTAssertGreaterThan(sheet.view.bounds.height, rootHeight)
        // Default plus three offered families; "sonnet" is a preset, so no
        // synthetic current row.
        XCTAssertEqual(itemCount(try XCTUnwrap(findList(sheet.view))), 4)
        try capture(window, name: "models")
        harness.model.selectModel("sonnet")
        try await settle()
        XCTAssertEqual(itemCount(try XCTUnwrap(findList(sheet.view))), 3)
        XCTAssertEqual(sheet.view.bounds.height, rootHeight, accuracy: 2)

        harness.model.path = [.permission]
        try await settle()
        XCTAssertEqual(itemCount(try XCTUnwrap(findList(sheet.view))), 5)
        try capture(window, name: "permissions")
        harness.model.path.removeAll()
        try await settle()
        let posts = await harness.http.posts
        XCTAssertTrue(posts.isEmpty, "Navigation and reselecting the current value are read-only")
        presentation.isPresented = false
        try await configEventually { host.presentedViewController == nil }
    }

    func testCodexRootShowsCollaborationAlongsidePermissionsModelAndEffort() async throws {
        let harness = try await SessionConfigTestHarness(flavor: "codex")
        let presentation = Presentation(model: harness.model)
        let (window, host) = try await show(Host(presentation: presentation, locale: Locale(identifier: "zh-Hans")))
        defer { window.isHidden = true }
        try await configEventually { harness.model.showsEffort }
        try await settle()
        let sheet = try XCTUnwrap(host.presentedViewController)
        let list = try XCTUnwrap(findList(sheet.view))
        XCTAssertEqual(itemCount(list), 4)
        XCTAssertTrue(list.visibleCells.allSatisfy { $0.bounds.height >= 44 })
        harness.model.selectCollaborationMode(.plan)
        try await settle()
        XCTAssertTrue(host.presentedViewController === sheet)
        XCTAssertEqual(harness.model.collaborationMode, .plan)
        XCTAssertEqual(harness.model.permission, .default)
        XCTAssertEqual(itemCount(list), 4)
    }

    func testBusyAndFailureFeedbackRemainInsideTheOpenSheet() async throws {
        let harness = try await SessionConfigTestHarness(model: "sonnet")
        let presentation = Presentation(model: harness.model)
        harness.interactor.onEvent = {
            if case .notice(let message) = $0 { presentation.notice = message }
        }
        let (window, host) = try await show(Host(presentation: presentation))
        defer { window.isHidden = true }
        let sheet = try XCTUnwrap(host.presentedViewController)
        await harness.http.holdPosts()
        await harness.http.rejectChanges()
        defer { Task { await harness.http.releasePosts() } }
        harness.model.selectModel("opus")
        try await settle()
        XCTAssertTrue(harness.model.isApplying)
        XCTAssertTrue(host.presentedViewController === sheet)
        try capture(window, name: "applying")
        await harness.http.releasePosts()
        try await configEventually { presentation.notice == "HTTP 409 (Config rejected)" && !harness.model.isApplying }
        try await settle()
        XCTAssertEqual(harness.model.modelLabel, "Sonnet")
        XCTAssertTrue(host.presentedViewController === sheet)
        try capture(window, name: "failure")
        presentation.notice = nil
        try await settle()
        XCTAssertEqual(itemCount(try XCTUnwrap(findList(sheet.view))), 3)
    }

    func testFailedCatalogCanRetryWithoutLeavingTheModelPage() async throws {
        let harness = try await SessionConfigTestHarness(flavor: "codex")
        await harness.http.setModelsFailure(true)
        let presentation = Presentation(model: harness.model)
        let (window, host) = try await show(Host(presentation: presentation))
        defer { window.isHidden = true }
        try await configEventually { harness.model.modelLoadFailed }
        harness.model.path = [.model]
        try await settle()
        let sheet = try XCTUnwrap(host.presentedViewController)
        XCTAssertEqual(itemCount(try XCTUnwrap(findList(sheet.view))), 2, "Failure label plus Retry")
        try capture(window, name: "catalog-failure")
        await harness.http.setModelsFailure(false)
        harness.model.loadModels()
        try await configEventually { !harness.model.config.modelOptionsLoading }
        try await settle()
        XCTAssertEqual(harness.model.path, [.model])
        XCTAssertEqual(harness.model.currentModel, "deep")
        XCTAssertEqual(itemCount(try XCTUnwrap(findList(sheet.view))), 2)
    }

    func testLayoutSpecimensSupportNarrowWideDarkChineseAndLargeType() async throws {
        let cases: [(String, CGSize, DynamicTypeSize, Bool, String)] = [
            ("compact", CGSize(width: 320, height: 667), .large, false, "en"),
            ("dark", CGSize(width: 390, height: 844), .large, true, "en"),
            ("chinese", CGSize(width: 390, height: 844), .large, false, "zh-Hans"),
            ("large-type", CGSize(width: 390, height: 844), .accessibility3, false, "zh-Hans"),
            ("wide", CGSize(width: 820, height: 1180), .large, false, "en"),
        ]
        for (name, dimensions, typeSize, dark, locale) in cases {
            let shortModel = name == "compact" || name == "chinese"
            let harness = try await SessionConfigTestHarness(
                model: shortModel ? "sonnet" : "custom-model-with-a-very-long-name-用于长名称换行验证"
            )
            harness.store.updateDetailLocal("config") { $0.permissionMode = .bypassPermissions }
            let presentation = Presentation(model: harness.model)
            let (window, host) = try await show(
                Host(presentation: presentation, size: typeSize, dark: dark, locale: Locale(identifier: locale)),
                dimensions: dimensions
            )
            let sheet = try XCTUnwrap(host.presentedViewController)
            let list = try XCTUnwrap(findList(sheet.view))
            XCTAssertEqual(itemCount(list), 3)
            XCTAssertTrue(list.visibleCells.allSatisfy { $0.bounds.height >= 44 })
            if !typeSize.isAccessibilitySize {
                XCTAssertEqual(list.indexPathsForVisibleItems.count, 3, "Even the compact sheet shows all summaries")
                XCTAssertLessThan(
                    try XCTUnwrap(list.cellForItem(at: IndexPath(item: 0, section: 0))).bounds.height, 120,
                    "The warning subtitle must not stretch into a separate Form row"
                )
            }
            if typeSize.isAccessibilitySize {
                let controller = try XCTUnwrap(sheet.sheetPresentationController)
                XCTAssertEqual(controller.detents.count, 1, "Accessibility text uses a large sheet")
            }
            try capture(window, name: name)
            if name == "chinese" {
                harness.model.path = [.permission]
                try await settle()
                try capture(window, name: "chinese-permissions")
            }
            presentation.isPresented = false
            try await configEventually { host.presentedViewController == nil }
            window.isHidden = true
        }
    }

    func testSheetAdaptsToDeviceSize() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let harness = try await SessionConfigTestHarness(model: "sonnet")
        let presentation = Presentation(model: harness.model)
        let (window, host) = try await show(
            Host(presentation: presentation), dimensions: scene.coordinateSpace.bounds.size
        )
        defer { window.isHidden = true }
        let sheet = try XCTUnwrap(host.presentedViewController)
        XCTAssertEqual(itemCount(try XCTUnwrap(findList(sheet.view))), 3)
        try capture(window, name: "device-root")
        harness.model.path = [.model]
        try await settle()
        XCTAssertTrue(host.presentedViewController === sheet)
        // Default plus three offered families; "sonnet" is a preset, so no
        // synthetic current row.
        XCTAssertEqual(itemCount(try XCTUnwrap(findList(sheet.view))), 4)
        try capture(window, name: "device-models")
    }

    private func show(
        _ content: Host, dimensions: CGSize = CGSize(width: 390, height: 844)
    ) async throws -> (UIWindow, UIHostingController<Host>) {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(origin: .zero, size: dimensions)
        let host = UIHostingController(rootView: content)
        window.rootViewController = host
        window.makeKeyAndVisible()
        try await Task.sleep(for: .milliseconds(100))
        content.presentation.isPresented = true
        try await configEventually { host.presentedViewController != nil }
        try await settle()
        return (window, host)
    }

    private func settle() async throws {
        try await Task.sleep(for: .milliseconds(650))
    }

    private func findList(_ view: UIView) -> UICollectionView? {
        if let list = view as? UICollectionView, list.window != nil, !list.isHidden { return list }
        for child in view.subviews.reversed() {
            if let list = findList(child) { return list }
        }
        return nil
    }

    private func itemCount(_ list: UICollectionView) -> Int {
        (0..<list.numberOfSections).reduce(0) { $0 + list.numberOfItems(inSection: $1) }
    }

    private func capture(_ window: UIWindow, name: String) throws {
        guard let path = ProcessInfo.processInfo.environment["HAPI_SESSION_CONFIG_CAPTURE"] else { return }
        let directory = URL(fileURLWithPath: path, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        try XCTUnwrap(image.pngData()).write(to: directory.appendingPathComponent("\(name).png"))
    }
}

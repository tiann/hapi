import HapiUI
import Observation
import OSLog
import SwiftUI
import UIKit
import XCTest
@testable import Hapi
@testable import HapiProtocol

private struct DisplayProbeResult: Sendable {
    let seconds: Double
    let callbacks: Int
    let callbackFPS: Double
    let intervalP50Ms: Double
    let intervalP95Ms: Double
    let intervalP99Ms: Double
    let maxIntervalMs: Double
    let intervalsOver25Ms: Int
    let intervalsOver50Ms: Int
    let distancePoints: Double
    let offsetUpdateMaxMs: Double
    let intervalsMs: [Double]

    var jsonObject: [String: Any] {
        [
            "seconds": seconds,
            "callbacks": callbacks,
            "callbackFPS": callbackFPS,
            "intervalP50Ms": intervalP50Ms,
            "intervalP95Ms": intervalP95Ms,
            "intervalP99Ms": intervalP99Ms,
            "maxIntervalMs": maxIntervalMs,
            "intervalsOver25Ms": intervalsOver25Ms,
            "intervalsOver50Ms": intervalsOver50Ms,
            "distancePoints": distancePoints,
            "offsetUpdateMaxMs": offsetUpdateMaxMs,
            "intervalsMs": intervalsMs,
        ]
    }
}

/// Opt-in, real-vsync diagnostic. No FPS assertion: host load affects Simulator.
/// CADisplayLink cadence is NOT compositor-presented FPS; correlate with Instruments.
@MainActor
final class TranscriptFrameProfileTests: XCTestCase {
    struct Row: Identifiable, Equatable {
        let id: String
        let block: VisibleChatBlock
    }

    @Observable @MainActor
    final class Driver {
        var rows: [Row]
        let cache = MarkdownRenderCache()
        let presentation = ChatPresentationState()
        init(rows: [Row]) { self.rows = rows }
    }

    private struct Harness: View {
        let driver: Driver
        var body: some View {
            AnchoredTranscriptList(
                items: driver.rows, historyVersion: 0, jumpToken: 0,
                historyControlID: "history", onViewport: { _ in }, onLayout: { _, _ in }
            ) { row in
                AnyView(ChatBlockCard(block: row.block, basePath: "/workspace/hapi")
                    .environment(\.hapiMarkdownCache, driver.cache)
                    .environment(\.chatPresentationState, driver.presentation)
                    .hapiTheme(.light))
            }
        }
    }

    private static func source(_ index: Int, rich: Bool) -> String {
        let paragraph = "Message \(index). " + String(repeating: "Native transcript scrolling keeps the reading position stable. ", count: 1 + index % 4)
        guard rich else { return paragraph }
        switch index % 4 {
        case 0: return "## Review \(index)\n\n\(paragraph)\n\n- **Stable identity** and `cached layout`\n- A [reference](https://example.com) with *details*\n- [x] Verified"
        case 1:
            let code = (0..<14).map { "    let item\($0) = messages[\($0)] // row \(index)" }.joined(separator: "\n")
            return "### Code \(index)\n\n```swift\nfunc render() {\n\(code)\n}\n```"
        case 2:
            return "| File | Added | Removed |\n| --- | ---: | ---: |\n" + (0..<10).map { "| source-\(index)-\($0).swift | \($0 + 2) | 1 |" }.joined(separator: "\n")
        default: return "\(paragraph)\n\n> A longer explanation with **emphasis**.\n\n" + paragraph
        }
    }

    private static func row(_ index: Int, text: String) -> Row {
        let id = "profile-\(index)"
        return Row(id: id, block: .block(.agentText(AgentTextBlock(
            id: id, localId: nil, createdAt: index, invokedAt: nil,
            durationMs: nil, usage: nil, model: nil, text: text, meta: nil
        ))))
    }

    func testProfileRealDisplayFrames() async throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["HAPI_SCROLL_PROFILE"] == "1",
                          "Run explicitly with TEST_RUNNER_HAPI_SCROLL_PROFILE=1; never a CI timing gate.")
        let log = OSLog(subsystem: "run.hapi.profile", category: .pointsOfInterest)
        let delay = Double(ProcessInfo.processInfo.environment["HAPI_SCROLL_PROFILE_DELAY"] ?? "0") ?? 0
        print("HAPI_PROFILE_READY pid=\(ProcessInfo.processInfo.processIdentifier)")
        try await Task.sleep(for: .seconds(delay))
        let scenarios = (ProcessInfo.processInfo.environment["HAPI_SCROLL_SCENARIOS"] ?? "plain,rich,rich-updates").split(separator: ",").map(String.init)
        for scenario in scenarios {
            XCTAssertTrue(["plain", "rich", "rich-updates"].contains(scenario))
            let sources = (0..<800).map { Self.source($0, rich: scenario != "plain") }
            let driver = Driver(rows: sources.enumerated().map { Self.row($0.offset, text: $0.element) })
            let updates = (0..<100).map { sources[799] + "\n\nStreaming revision \($0)" }
            await driver.cache.prepare(sources)
            let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
            let window = UIWindow(windowScene: scene)
            let host = UIHostingController(rootView: Harness(driver: driver))
            window.rootViewController = host
            window.makeKeyAndVisible()
            defer { window.isHidden = true }
            try await Task.sleep(for: .seconds(1))
            func find(_ view: UIView) -> UICollectionView? {
                if let collection = view as? UICollectionView { return collection }
                return view.subviews.lazy.compactMap(find).first
            }
            let collection = try XCTUnwrap(find(host.view))
            collection.delegate?.scrollViewWillBeginDragging?(collection)
            collection.scrollToItem(at: IndexPath(item: 350, section: 0), at: .top, animated: false)
            try await Task.sleep(for: .seconds(1))
            let start = collection.contentOffset.y
            let initialHeights = collection.visibleCells.map { $0.frame.height }.sorted()
            if scenario != "plain" {
                XCTAssertGreaterThan(initialHeights.max() ?? 0, 200,
                                     "Rich rows must actually render and self-size, not remain empty estimates")
            }
            let preview = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            let previewAttachment = XCTAttachment(image: preview)
            previewAttachment.name = "\(scenario)-rendered-transcript"
            previewAttachment.lifetime = .keepAlways
            add(previewAttachment)
            print("HAPI_PROFILE_SCENARIO \(scenario)")
            for repetition in 1...3 {
                collection.contentOffset.y = start
                try await Task.sleep(for: .milliseconds(500))
                let label = "\(scenario)-\(repetition)"
                let signpost = OSSignpostID(log: log)
                os_signpost(.begin, log: log, name: "Transcript Scroll", signpostID: signpost, "%{public}s", label)
                var previousRevision = -1
                let probe = DisplayProbe(collection: collection, seconds: 6, speed: 1_800) { elapsed in
                    if scenario == "rich-updates" {
                        let revision = min(updates.count - 1, Int(elapsed * 10))
                        if revision != previousRevision {
                            previousRevision = revision
                            driver.rows[799] = Self.row(799, text: updates[revision])
                        }
                    }
                }
                let result = await probe.run()
                os_signpost(.end, log: log, name: "Transcript Scroll", signpostID: signpost)
                var record = result.jsonObject
                record["scenario"] = scenario
                record["repetition"] = repetition
                record["rows"] = 800
                record["viewportWidth"] = collection.bounds.width
                record["viewportHeight"] = collection.bounds.height
                record["initialVisibleHeights"] = initialHeights
                record["maximumFramesPerSecond"] = window.screen.maximumFramesPerSecond
                record["os"] = UIDevice.current.systemVersion
                record["metric"] = "display-link-callback-cadence-not-presented-fps"
                let data = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
                print("HAPI_FRAME_PROFILE \(String(decoding: data, as: UTF8.self))")
                let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
                attachment.name = label
                attachment.lifetime = .keepAlways
                add(attachment)
                XCTAssertGreaterThan(result.distancePoints, 5_000, "Probe must actually scroll")
            }
        }
    }

    @MainActor
    private final class DisplayProbe: NSObject {
        let collection: UICollectionView
        let seconds: Double
        let speed: Double
        let update: (Double) -> Void
        var link: CADisplayLink?
        var continuation: CheckedContinuation<DisplayProbeResult, Never>?
        var began: Double?
        var previous: Double?
        var intervals: [Double] = []
        var updateTimes: [Double] = []
        var initialOffset = 0.0

        init(collection: UICollectionView, seconds: Double, speed: Double, update: @escaping (Double) -> Void) {
            self.collection = collection
            self.seconds = seconds
            self.speed = speed
            self.update = update
        }

        func run() async -> DisplayProbeResult {
            await withCheckedContinuation { continuation in
                self.continuation = continuation
                initialOffset = collection.contentOffset.y
                let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
                link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 60, preferred: 60)
                self.link = link
                link.add(to: .main, forMode: .common)
            }
        }

        @objc func tick(_ link: CADisplayLink) {
            let now = CACurrentMediaTime()
            if began == nil { began = now }
            let elapsed = now - began!
            if let previous { intervals.append((now - previous) * 1_000) }
            self.previous = now
            if elapsed >= seconds {
                link.invalidate()
                self.link = nil
                let sorted = intervals.sorted()
                func percentile(_ p: Double) -> Double { sorted[min(sorted.count - 1, Int(Double(sorted.count - 1) * p))] }
                let result = DisplayProbeResult(
                    seconds: elapsed,
                    callbacks: intervals.count,
                    callbackFPS: Double(intervals.count) / elapsed,
                    intervalP50Ms: percentile(0.5),
                    intervalP95Ms: percentile(0.95),
                    intervalP99Ms: percentile(0.99),
                    maxIntervalMs: sorted.last ?? 0,
                    intervalsOver25Ms: intervals.filter { $0 > 25 }.count,
                    intervalsOver50Ms: intervals.filter { $0 > 50 }.count,
                    distancePoints: Double(collection.contentOffset.y - initialOffset),
                    offsetUpdateMaxMs: updateTimes.max() ?? 0,
                    intervalsMs: intervals
                )
                continuation?.resume(returning: result)
                continuation = nil
                return
            }
            collection.contentOffset.y = initialOffset + elapsed * speed
            update(elapsed)
            updateTimes.append((CACurrentMediaTime() - now) * 1_000)
        }
    }
}

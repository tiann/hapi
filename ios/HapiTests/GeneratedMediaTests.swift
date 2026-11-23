import AVFoundation
import HapiClient
import SwiftUI
import UIKit
import XCTest
@testable import Hapi
@testable import HapiProtocol

@MainActor
final class GeneratedMediaTests: XCTestCase {
    private actor Source {
        let data: Data
        let mime: String
        var calls = 0
        var failures: Int

        init(data: Data = Data("fixture".utf8), mime: String = "application/octet-stream", failures: Int = 0) {
            self.data = data
            self.mime = mime
            self.failures = failures
        }

        func fetch(_ id: String) async throws -> (data: Data, mimeType: String?) {
            calls += 1
            try await Task.sleep(for: .milliseconds(30))
            if failures > 0 {
                failures -= 1
                throw URLError(.timedOut)
            }
            return (data, mime)
        }
    }

    private func block(_ mime: String?, id: String = "media", name: String = "fixture") -> GeneratedImageBlock {
        GeneratedImageBlock(id: id, localId: nil, createdAt: 0, invokedAt: nil,
                            imageId: id, fileName: name, mimeType: mime)
    }

    func testMIMESelectsRendererNotFilenameOrToolName() {
        XCTAssertEqual(GeneratedMediaKind(mimeType: nil), .image)
        XCTAssertEqual(GeneratedMediaKind(mimeType: "image/png"), .image)
        XCTAssertEqual(GeneratedMediaKind(mimeType: "video/mp4"), .video)
        XCTAssertEqual(GeneratedMediaKind(mimeType: "video/webm"), .video)
        XCTAssertEqual(GeneratedMediaKind(mimeType: "VIDEO/MP4"), .video)
        XCTAssertEqual(GeneratedMediaKind(mimeType: "audio/wav"), .audio)
        XCTAssertEqual(GeneratedMediaKind(mimeType: "application/pdf"), .file)
        XCTAssertEqual(GeneratedMediaKind(mimeType: "application/octet-stream"), .file)
    }

    func testUntouchedNonImageCardsDoNotFetchIncludingAfterReuse() async throws {
        let source = Source()
        let loader = GeneratedMediaLoader(fetch: source.fetch)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        let host = UIHostingController(rootView: AnyView(EmptyView()))
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        for (index, mime) in ["video/mp4", "audio/wav", "application/pdf"].enumerated() {
            host.rootView = AnyView(GeneratedImageBlockView(block: block(mime, id: "\(index)"))
                .environment(\.chatMedia, loader))
            host.view.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(100))
        }
        let calls = await source.calls
        XCTAssertEqual(calls, 0)
    }

    func testFilesSingleFlightCacheAndPreserveBytes() async throws {
        let source = Source()
        let loader = GeneratedMediaLoader(fetch: source.fetch)
        async let first = loader.file(for: "id", fileName: "report.pdf", mimeType: "application/pdf")
        async let second = loader.file(for: "id", fileName: "report.pdf", mimeType: "application/pdf")
        let (a, b) = try await (first, second)
        XCTAssertTrue(a === b)
        let cached = try await loader.file(for: "id", fileName: "report.pdf", mimeType: "application/pdf")
        XCTAssertTrue(a === cached)
        XCTAssertEqual(try Data(contentsOf: a.url), Data("fixture".utf8))
        let calls = await source.calls
        XCTAssertEqual(calls, 1)
    }

    func testFailedDownloadCanBeRetried() async {
        let source = Source(failures: 1)
        let loader = GeneratedMediaLoader(fetch: source.fetch)
        let content = GeneratedMediaPresentation(block: block("application/pdf"))
        await content.load(using: loader)
        XCTAssertTrue(content.loadFailed)
        XCTAssertFalse(content.isLoading)
        XCTAssertNil(content.file)
        await content.load(using: loader)
        XCTAssertFalse(content.loadFailed)
        XCTAssertNotNil(content.file)
        XCTAssertNil(content.player)
        let calls = await source.calls
        XCTAssertEqual(calls, 2)
    }

    func testImageLoadingAndCachingStillWork() async throws {
        let data = try XCTUnwrap(UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8)).image { context in
            UIColor.red.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
        }.pngData())
        let source = Source(data: data, mime: "image/png")
        let loader = GeneratedMediaLoader(fetch: source.fetch)
        let content = GeneratedMediaPresentation(block: block(nil))
        await content.load(using: loader)
        XCTAssertNotNil(content.image)
        XCTAssertFalse(content.loadFailed)
        XCTAssertNil(content.file)
        _ = try await loader.image(for: "media")
        let calls = await source.calls
        XCTAssertEqual(calls, 1)
    }

    func testUnsupportedMediaKeepsFileForSharing() async {
        // An unsupported/corrupt container must not fall back to an image placeholder.
        let source = Source(data: Data("not a supported container".utf8), mime: "video/webm")
        let loader = GeneratedMediaLoader(fetch: source.fetch)
        let content = GeneratedMediaPresentation(block: block("video/webm", name: "clip.webm"))
        await content.load(using: loader)
        XCTAssertTrue(content.playbackUnavailable)
        XCTAssertFalse(content.loadFailed)
        XCTAssertNotNil(content.file)
        XCTAssertNil(content.player)
    }

    func testVideoAndAudioCreatePausedNativePlayersAndRetainShareFallback() async throws {
        for (mime, name, data) in [("video/mp4", "clip.mp4", try await videoBytes()),
                                   ("audio/wav", "speech.wav", audioBytes())] {
            let source = Source(data: data, mime: mime)
            let loader = GeneratedMediaLoader(fetch: source.fetch)
            let content = GeneratedMediaPresentation(block: block(mime, name: name))
            await content.load(using: loader)
            XCTAssertFalse(content.playbackUnavailable, mime)
            let player = try XCTUnwrap(content.player, mime)
            XCTAssertEqual(player.rate, 0, "No autoplay")
            XCTAssertNotNil(content.file)
            player.play()
            content.pause()
            XCTAssertEqual(player.rate, 0)
            content.playbackFailed()
            XCTAssertTrue(content.playbackUnavailable)
            XCTAssertNil(content.player)
            XCTAssertNotNil(content.file, "Late decoder errors must keep save/share available")
        }
    }

    func testCancelledLoadDoesNotPublishAndCanLoadAgainFromCache() async throws {
        let source = Source()
        let loader = GeneratedMediaLoader(fetch: source.fetch)
        let content = GeneratedMediaPresentation(block: block("application/pdf"))
        let loading = Task { await content.load(using: loader) }
        for _ in 0..<100 {
            if await source.calls > 0 { break }
            try await Task.sleep(for: .milliseconds(5))
        }
        loading.cancel()
        await loading.value
        XCTAssertNil(content.file)
        XCTAssertFalse(content.loadFailed)
        XCTAssertFalse(content.isLoading)
        await content.load(using: loader)
        XCTAssertNotNil(content.file)
        let calls = await source.calls
        XCTAssertEqual(calls, 1)
    }

    func testReappearingCardTakesOverAnUnfinishedCancelledLoad() async throws {
        let source = Source()
        let loader = GeneratedMediaLoader(fetch: source.fetch)
        let content = GeneratedMediaPresentation(block: block("application/pdf"))
        let first = Task { await content.load(using: loader) }
        for _ in 0..<100 {
            if await source.calls > 0 { break }
            try await Task.sleep(for: .milliseconds(1))
        }
        first.cancel()
        let reappeared = Task { await content.load(using: loader) }
        await first.value
        await reappeared.value
        XCTAssertNotNil(content.file)
        XCTAssertFalse(content.isLoading)
        XCTAssertFalse(content.loadFailed)
        let calls = await source.calls
        XCTAssertEqual(calls, 1)
    }

    func testTemporaryFilesUseSafeNamesAndAreRemovedOnRelease() throws {
        var file: GeneratedMediaFile? = try GeneratedMediaFile(
            data: Data("fixture".utf8), fileName: "../../outside.pdf", mimeType: "application/pdf")
        let url = try XCTUnwrap(file?.url)
        XCTAssertEqual(url.lastPathComponent, "outside.pdf")
        XCTAssertTrue(url.deletingLastPathComponent().lastPathComponent.hasPrefix("hapi-media-"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
        file = nil
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.deletingLastPathComponent().path))
        for name in ["..", "/", "..\\..\\", "\n"] {
            let safe = try GeneratedMediaFile(data: Data(), fileName: name, mimeType: "video/mp4")
            XCTAssertEqual(safe.url.lastPathComponent, "media.mp4")
        }
        let long = try GeneratedMediaFile(data: Data(), fileName: String(repeating: "视频", count: 100) + ".mp4",
                                           mimeType: "video/mp4")
        XCTAssertLessThanOrEqual(long.url.lastPathComponent.utf8.count, 220)
        XCTAssertEqual(long.url.pathExtension, "mp4")
    }

    func testCacheEvictionDoesNotDeleteAFileStillHeldByACard() async throws {
        let source = Source()
        var loader: GeneratedMediaLoader? = GeneratedMediaLoader(fetch: source.fetch)
        var file: GeneratedMediaFile? = try await loader?.file(for: "id", fileName: "report", mimeType: "application/pdf")
        let url = try XCTUnwrap(file?.url)
        XCTAssertEqual(url.pathExtension, "pdf")
        loader = nil
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
        file = nil
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }

    func testCardsHaveFiniteLayoutAtAccessibilitySizes() {
        for mime in ["image/png", "video/mp4", "audio/wav", "application/pdf"] {
            let host = UIHostingController(rootView: GeneratedImageBlockView(block: block(mime))
                .environment(\.dynamicTypeSize, .accessibility5))
            let size = host.sizeThatFits(in: CGSize(width: 280, height: CGFloat.greatestFiniteMagnitude))
            XCTAssertTrue(size.height.isFinite)
            XCTAssertGreaterThan(size.height, 0)
            XCTAssertLessThan(size.height, 600)
        }
    }

    private func audioBytes() -> Data {
        let samples = 1_600
        var data = Data()
        func text(_ string: String) { data.append(contentsOf: string.utf8) }
        func number<T: FixedWidthInteger>(_ value: T) {
            var little = value.littleEndian
            withUnsafeBytes(of: &little) { data.append(contentsOf: $0) }
        }
        text("RIFF"); number(UInt32(36 + samples * 2)); text("WAVEfmt ")
        number(UInt32(16)); number(UInt16(1)); number(UInt16(1))
        number(UInt32(8_000)); number(UInt32(16_000)); number(UInt16(2)); number(UInt16(16))
        text("data"); number(UInt32(samples * 2))
        data.append(Data(count: samples * 2))
        return data
    }

    private func videoBytes() async throws -> Data {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).mp4")
        defer { try? FileManager.default.removeItem(at: url) }
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 32, AVVideoHeightKey: 32,
        ])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: nil)
        writer.add(input)
        XCTAssertTrue(writer.startWriting())
        writer.startSession(atSourceTime: .zero)
        var buffer: CVPixelBuffer?
        XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault, 32, 32, kCVPixelFormatType_32ARGB,
                                           nil, &buffer), kCVReturnSuccess)
        let pixel = try XCTUnwrap(buffer)
        CVPixelBufferLockBaseAddress(pixel, [])
        if let address = CVPixelBufferGetBaseAddress(pixel) {
            memset(address, 0, CVPixelBufferGetDataSize(pixel))
        }
        CVPixelBufferUnlockBaseAddress(pixel, [])
        for _ in 0..<200 where !input.isReadyForMoreMediaData {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(adaptor.append(pixel, withPresentationTime: .zero))
        writer.endSession(atSourceTime: CMTime(value: 1, timescale: 5))
        input.markAsFinished()
        await writer.finishWriting()
        XCTAssertEqual(writer.status, .completed, "\(String(describing: writer.error))")
        return try Data(contentsOf: url)
    }
}

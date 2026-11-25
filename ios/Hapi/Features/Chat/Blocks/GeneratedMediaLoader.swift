import Foundation
import HapiClient
import UIKit
import UniformTypeIdentifiers

/// Owns a private, non-user-selected path. References held by a player/share
/// sheet keep the file alive even after eviction from the per-chat cache.
final class GeneratedMediaFile: Sendable {
    let url: URL
    let byteCount: Int
    private let directory: URL

    init(data: Data, fileName: String, mimeType: String?) throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("hapi-media-\(UUID().uuidString)", isDirectory: true)
        // Neither the wire filename nor the media id may select a local path.
        var name = String((fileName.replacingOccurrences(of: "\\", with: "/")
            .components(separatedBy: "/").last ?? "").unicodeScalars
            .filter { !CharacterSet.controlCharacters.contains($0) })
        if name.isEmpty || name == "." || name == ".." { name = "media" }
        let suppliedExtension = (name as NSString).pathExtension
        let mime = mimeType?.split(separator: ";", maxSplits: 1).first.map(String.init)?.lowercased()
        let fallbackExtension = mime.flatMap { UTType(mimeType: $0)?.preferredFilenameExtension } ?? ""
        let ext = suppliedExtension.isEmpty || suppliedExtension.utf8.count > 32
            ? fallbackExtension : suppliedExtension
        var stem = (name as NSString).deletingPathExtension
        let suffix = ext.isEmpty ? "" : ".\(ext)"
        // APFS limits components by UTF-8 bytes, not Swift character count.
        while stem.utf8.count + suffix.utf8.count > 220 { stem.removeLast() }
        if stem.isEmpty { stem = "media" }
        name = stem + suffix
        url = directory.appendingPathComponent(name)
        byteCount = data.count
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: url, options: .atomic)
        } catch {
            try? FileManager.default.removeItem(at: directory)
            throw error
        }
    }

    deinit {
        try? FileManager.default.removeItem(at: directory)
    }
}

/// Authenticated bytes (including JWT refresh) stay on APIClient, never on an
/// AVPlayer URL. Images decode off-main; other media is staged off-main to
/// private files for native playback/preview/sharing. Both paths single-flight.
@MainActor
final class GeneratedMediaLoader {
    typealias Fetch = @Sendable (String) async throws -> (data: Data, mimeType: String?)
    private let fetch: Fetch
    private let images = NSCache<NSString, UIImage>()
    private let files = NSCache<NSString, GeneratedMediaFile>()
    private var imageTasks: [String: Task<UIImage, Error>] = [:]
    private var fileTasks: [String: Task<GeneratedMediaFile, Error>] = [:]

    convenience init(api: APIClient, sessionId: String) {
        self.init { imageId in
            try await api.generatedImage(sessionId: sessionId, imageId: imageId)
        }
    }

    init(fetch: @escaping Fetch) {
        self.fetch = fetch
        images.countLimit = 40
        files.countLimit = 8
        files.totalCostLimit = 100 * 1024 * 1024
    }

    func image(for imageId: String) async throws -> UIImage {
        if let cached = images.object(forKey: imageId as NSString) { return cached }
        if let task = imageTasks[imageId] { return try await task.value }
        let fetch = fetch
        let task = Task {
            let payload = try await fetch(imageId)
            return try await Task.detached(priority: .utility) {
                guard let image = UIImage(data: payload.data)?.preparingForDisplay() else {
                    throw CocoaError(.fileReadCorruptFile)
                }
                return image
            }.value
        }
        imageTasks[imageId] = task
        defer { imageTasks[imageId] = nil }
        let image = try await task.value
        images.setObject(image, forKey: imageId as NSString)
        return image
    }

    func file(for imageId: String, fileName: String, mimeType: String?) async throws -> GeneratedMediaFile {
        if let cached = files.object(forKey: imageId as NSString) { return cached }
        if let task = fileTasks[imageId] { return try await task.value }
        let fetch = fetch
        let task = Task {
            let payload = try await fetch(imageId)
            return try await Task.detached(priority: .utility) {
                try GeneratedMediaFile(data: payload.data, fileName: fileName,
                                       mimeType: mimeType ?? payload.mimeType)
            }.value
        }
        fileTasks[imageId] = task
        defer { fileTasks[imageId] = nil }
        let file = try await task.value
        files.setObject(file, forKey: imageId as NSString, cost: file.byteCount)
        return file
    }
}

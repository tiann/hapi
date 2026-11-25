import Foundation
import UniformTypeIdentifiers

/// Dropped and pasted items (Finder/Files drags, screenshots, browser
/// images). The provider's file is only valid inside its callback, so it is
/// copied into a private temporary directory that the caller removes after
/// `AttachmentPreparer.prepare(fileURL:)` has read it.
enum ItemProviderAttachmentLoader {
    struct Copy {
        let fileURL: URL

        func remove() {
            try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent())
        }
    }

    /// Files and images only: a drag of selected text (plain text with no
    /// file name) must not turn into a .txt attachment.
    static func canLoad(_ provider: NSItemProvider) -> Bool {
        guard let type = contentType(of: provider) else { return false }
        if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) || type.conforms(to: .image) {
            return true
        }
        if !type.conforms(to: .text) { return true }
        let name = provider.suggestedName ?? ""
        return !URL(fileURLWithPath: name).pathExtension.isEmpty
    }

    static func copy(_ provider: NSItemProvider) async -> Copy? {
        guard let type = contentType(of: provider) else { return nil }
        let suggestedName = provider.suggestedName
        return await withCheckedContinuation { continuation in
            _ = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
                guard let url else {
                    continuation.resume(returning: nil)
                    return
                }
                continuation.resume(returning: copyOut(url, type: type, suggestedName: suggestedName))
            }
        }
    }

    /// The first concrete content type; a file drag also advertises
    /// `public.file-url`, which has no file representation of its own.
    private static func contentType(of provider: NSItemProvider) -> UTType? {
        provider.registeredContentTypes.first { $0 != .fileURL && $0.conforms(to: .item) }
    }

    private static func copyOut(_ url: URL, type: UTType, suggestedName: String?) -> Copy? {
        var name = url.lastPathComponent
        if let suggestedName, !suggestedName.isEmpty, URL(fileURLWithPath: name).pathExtension.isEmpty {
            name = suggestedName
        }
        if URL(fileURLWithPath: name).pathExtension.isEmpty, let ext = type.preferredFilenameExtension {
            name += ".\(ext)"
        }
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("dropped-\(UUID().uuidString)", isDirectory: true)
        let destination = directory.appendingPathComponent(name)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try FileManager.default.copyItem(at: url, to: destination)
            return Copy(fileURL: destination)
        } catch {
            try? FileManager.default.removeItem(at: directory)
            return nil
        }
    }
}

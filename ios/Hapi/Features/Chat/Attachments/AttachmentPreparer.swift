import CoreGraphics
import Foundation
import HapiClient
import ImageIO
import UniformTypeIdentifiers

/// Outcome of preparing one picked/captured file for upload.
enum PrepareResult {
    case ready(PreparedAttachment)

    /// Over the 50 MB wire cap (and not recoverable by image compression).
    case tooLarge(filename: String, sizeBytes: Int)

    /// The source would not give us the bytes.
    case unreadable(filename: String)
}

/// Reads picked content into `PreparedAttachment`s ready for
/// `ComposerAttachments.add` (A-M3f). All policy decisions live in the pure
/// `AttachmentPolicy` (HapiClient); this enum supplies the platform parts:
/// security-scoped file reads, ImageIO downscaling (`CGImageSource`
/// thumbnailing honors EXIF orientation), JPEG re-encode, and thumbnail
/// generation. Port of the Android `AttachmentPreparer`.
///
/// Compression stance (differs from web, which uploads originals): images
/// over `AttachmentPolicy.imageCompressThresholdBytes` are downscaled to
/// `AttachmentPolicy.maxImageDimension` px JPEG — phone photos are 5–15 MB
/// of mostly-wasted agent context on mobile data. Non-image files always
/// keep their original bytes; anything still over 50 MB is rejected.
///
/// Every function is `nonisolated` (enum statics) and the entry points are
/// async, so decode/encode work hops off the main actor at the call site.
enum AttachmentPreparer {

    // MARK: - Entry points

    /// In-memory bytes (photo picker loads, camera captures): apply the
    /// policy and build the prepared attachment.
    static func prepare(data: Data, filename: String, mimeType: String) async -> PrepareResult {
        prepareBytes(filename: filename, mimeType: mimeType, original: data)
    }

    /// One `fileImporter` pick. The URL is security-scoped; the read happens
    /// behind a cap so a surprise multi-GB pick cannot exhaust memory.
    static func prepare(fileURL: URL) async -> PrepareResult {
        let filename = fileURL.lastPathComponent
        let mimeType = mimeType(forFilename: filename)

        let scoped = fileURL.startAccessingSecurityScopedResource()
        defer {
            if scoped { fileURL.stopAccessingSecurityScopedResource() }
        }

        // Reject before reading when the filesystem already says it's hopeless.
        let statedSize = (try? fileURL.resourceValues(forKeys: [.fileSizeKey]))?.fileSize
        if let statedSize,
           AttachmentPolicy.plan(forMimeType: mimeType, sizeBytes: statedSize) == .reject {
            return .tooLarge(filename: filename, sizeBytes: statedSize)
        }

        let cap = AttachmentPolicy.readCap(forMimeType: mimeType)
        guard let read = readUpTo(cap: cap, url: fileURL) else {
            return .unreadable(filename: filename)
        }
        if read.overflowed {
            return .tooLarge(filename: filename, sizeBytes: statedSize ?? cap)
        }
        return prepareBytes(filename: filename, mimeType: mimeType, original: read.bytes)
    }

    // MARK: - Naming helpers (used by the picker UI)

    /// Filename + MIME for a photo-picker item, derived from its content
    /// type (the picker does not expose original filenames).
    static func photoFilename(for type: UTType?) -> (filename: String, mimeType: String) {
        let mime = type?.preferredMIMEType ?? "image/jpeg"
        let ext = type?.preferredFilenameExtension ?? "jpg"
        return ("photo-\(timestamp()).\(ext)", mime)
    }

    /// Filename for a fresh camera capture (always JPEG-encoded by us).
    static func cameraFilename() -> String {
        "camera-\(timestamp()).jpg"
    }

    private static func timestamp() -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        return formatter.string(from: Date())
    }

    private static func mimeType(forFilename filename: String) -> String {
        let ext = (filename as NSString).pathExtension
        guard !ext.isEmpty,
              let type = UTType(filenameExtension: ext.lowercased()),
              let mime = type.preferredMIMEType else {
            return "application/octet-stream"
        }
        return mime
    }

    // MARK: - Capped read

    private struct CappedRead {
        let bytes: Data
        let overflowed: Bool
    }

    /// Read the full file, or stop with `overflowed` once `cap` bytes are
    /// exceeded (64 KB chunks, Android `readUpTo` twin).
    private static func readUpTo(cap: Int, url: URL) -> CappedRead? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        var out = Data()
        do {
            while true {
                guard let chunk = try handle.read(upToCount: 64 * 1024), !chunk.isEmpty else {
                    break // EOF
                }
                out.append(chunk)
                if out.count > cap {
                    return CappedRead(bytes: Data(), overflowed: true)
                }
            }
        } catch {
            return nil
        }
        return CappedRead(bytes: out, overflowed: false)
    }

    // MARK: - Policy application

    /// Policy application over in-memory bytes (shared by every pick source).
    private static func prepareBytes(filename: String, mimeType: String, original: Data) -> PrepareResult {
        switch AttachmentPolicy.plan(forMimeType: mimeType, sizeBytes: original.count) {
        case .reject:
            return .tooLarge(filename: filename, sizeBytes: original.count)

        case .keepOriginal:
            return .ready(PreparedAttachment(
                filename: filename,
                mimeType: mimeType,
                bytes: original,
                previewBytes: AttachmentPolicy.isImageMime(mimeType) ? thumbnail(original) : nil
            ))

        case .compressImage:
            if let compressed = recompress(original) {
                return .ready(PreparedAttachment(
                    filename: AttachmentPolicy.compressedFilename(filename),
                    mimeType: "image/jpeg",
                    bytes: compressed,
                    previewBytes: thumbnail(compressed)
                ))
            }
            // Undecodable: fall back to the original when it fits the wire
            // cap, reject otherwise (Android parity).
            if original.count <= AttachmentPolicy.maxUploadBytes {
                return .ready(PreparedAttachment(
                    filename: filename,
                    mimeType: mimeType,
                    bytes: original,
                    previewBytes: thumbnail(original)
                ))
            }
            return .tooLarge(filename: filename, sizeBytes: original.count)
        }
    }

    /// Downscale to ≤ `maxImageDimension` px JPEG, or nil when undecodable /
    /// still too big.
    private static func recompress(_ original: Data) -> Data? {
        guard let encoded = encodeScaledJPEG(
            original,
            maxDimension: AttachmentPolicy.maxImageDimension,
            quality: AttachmentPolicy.compressJPEGQuality
        ) else {
            return nil
        }
        // Belt-and-braces: a 2048 px JPEG is always far under 50 MB, but the
        // wire cap is a hard contract.
        return encoded.count <= AttachmentPolicy.maxUploadBytes ? encoded : nil
    }

    /// Chip/bubble thumbnail (also the wire `previewUrl` payload); nil when
    /// undecodable.
    static func thumbnail(_ imageBytes: Data) -> Data? {
        encodeScaledJPEG(
            imageBytes,
            maxDimension: AttachmentPolicy.previewMaxDimension,
            quality: AttachmentPolicy.previewJPEGQuality
        )
    }

    // MARK: - ImageIO

    /// Decode + downscale (longest edge ≤ `maxDimension`, EXIF orientation
    /// applied) + JPEG-encode. Nil when the bytes are not a decodable image.
    static func encodeScaledJPEG(_ source: Data, maxDimension: Int, quality: Double) -> Data? {
        guard let imageSource = CGImageSourceCreateWithData(source as CFData, nil),
              CGImageSourceGetCount(imageSource) > 0 else {
            return nil
        }
        let thumbnailOptions: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxDimension,
        ]
        guard let scaled = CGImageSourceCreateThumbnailAtIndex(
            imageSource,
            0,
            thumbnailOptions as CFDictionary
        ) else {
            return nil
        }
        let out = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            out as CFMutableData,
            UTType.jpeg.identifier as CFString,
            1,
            nil
        ) else {
            return nil
        }
        let encodeOptions: [CFString: Any] = [
            kCGImageDestinationLossyCompressionQuality: quality,
        ]
        CGImageDestinationAddImage(destination, scaled, encodeOptions as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return out as Data
    }

    /// Downscale-only decode for rendering `previewUrl` payloads (bubble
    /// thumbnails). Web-authored previews embed the full original (up to
    /// 5 MB), so the decode clamps to `maxDimension` and should be called off
    /// the main actor.
    static func decodeDownsampled(_ bytes: Data, maxDimension: Int) -> CGImage? {
        guard let imageSource = CGImageSourceCreateWithData(bytes as CFData, nil),
              CGImageSourceGetCount(imageSource) > 0 else {
            return nil
        }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxDimension,
        ]
        return CGImageSourceCreateThumbnailAtIndex(imageSource, 0, options as CFDictionary)
    }
}

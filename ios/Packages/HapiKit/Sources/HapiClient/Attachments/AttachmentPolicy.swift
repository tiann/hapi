import Foundation

/// Pure sizing/compression policy for composer attachments (A-M3f) — no
/// UIKit/ImageIO types, so every decision runs under `swift test` on macOS.
/// Port of the Android `AttachmentPolicy` (B-M3f); constants and decisions
/// are kept verbatim so the two mobile clients behave identically.
///
/// Wire contract (`rest.md` uploads): `POST /api/sessions/:id/upload` is
/// JSON + base64 with a hard 50 MB decoded limit. The web sends originals
/// (`attachmentAdapter.ts`); on mobile data that is hostile for camera
/// photos, so images above ``imageCompressThresholdBytes`` are downscaled to
/// ``maxImageDimension`` px and re-encoded as JPEG (``compressJPEGQuality``)
/// before upload. Non-image files always keep their original bytes.
public enum AttachmentPolicy {

    /// Hub upload ceiling (decoded bytes) — `MAX_UPLOAD_BYTES` on the web.
    public static let maxUploadBytes = 50 * 1024 * 1024

    /// Images larger than this get downscaled + JPEG-recompressed.
    public static let imageCompressThresholdBytes = 4 * 1024 * 1024

    /// Longest edge after downscaling.
    public static let maxImageDimension = 2048

    /// JPEG quality for recompressed uploads (Android: 85/100).
    public static let compressJPEGQuality = 0.85

    /// Longest edge of the thumbnail embedded as `AttachmentMetadata.previewUrl`
    /// (a JPEG data URL). The web embeds the full original (≤ 5 MB) there; a
    /// small thumb keeps `SendMessageRequest` bodies tiny while still giving
    /// every client (web included) something to render in the user bubble.
    public static let previewMaxDimension = 512

    /// JPEG quality for the embedded preview thumbnail (Android: 80/100).
    public static let previewJPEGQuality = 0.80

    /// Heap guard for reading picked content whose provider reports no size:
    /// recompressible images may legitimately exceed 50 MB pre-compression,
    /// everything else stops at the wire cap (see ``readCap(forMimeType:)``).
    public static let maxImageSourceBytes = 192 * 1024 * 1024

    /// Formats that are safe to decode + re-encode as a still JPEG. GIFs are
    /// excluded (recompression would drop animation) and SVG/unknown types
    /// are not bitmap-decodable — those upload as originals or get rejected.
    private static let recompressibleImageMimes: Set<String> = [
        "image/jpeg",
        "image/jpg",
        "image/png",
        "image/webp",
        "image/heic",
        "image/heif",
    ]

    /// What the preparer should do with a picked file.
    public enum Plan: Equatable, Sendable {
        /// Upload the original bytes untouched.
        case keepOriginal

        /// Downscale to ``maxImageDimension`` + JPEG-recompress, then upload.
        case compressImage

        /// Over the 50 MB wire cap and not recoverable by compression.
        case reject
    }

    /// Decide the handling for a file of `mimeType` and `sizeBytes`.
    ///
    /// Recompressible images over the threshold are compressed even when the
    /// original exceeds 50 MB — downscaling brings any camera photo far under
    /// the cap (the post-compression size is re-checked by the preparer).
    public static func plan(forMimeType mimeType: String, sizeBytes: Int) -> Plan {
        if isRecompressibleImageMime(mimeType), sizeBytes > imageCompressThresholdBytes {
            return .compressImage
        }
        if sizeBytes > maxUploadBytes {
            return .reject
        }
        return .keepOriginal
    }

    /// How many bytes to read at most before giving up on a pick as too large.
    public static func readCap(forMimeType mimeType: String) -> Int {
        isRecompressibleImageMime(mimeType) ? maxImageSourceBytes : maxUploadBytes
    }

    public static func isImageMime(_ mimeType: String) -> Bool {
        mimeType.hasPrefix("image/")
    }

    public static func isRecompressibleImageMime(_ mimeType: String) -> Bool {
        recompressibleImageMimes.contains(mimeType.lowercased())
    }

    // The Android policy also carries `sampleSizeFor` (a BitmapFactory
    // `inSampleSize` helper); iOS downscales through ImageIO's
    // `kCGImageSourceThumbnailMaxPixelSize`, which takes the target edge
    // directly, so no power-of-two step exists here.

    /// Final (width, height) with the longest edge clamped to `maxDimension`
    /// (aspect preserved, degenerate edges never collapse below 1).
    public static func scaledDimensions(
        width: Int,
        height: Int,
        maxDimension: Int
    ) -> (width: Int, height: Int) {
        let longest = max(width, height)
        if longest <= maxDimension || longest <= 0 {
            return (width, height)
        }
        let scale = Double(maxDimension) / Double(longest)
        let w = max(Int(Double(width) * scale), 1)
        let h = max(Int(Double(height) * scale), 1)
        return (w, h)
    }

    /// Recompression re-encodes as JPEG, so the advertised filename swaps its
    /// extension to `.jpg` (a `shot.png` upload that is actually JPEG bytes
    /// would confuse the agent reading it from disk).
    public static func compressedFilename(_ original: String) -> String {
        guard let dot = original.lastIndex(of: "."), dot != original.startIndex else {
            return "\(original).jpg"
        }
        return "\(original[original.startIndex..<dot]).jpg"
    }

    /// `data:<mime>;base64,<...>` — the wire `previewUrl` format (web parity).
    public static func dataUrl(mimeType: String, bytes: Data) -> String {
        "data:\(mimeType);base64,\(bytes.base64EncodedString())"
    }

    /// The base64 payload of a data URL, or nil when `url` is not one.
    /// Accepts any `data:*;base64,` head — web previews are `data:image/png`
    /// etc., mobile-authored ones are always JPEG.
    public static func base64FromDataUrl(_ url: String) -> String? {
        guard url.hasPrefix("data:") else { return nil }
        guard let comma = url.firstIndex(of: ",") else { return nil }
        guard url[url.startIndex..<comma].hasSuffix(";base64") else { return nil }
        let payload = String(url[url.index(after: comma)...])
        return payload.isEmpty ? nil : payload
    }

    /// Decoded bytes of a base64 data URL, or nil when unparseable.
    public static func bytesFromDataUrl(_ url: String) -> Data? {
        guard let base64 = base64FromDataUrl(url) else { return nil }
        return Data(base64Encoded: base64)
    }
}

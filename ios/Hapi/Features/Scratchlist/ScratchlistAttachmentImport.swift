import Foundation
import HapiClient
import HapiProtocol
import ImageIO
import UIKit

/// Executes `ScratchlistAttachmentGuard` verdicts for a picked photo (A-M4b),
/// the iOS twin of the Android `ContentResolverAttachmentImporter`: pure
/// limit decisions live in the guard (tested in HapiKit); this layer only
/// runs them with image plumbing — sampled decode, then JPEG quality steps,
/// then dimension halving until the verdict's byte target fits.
enum ScratchlistAttachmentImport {
    struct Prepared: Sendable {
        let filename: String
        let data: Data
        let mimeType: String
    }

    enum Outcome: Sendable {
        case ready(Prepared)
        case rejected(message: String)
    }

    /// Decode budget before quality stepping (the Android importer's
    /// 2048×2048 ≈ 4K-screen worth of pixels; ImageIO caps the longer side).
    private static let maxDecodeDimension = 2048
    private static let minDimension: CGFloat = 64
    private static let qualitySteps: [CGFloat] = [0.9, 0.8, 0.7, 0.6, 0.5]

    static func prepare(
        data: Data,
        filename: String,
        mimeType: String,
        existing: [ScratchlistAttachment],
        limits: ScratchlistAttachmentLimits
    ) -> Outcome {
        var data = data
        var mimeType = mimeType
        var filename = filename
        // iOS divergence from the Android importer: PhotosPicker commonly
        // hands back HEIC, which the hub's allow-list rejects — transcode
        // any decodable but disallowed raster image to JPEG before the guard
        // so camera-roll photos work at all.
        if !limits.allowedMimeTypes.contains(mimeType),
           mimeType.hasPrefix("image/"),
           let image = UIImage(data: data),
           let jpeg = image.jpegData(compressionQuality: 0.9) {
            data = jpeg
            mimeType = "image/jpeg"
            filename = jpegName(filename)
        }

        switch ScratchlistAttachmentGuard.evaluate(
            sizeBytes: data.count,
            mimeType: mimeType,
            existing: existing,
            limits: limits
        ) {
        case .fits:
            return .ready(Prepared(filename: filename, data: data, mimeType: mimeType))
        case .downscale(let targetBytes):
            guard let compressed = downscaleToJPEG(data, targetBytes: targetBytes) else {
                return .rejected(message: String(localized: "Image is too large even after compression"))
            }
            return .ready(Prepared(filename: jpegName(filename), data: compressed, mimeType: "image/jpeg"))
        case .reject(let reason):
            return .rejected(message: rejectionMessage(reason, limits: limits))
        }
    }

    static func jpegName(_ original: String) -> String {
        let stem: String
        if let dot = original.lastIndex(of: "."), dot != original.startIndex {
            stem = String(original[..<dot])
        } else {
            stem = original
        }
        let trimmed = stem.trimmingCharacters(in: .whitespaces)
        return (trimmed.isEmpty ? "photo" : trimmed) + ".jpg"
    }

    static func rejectionMessage(
        _ reason: ScratchlistAttachmentGuard.Reason,
        limits: ScratchlistAttachmentLimits
    ) -> String {
        switch reason {
        case .tooManyForEntry:
            return String(
                format: String(localized: "A note can hold at most %lld attachments"),
                Int64(limits.maxAttachmentsPerEntry)
            )
        case .mimeNotAllowed:
            return String(localized: "That file type isn't allowed for scratchlist attachments")
        case .tooLarge:
            return String(
                format: String(localized: "That file is over the %lld MB limit"),
                Int64(limits.maxBytesPerFile / (1024 * 1024))
            )
        case .entryBudgetExhausted:
            return String(localized: "This note's attachment budget is used up")
        }
    }

    /// Re-encode `source` as JPEG under `targetBytes`: sampled decode, then
    /// quality steps, then dimension halving — nil when even a tiny re-encode
    /// stays over budget (pathological targets).
    static func downscaleToJPEG(_ source: Data, targetBytes: Int) -> Data? {
        guard let imageSource = CGImageSourceCreateWithData(source as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxDecodeDimension,
        ]
        guard let cgImage = CGImageSourceCreateThumbnailAtIndex(imageSource, 0, options as CFDictionary) else {
            return nil
        }
        var image = UIImage(cgImage: cgImage)
        while true {
            for quality in qualitySteps {
                if let candidate = image.jpegData(compressionQuality: quality),
                   candidate.count <= targetBytes {
                    return candidate
                }
            }
            guard image.size.width > minDimension, image.size.height > minDimension else { return nil }
            let halved = CGSize(
                width: max(image.size.width / 2, 1),
                height: max(image.size.height / 2, 1)
            )
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            image = UIGraphicsImageRenderer(size: halved, format: format).image { _ in
                image.draw(in: CGRect(origin: .zero, size: halved))
            }
        }
    }
}

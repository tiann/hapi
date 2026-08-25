import Foundation
import HapiProtocol

/// Pre-upload limit checks for scratchlist attachments (A-M4b), pure so the
/// decision logic runs under `swift test` — the app layer only executes the
/// verdict (pick → maybe downscale to JPEG → upload). Ported verbatim from
/// the Android `ScratchlistAttachmentGuard`.
///
/// Budgets come from `GET /sessions/:id/scratchlist/limits`
/// (``ScratchlistAttachmentLimits``); the hub re-validates everything
/// server-side, so this guard exists to fail fast and to pick a downscale
/// target instead of shipping megabytes that will 413.
public enum ScratchlistAttachmentGuard {
    /// Raster formats the image pipeline can re-encode smaller.
    static let downscalableMimes: Set<String> = ["image/jpeg", "image/png", "image/webp"]

    public enum Verdict: Equatable, Sendable {
        /// Within every budget — upload the bytes as they are.
        case fits

        /// Over the per-file/per-entry byte budget but re-encodable: compress
        /// to at most `targetBytes` before uploading.
        case downscale(targetBytes: Int)

        case reject(Reason)
    }

    public enum Reason: Equatable, Sendable {
        /// Entry already holds `maxAttachmentsPerEntry` files.
        case tooManyForEntry

        /// Mime type outside `allowedMimeTypes`.
        case mimeNotAllowed

        /// Over budget and not a re-encodable raster image.
        case tooLarge

        /// The entry's byte budget is exhausted — no target left to downscale into.
        case entryBudgetExhausted
    }

    /// Decide what to do with a picked file of `sizeBytes`/`mimeType` joining
    /// an entry that already holds `existing` attachments.
    public static func evaluate(
        sizeBytes: Int,
        mimeType: String,
        existing: [ScratchlistAttachment],
        limits: ScratchlistAttachmentLimits
    ) -> Verdict {
        if existing.count >= limits.maxAttachmentsPerEntry {
            return .reject(.tooManyForEntry)
        }
        if !limits.allowedMimeTypes.contains(mimeType) {
            return .reject(.mimeNotAllowed)
        }
        let entryBudget = limits.maxBytesPerEntry - existing.reduce(0) { $0 + $1.size }
        let budget = min(limits.maxBytesPerFile, entryBudget)
        if budget <= 0 {
            return .reject(.entryBudgetExhausted)
        }
        if sizeBytes <= budget {
            return .fits
        }
        return downscalableMimes.contains(mimeType)
            ? .downscale(targetBytes: budget)
            : .reject(.tooLarge)
    }
}

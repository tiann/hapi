import Foundation
import HapiClient
import HapiProtocol
import Testing

// Transcription of the Android reference suite
// (`ScratchlistAttachmentGuardTest.kt`) against the ported pure guard.

private let guardLimits = ScratchlistAttachmentLimits(
    maxBytesPerFile: 10 * 1024 * 1024,
    maxAttachmentsPerEntry: 4,
    maxBytesPerEntry: 20 * 1024 * 1024,
    maxBytesPerSession: 100 * 1024 * 1024,
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "application/pdf", "text/plain"]
)

private func attachment(_ id: String, size: Int, mimeType: String = "image/jpeg") -> ScratchlistAttachment {
    ScratchlistAttachment(
        id: id,
        filename: "\(id).bin",
        mimeType: mimeType,
        size: size,
        path: "hapi-hub:scratchlist/\(id)"
    )
}

private func evaluate(
    sizeBytes: Int,
    mimeType: String = "image/jpeg",
    existing: [ScratchlistAttachment] = []
) -> ScratchlistAttachmentGuard.Verdict {
    ScratchlistAttachmentGuard.evaluate(
        sizeBytes: sizeBytes,
        mimeType: mimeType,
        existing: existing,
        limits: guardLimits
    )
}

@Suite("ScratchlistAttachmentGuard")
struct ScratchlistAttachmentGuardTests {

    @Test func fileWithinEveryBudgetFitsAsIs() {
        #expect(evaluate(sizeBytes: 5 * 1024 * 1024) == .fits)
    }

    @Test func exactlyThePerFileCapStillFits() {
        #expect(evaluate(sizeBytes: guardLimits.maxBytesPerFile) == .fits)
    }

    @Test func entryAtTheAttachmentCountCapRejectsBeforeAnythingElse() {
        let existing = (1...4).map { attachment("a\($0)", size: 1024) }
        #expect(evaluate(sizeBytes: 10, existing: existing) == .reject(.tooManyForEntry))
    }

    @Test func disallowedMimeTypeRejects() {
        #expect(evaluate(sizeBytes: 10, mimeType: "application/zip") == .reject(.mimeNotAllowed))
    }

    @Test func oversizedRasterImageDownscalesToThePerFileCap() {
        #expect(
            evaluate(sizeBytes: 25 * 1024 * 1024, mimeType: "image/png")
                == .downscale(targetBytes: guardLimits.maxBytesPerFile)
        )
    }

    @Test func remainingEntryByteBudgetConstrainsTheDownscaleTarget() {
        // 20 MB per entry minus 12 MB already attached leaves an 8 MB target
        // (tighter than the 10 MB per-file cap).
        let existing = [attachment("a1", size: 12 * 1024 * 1024)]
        #expect(
            evaluate(sizeBytes: 9 * 1024 * 1024, existing: existing)
                == .downscale(targetBytes: 8 * 1024 * 1024)
        )
    }

    @Test func oversizedNonImageCannotDownscaleAndRejects() {
        #expect(
            evaluate(sizeBytes: 11 * 1024 * 1024, mimeType: "application/pdf")
                == .reject(.tooLarge)
        )
    }

    @Test func svgIsNeverDownscaledNotARasterReencodeTarget() {
        var svgLimits = guardLimits
        svgLimits.allowedMimeTypes.append("image/svg+xml")
        #expect(
            ScratchlistAttachmentGuard.evaluate(
                sizeBytes: 11 * 1024 * 1024,
                mimeType: "image/svg+xml",
                existing: [],
                limits: svgLimits
            ) == .reject(.tooLarge)
        )
    }

    @Test func exhaustedEntryByteBudgetRejectsOutright() {
        let existing = [attachment("a1", size: guardLimits.maxBytesPerEntry)]
        #expect(evaluate(sizeBytes: 10, existing: existing) == .reject(.entryBudgetExhausted))
    }
}

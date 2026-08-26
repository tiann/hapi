package app.hapi.data.store

import app.hapi.protocol.wire.ScratchlistAttachment
import app.hapi.protocol.wire.ScratchlistAttachmentLimits

/**
 * Pre-upload limit checks for scratchlist attachments (B-M4d), pure so the
 * decision logic is JVM-testable — the Android layer only executes the
 * verdict (pick → maybe downscale via Bitmap → upload).
 *
 * Budgets come from `GET /sessions/:id/scratchlist/limits`
 * ([ScratchlistAttachmentLimits]); the hub re-validates everything
 * server-side, so this guard exists to fail fast and to pick a downscale
 * target instead of shipping megabytes that will 413.
 */
object ScratchlistAttachmentGuard {

    /** Raster formats [android.graphics.BitmapFactory] can re-encode smaller. */
    private val DOWNSCALABLE_MIMES = setOf("image/jpeg", "image/png", "image/webp")

    sealed interface Verdict {
        /** Within every budget — upload the bytes as they are. */
        data object Fits : Verdict

        /**
         * Over the per-file/per-entry byte budget but re-encodable: compress
         * to at most [targetBytes] before uploading.
         */
        data class Downscale(val targetBytes: Long) : Verdict

        data class Reject(val reason: Reason) : Verdict
    }

    enum class Reason {
        /** Entry already holds `maxAttachmentsPerEntry` files. */
        TooManyForEntry,

        /** Mime type outside `allowedMimeTypes`. */
        MimeNotAllowed,

        /** Over budget and not a re-encodable raster image. */
        TooLarge,

        /** The entry's byte budget is exhausted — no target left to downscale into. */
        EntryBudgetExhausted,
    }

    /**
     * Decide what to do with a picked file of [sizeBytes]/[mimeType] joining
     * an entry that already holds [existing] attachments.
     */
    fun evaluate(
        sizeBytes: Long,
        mimeType: String,
        existing: List<ScratchlistAttachment>,
        limits: ScratchlistAttachmentLimits,
    ): Verdict {
        if (existing.size >= limits.maxAttachmentsPerEntry) {
            return Verdict.Reject(Reason.TooManyForEntry)
        }
        if (mimeType !in limits.allowedMimeTypes) {
            return Verdict.Reject(Reason.MimeNotAllowed)
        }
        val entryBudget = limits.maxBytesPerEntry - existing.sumOf { it.size }
        val budget = minOf(limits.maxBytesPerFile, entryBudget)
        if (budget <= 0) {
            return Verdict.Reject(Reason.EntryBudgetExhausted)
        }
        if (sizeBytes <= budget) {
            return Verdict.Fits
        }
        return if (mimeType in DOWNSCALABLE_MIMES) {
            Verdict.Downscale(targetBytes = budget)
        } else {
            Verdict.Reject(Reason.TooLarge)
        }
    }
}

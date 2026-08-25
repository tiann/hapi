package app.hapi.data.store

import app.hapi.data.store.ScratchlistAttachmentGuard.Reason
import app.hapi.data.store.ScratchlistAttachmentGuard.Verdict
import app.hapi.protocol.wire.ScratchlistAttachment
import app.hapi.protocol.wire.ScratchlistAttachmentLimits
import kotlin.test.Test
import kotlin.test.assertEquals

class ScratchlistAttachmentGuardTest {

    private val limits = ScratchlistAttachmentLimits(
        maxBytesPerFile = 10L * 1024 * 1024,
        maxAttachmentsPerEntry = 4,
        maxBytesPerEntry = 20L * 1024 * 1024,
        maxBytesPerSession = 100L * 1024 * 1024,
        allowedMimeTypes = listOf("image/jpeg", "image/png", "image/webp", "application/pdf", "text/plain"),
    )

    private fun attachment(id: String, size: Long, mimeType: String = "image/jpeg") =
        ScratchlistAttachment(
            id = id,
            filename = "$id.bin",
            mimeType = mimeType,
            size = size,
            path = "hapi-hub:scratchlist/$id",
        )

    private fun evaluate(
        sizeBytes: Long,
        mimeType: String = "image/jpeg",
        existing: List<ScratchlistAttachment> = emptyList(),
    ) = ScratchlistAttachmentGuard.evaluate(sizeBytes, mimeType, existing, limits)

    @Test
    fun `file within every budget fits as-is`() {
        assertEquals(Verdict.Fits, evaluate(sizeBytes = 5 * 1024 * 1024))
    }

    @Test
    fun `exactly the per-file cap still fits`() {
        assertEquals(Verdict.Fits, evaluate(sizeBytes = limits.maxBytesPerFile))
    }

    @Test
    fun `entry at the attachment-count cap rejects before anything else`() {
        val existing = (1..4).map { attachment("a$it", 1024) }
        assertEquals(
            Verdict.Reject(Reason.TooManyForEntry),
            evaluate(sizeBytes = 10, existing = existing),
        )
    }

    @Test
    fun `disallowed mime type rejects`() {
        assertEquals(
            Verdict.Reject(Reason.MimeNotAllowed),
            evaluate(sizeBytes = 10, mimeType = "application/zip"),
        )
    }

    @Test
    fun `oversized raster image downscales to the per-file cap`() {
        assertEquals(
            Verdict.Downscale(targetBytes = limits.maxBytesPerFile),
            evaluate(sizeBytes = 25L * 1024 * 1024, mimeType = "image/png"),
        )
    }

    @Test
    fun `remaining entry byte budget constrains the downscale target`() {
        // 20 MB per entry minus 12 MB already attached leaves an 8 MB target
        // (tighter than the 10 MB per-file cap).
        val existing = listOf(attachment("a1", 12L * 1024 * 1024))
        assertEquals(
            Verdict.Downscale(targetBytes = 8L * 1024 * 1024),
            evaluate(sizeBytes = 9L * 1024 * 1024, existing = existing),
        )
    }

    @Test
    fun `oversized non-image cannot downscale and rejects`() {
        assertEquals(
            Verdict.Reject(Reason.TooLarge),
            evaluate(sizeBytes = 11L * 1024 * 1024, mimeType = "application/pdf"),
        )
    }

    @Test
    fun `svg is never downscaled (not a raster re-encode target)`() {
        val svgLimits = limits.copy(allowedMimeTypes = limits.allowedMimeTypes + "image/svg+xml")
        assertEquals(
            Verdict.Reject(Reason.TooLarge),
            ScratchlistAttachmentGuard.evaluate(11L * 1024 * 1024, "image/svg+xml", emptyList(), svgLimits),
        )
    }

    @Test
    fun `exhausted entry byte budget rejects outright`() {
        val existing = listOf(attachment("a1", limits.maxBytesPerEntry))
        assertEquals(
            Verdict.Reject(Reason.EntryBudgetExhausted),
            evaluate(sizeBytes = 10, existing = existing),
        )
    }
}

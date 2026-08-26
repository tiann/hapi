package app.hapi.companion.feature.scratchlist

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import app.hapi.data.store.ScratchlistAttachmentGuard
import app.hapi.protocol.wire.ScratchlistAttachment
import app.hapi.protocol.wire.ScratchlistAttachmentLimits
import java.io.ByteArrayOutputStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Production [ScratchlistAttachmentImporter]: reads the picked content URI,
 * runs [ScratchlistAttachmentGuard] against the hub budgets, and downscales
 * oversized raster images to JPEG (halving dimensions / stepping quality until
 * the verdict's byte target fits). Pure limit decisions live in the guard
 * (JVM-tested); this class only executes them with Android bitmap plumbing.
 */
class ContentResolverAttachmentImporter(
    private val context: Context,
) : ScratchlistAttachmentImporter {

    override suspend fun import(
        uri: Uri,
        limits: ScratchlistAttachmentLimits,
        existing: List<ScratchlistAttachment>,
    ): ScratchlistImportOutcome = withContext(Dispatchers.IO) {
        val resolver = context.contentResolver
        val mimeType = resolver.getType(uri) ?: "application/octet-stream"
        val bytes = try {
            resolver.openInputStream(uri)?.use { it.readBytes() }
        } catch (_: Exception) {
            null
        } ?: return@withContext ScratchlistImportOutcome.Rejected(ScratchlistImportRejection.Unreadable)

        val filename = displayNameOf(uri) ?: fallbackName(mimeType)

        when (val verdict = ScratchlistAttachmentGuard.evaluate(bytes.size.toLong(), mimeType, existing, limits)) {
            ScratchlistAttachmentGuard.Verdict.Fits ->
                ScratchlistImportOutcome.Ready(PreparedScratchlistAttachment(filename, bytes, mimeType))

            is ScratchlistAttachmentGuard.Verdict.Downscale -> {
                val compressed = downscaleToJpeg(bytes, verdict.targetBytes)
                if (compressed == null) {
                    ScratchlistImportOutcome.Rejected(ScratchlistImportRejection.ImageTooLarge)
                } else {
                    ScratchlistImportOutcome.Ready(
                        PreparedScratchlistAttachment(jpegName(filename), compressed, "image/jpeg")
                    )
                }
            }

            is ScratchlistAttachmentGuard.Verdict.Reject ->
                ScratchlistImportOutcome.Rejected(rejectionOf(verdict.reason, limits))
        }
    }

    private fun displayNameOf(uri: Uri): String? = try {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use { cursor ->
                val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (index >= 0 && cursor.moveToFirst()) cursor.getString(index) else null
            }
    } catch (_: Exception) {
        null
    }?.takeIf { it.isNotBlank() }

    private companion object {
        /** Decode budget before quality stepping (≈ 4K-screen worth of pixels). */
        const val MAX_DECODE_PIXELS = 2048 * 2048
        const val MIN_DIMENSION = 64
        val QUALITY_STEPS = intArrayOf(90, 80, 70, 60, 50)

        fun fallbackName(mimeType: String): String = when {
            mimeType.startsWith("image/") -> "photo-${System.currentTimeMillis()}.${mimeType.substringAfter('/')}"
            else -> "attachment-${System.currentTimeMillis()}"
        }

        fun jpegName(original: String): String =
            original.substringBeforeLast('.', original).ifBlank { "photo" } + ".jpg"

        fun rejectionOf(
            reason: ScratchlistAttachmentGuard.Reason,
            limits: ScratchlistAttachmentLimits,
        ): ScratchlistImportRejection = when (reason) {
            ScratchlistAttachmentGuard.Reason.TooManyForEntry ->
                ScratchlistImportRejection.TooManyAttachments(limits.maxAttachmentsPerEntry)
            ScratchlistAttachmentGuard.Reason.MimeNotAllowed ->
                ScratchlistImportRejection.FileTypeNotAllowed
            ScratchlistAttachmentGuard.Reason.TooLarge ->
                ScratchlistImportRejection.FileTooLarge(limits.maxBytesPerFile / (1024 * 1024))
            ScratchlistAttachmentGuard.Reason.EntryBudgetExhausted ->
                ScratchlistImportRejection.BudgetExhausted
        }

        /**
         * Re-encode [source] as JPEG under [targetBytes]: sampled decode, then
         * quality steps, then dimension halving — null when even a tiny
         * re-encode stays over budget (pathological targets).
         */
        fun downscaleToJpeg(source: ByteArray, targetBytes: Long): ByteArray? {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(source, 0, source.size, bounds)
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null

            var sampleSize = 1
            while (
                (bounds.outWidth / sampleSize).toLong() * (bounds.outHeight / sampleSize) > MAX_DECODE_PIXELS
            ) {
                sampleSize *= 2
            }
            var bitmap = BitmapFactory.decodeByteArray(
                source,
                0,
                source.size,
                BitmapFactory.Options().apply { inSampleSize = sampleSize },
            ) ?: return null

            try {
                while (true) {
                    for (quality in QUALITY_STEPS) {
                        val out = ByteArrayOutputStream()
                        bitmap.compress(Bitmap.CompressFormat.JPEG, quality, out)
                        val candidate = out.toByteArray()
                        if (candidate.size <= targetBytes) return candidate
                    }
                    if (bitmap.width <= MIN_DIMENSION || bitmap.height <= MIN_DIMENSION) return null
                    val halved = Bitmap.createScaledBitmap(
                        bitmap,
                        (bitmap.width / 2).coerceAtLeast(1),
                        (bitmap.height / 2).coerceAtLeast(1),
                        true,
                    )
                    if (halved !== bitmap) bitmap.recycle()
                    bitmap = halved
                }
            } finally {
                bitmap.recycle()
            }
        }
    }
}

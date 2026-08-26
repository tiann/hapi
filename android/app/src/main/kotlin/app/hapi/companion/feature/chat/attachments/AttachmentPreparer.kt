package app.hapi.companion.feature.chat.attachments

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Outcome of preparing one picked/captured file for upload. */
sealed interface PrepareResult {
    data class Ready(val attachment: PreparedAttachment) : PrepareResult

    /** Over the 50 MB wire cap (and not recoverable by image compression). */
    data class TooLarge(val filename: String, val sizeBytes: Long) : PrepareResult

    /** The content provider would not give us the bytes. */
    data class Unreadable(val filename: String) : PrepareResult
}

/**
 * A pending camera capture: the FileProvider [uri] handed to the camera app +
 * its backing [file] ([file] is exposed so the screen can `rememberSaveable`
 * the pending capture across rotation/process death while the camera is open).
 */
class CameraCapture(val uri: Uri, val file: File) {
    /** Delete the cache-file scratch once the capture was ingested (or abandoned). */
    fun discard() {
        runCatching { file.delete() }
    }
}

/**
 * Reads picked content into [PreparedAttachment]s ready for
 * [ComposerAttachments.add] (B-M3f). All policy decisions live in the pure
 * [AttachmentPolicy]; this class supplies the Android parts: ContentResolver
 * metadata + bytes, `BitmapFactory` downscaling, JPEG re-encode, thumbnail
 * generation, and the FileProvider scratch file for `TakePicture`.
 *
 * Compression stance (differs from web, which uploads originals): images over
 * [AttachmentPolicy.IMAGE_COMPRESS_THRESHOLD_BYTES] are downscaled to
 * [AttachmentPolicy.MAX_IMAGE_DIMENSION] px JPEG — phone photos are 5–15 MB
 * of mostly-wasted agent context on mobile data. Non-image files always keep
 * their original bytes; anything still over 50 MB is rejected.
 */
class AttachmentPreparer(
    context: Context,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
    private val appContext = context.applicationContext

    suspend fun prepare(uri: Uri): PrepareResult = withContext(ioDispatcher) {
        val resolver = appContext.contentResolver

        var displayName: String? = null
        var statedSize: Long? = null
        runCatching {
            resolver.query(uri, null, null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (nameIndex >= 0 && !cursor.isNull(nameIndex)) displayName = cursor.getString(nameIndex)
                    val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                    if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) statedSize = cursor.getLong(sizeIndex)
                }
            }
        }

        val mimeType = resolver.getType(uri)
            ?: displayName?.let { guessMimeFromName(it) }
            ?: "application/octet-stream"
        val filename = displayName ?: fallbackFilename(mimeType)

        // Reject before reading when the provider already told us it's hopeless.
        statedSize?.let { size ->
            if (AttachmentPolicy.planFor(mimeType, size) == AttachmentPolicy.Plan.Reject) {
                return@withContext PrepareResult.TooLarge(filename, size)
            }
        }

        // Providers may report no size — read behind a capped stream so a
        // surprise multi-GB pick cannot OOM the process.
        val readCap = AttachmentPolicy.readCapFor(mimeType)
        val original = try {
            resolver.openInputStream(uri)?.use { readUpTo(it, readCap) }
        } catch (_: Exception) {
            return@withContext PrepareResult.Unreadable(filename)
        } catch (_: OutOfMemoryError) {
            return@withContext PrepareResult.Unreadable(filename)
        } ?: return@withContext PrepareResult.Unreadable(filename)

        if (original.overflowed) {
            return@withContext PrepareResult.TooLarge(filename, statedSize ?: readCap)
        }
        prepareBytes(filename, mimeType, original.bytes)
    }

    private class CappedRead(val bytes: ByteArray, val overflowed: Boolean)

    /** Read the full stream, or stop with `overflowed` once [cap] bytes are exceeded. */
    private fun readUpTo(stream: InputStream, cap: Long): CappedRead {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(64 * 1024)
        var total = 0L
        while (true) {
            val read = stream.read(buffer)
            if (read < 0) break
            total += read
            if (total > cap) return CappedRead(ByteArray(0), overflowed = true)
            out.write(buffer, 0, read)
        }
        return CappedRead(out.toByteArray(), overflowed = false)
    }

    /** Policy application over in-memory bytes (shared by every pick source). */
    private fun prepareBytes(filename: String, mimeType: String, original: ByteArray): PrepareResult {
        val id = "att-${UUID.randomUUID()}"
        return when (AttachmentPolicy.planFor(mimeType, original.size.toLong())) {
            AttachmentPolicy.Plan.Reject -> PrepareResult.TooLarge(filename, original.size.toLong())

            AttachmentPolicy.Plan.KeepOriginal -> PrepareResult.Ready(
                PreparedAttachment(
                    id = id,
                    filename = filename,
                    mimeType = mimeType,
                    bytes = original,
                    previewBytes = if (AttachmentPolicy.isImageMime(mimeType)) thumbnail(original) else null,
                ),
            )

            AttachmentPolicy.Plan.CompressImage -> {
                val compressed = recompress(original)
                when {
                    compressed != null -> PrepareResult.Ready(
                        PreparedAttachment(
                            id = id,
                            filename = AttachmentPolicy.compressedFilename(filename),
                            mimeType = "image/jpeg",
                            bytes = compressed,
                            previewBytes = thumbnail(compressed),
                        ),
                    )
                    // Undecodable (e.g. HEIC on API 26/27): fall back to the
                    // original when it fits the wire cap, reject otherwise.
                    original.size <= AttachmentPolicy.MAX_UPLOAD_BYTES -> PrepareResult.Ready(
                        PreparedAttachment(
                            id = id,
                            filename = filename,
                            mimeType = mimeType,
                            bytes = original,
                            previewBytes = thumbnail(original),
                        ),
                    )
                    else -> PrepareResult.TooLarge(filename, original.size.toLong())
                }
            }
        }
    }

    /** Downscale to ≤ [AttachmentPolicy.MAX_IMAGE_DIMENSION] px JPEG, or null when undecodable/still too big. */
    private fun recompress(original: ByteArray): ByteArray? {
        val encoded = encodeScaledJpeg(
            original,
            AttachmentPolicy.MAX_IMAGE_DIMENSION,
            AttachmentPolicy.COMPRESS_JPEG_QUALITY,
        ) ?: return null
        // Belt-and-braces: a 2048px JPEG is always far under 50 MB, but the
        // wire cap is a hard contract.
        return encoded.takeIf { it.size <= AttachmentPolicy.MAX_UPLOAD_BYTES }
    }

    /** Chip/bubble thumbnail (also the wire `previewUrl` payload); null when undecodable. */
    private fun thumbnail(imageBytes: ByteArray): ByteArray? = encodeScaledJpeg(
        imageBytes,
        AttachmentPolicy.PREVIEW_MAX_DIMENSION,
        AttachmentPolicy.PREVIEW_JPEG_QUALITY,
    )

    private fun encodeScaledJpeg(source: ByteArray, maxDimension: Int, quality: Int): ByteArray? {
        try {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(source, 0, source.size, bounds)
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null

            val options = BitmapFactory.Options().apply {
                inSampleSize = AttachmentPolicy.sampleSizeFor(bounds.outWidth, bounds.outHeight, maxDimension)
            }
            val decoded = BitmapFactory.decodeByteArray(source, 0, source.size, options) ?: return null
            val (targetW, targetH) = AttachmentPolicy.scaledDimensions(decoded.width, decoded.height, maxDimension)
            val scaled = if (targetW != decoded.width || targetH != decoded.height) {
                Bitmap.createScaledBitmap(decoded, targetW, targetH, true).also {
                    if (it !== decoded) decoded.recycle()
                }
            } else {
                decoded
            }
            val out = ByteArrayOutputStream()
            val ok = scaled.compress(Bitmap.CompressFormat.JPEG, quality, out)
            scaled.recycle()
            return if (ok) out.toByteArray() else null
        } catch (_: Exception) {
            return null
        } catch (_: OutOfMemoryError) {
            return null
        }
    }

    // ------------------------------------------------------------- camera --

    /**
     * Scratch target for `ActivityResultContracts.TakePicture`: a cache file
     * under `cache/attachments/` exposed through the app's FileProvider
     * (authority `<applicationId>.attachments`, `attachment_file_paths.xml`).
     * Call [CameraCapture.discard] after ingesting (or on cancel) — captures
     * never persist past the pick.
     */
    fun newCameraCapture(): CameraCapture {
        val dir = File(appContext.cacheDir, "attachments").apply { mkdirs() }
        val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
        val file = File(dir, "camera-$stamp.jpg")
        val uri = FileProvider.getUriForFile(appContext, "${appContext.packageName}.attachments", file)
        return CameraCapture(uri, file)
    }

    private fun guessMimeFromName(name: String): String? {
        val extension = name.substringAfterLast('.', "").lowercase(Locale.US)
        if (extension.isEmpty()) return null
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)
    }

    private fun fallbackFilename(mimeType: String): String {
        val extension = MimeTypeMap.getSingleton().getExtensionFromMimeType(mimeType)
        val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
        return if (extension != null) "attachment-$stamp.$extension" else "attachment-$stamp"
    }
}

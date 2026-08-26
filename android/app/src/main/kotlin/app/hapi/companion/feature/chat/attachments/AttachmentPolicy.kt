package app.hapi.companion.feature.chat.attachments

import java.util.Base64

/**
 * Pure sizing/compression policy for composer attachments (B-M3f) — no
 * Android types, so every decision is JVM-testable.
 *
 * Wire contract (`rest.md` uploads): `POST /api/sessions/:id/upload` is
 * JSON + base64 with a hard 50 MB decoded limit. The web sends originals
 * (`attachmentAdapter.ts`); on mobile data that is hostile for camera
 * photos, so images above [IMAGE_COMPRESS_THRESHOLD_BYTES] are downscaled
 * to [MAX_IMAGE_DIMENSION] px and re-encoded as JPEG ([COMPRESS_JPEG_QUALITY])
 * before upload. Non-image files always keep their original bytes.
 */
object AttachmentPolicy {

    /** Hub upload ceiling (decoded bytes) — `MAX_UPLOAD_BYTES` on the web. */
    const val MAX_UPLOAD_BYTES: Long = 50L * 1024 * 1024

    /** Images larger than this get downscaled + JPEG-recompressed. */
    const val IMAGE_COMPRESS_THRESHOLD_BYTES: Long = 4L * 1024 * 1024

    /** Longest edge after downscaling. */
    const val MAX_IMAGE_DIMENSION: Int = 2048

    /** JPEG quality for recompressed uploads. */
    const val COMPRESS_JPEG_QUALITY: Int = 85

    /**
     * Longest edge of the thumbnail embedded as `AttachmentMetadata.previewUrl`
     * (a JPEG data URL). The web embeds the full original (≤ 5 MB) there; a
     * small thumb keeps `SendMessageRequest` bodies tiny while still giving
     * every client (web included) something to render in the user bubble.
     */
    const val PREVIEW_MAX_DIMENSION: Int = 512

    /** JPEG quality for the embedded preview thumbnail. */
    const val PREVIEW_JPEG_QUALITY: Int = 80

    /**
     * Heap guard for reading picked content whose provider reports no size:
     * recompressible images may legitimately exceed 50 MB pre-compression,
     * everything else stops at the wire cap (see [readCapFor]).
     */
    const val MAX_IMAGE_SOURCE_BYTES: Long = 192L * 1024 * 1024

    /**
     * Formats that are safe to decode + re-encode as a still JPEG. GIFs are
     * excluded (recompression would drop animation) and SVG/unknown types
     * are not bitmap-decodable — those upload as originals or get rejected.
     */
    private val RECOMPRESSIBLE_IMAGE_MIMES = setOf(
        "image/jpeg",
        "image/jpg",
        "image/png",
        "image/webp",
        "image/heic",
        "image/heif",
    )

    /** What the preparer should do with a picked file. */
    sealed interface Plan {
        /** Upload the original bytes untouched. */
        data object KeepOriginal : Plan

        /** Downscale to [MAX_IMAGE_DIMENSION] + JPEG-recompress, then upload. */
        data object CompressImage : Plan

        /** Over the 50 MB wire cap and not recoverable by compression. */
        data object Reject : Plan
    }

    /**
     * Decide the handling for a file of [mimeType] and [sizeBytes].
     *
     * Recompressible images over the threshold are compressed even when the
     * original exceeds 50 MB — downscaling brings any camera photo far under
     * the cap (the post-compression size is re-checked by the preparer).
     */
    fun planFor(mimeType: String, sizeBytes: Long): Plan = when {
        isRecompressibleImageMime(mimeType) && sizeBytes > IMAGE_COMPRESS_THRESHOLD_BYTES ->
            Plan.CompressImage
        sizeBytes > MAX_UPLOAD_BYTES -> Plan.Reject
        else -> Plan.KeepOriginal
    }

    /** How many bytes to read at most before giving up on a pick as too large. */
    fun readCapFor(mimeType: String): Long =
        if (isRecompressibleImageMime(mimeType)) MAX_IMAGE_SOURCE_BYTES else MAX_UPLOAD_BYTES

    fun isImageMime(mimeType: String): Boolean = mimeType.startsWith("image/")

    fun isRecompressibleImageMime(mimeType: String): Boolean =
        mimeType.lowercase() in RECOMPRESSIBLE_IMAGE_MIMES

    /**
     * Power-of-two `BitmapFactory.Options.inSampleSize` so the decoded bitmap
     * is the smallest one whose longest edge is still ≥ [maxDimension]
     * (exact scaling happens after decode via [scaledDimensions]).
     */
    fun sampleSizeFor(width: Int, height: Int, maxDimension: Int): Int {
        if (width <= 0 || height <= 0) return 1
        var sample = 1
        val longest = maxOf(width, height)
        while (longest / (sample * 2) >= maxDimension) {
            sample *= 2
        }
        return sample
    }

    /** Final (width, height) with the longest edge clamped to [maxDimension]. */
    fun scaledDimensions(width: Int, height: Int, maxDimension: Int): Pair<Int, Int> {
        val longest = maxOf(width, height)
        if (longest <= maxDimension || longest <= 0) return width to height
        val scale = maxDimension.toDouble() / longest
        val w = (width * scale).toInt().coerceAtLeast(1)
        val h = (height * scale).toInt().coerceAtLeast(1)
        return w to h
    }

    /**
     * Recompression re-encodes as JPEG, so the advertised filename swaps its
     * extension to `.jpg` (a `shot.png` upload that is actually JPEG bytes
     * would confuse the agent reading it from disk).
     */
    fun compressedFilename(original: String): String {
        val dot = original.lastIndexOf('.')
        val stem = if (dot > 0) original.substring(0, dot) else original
        return "$stem.jpg"
    }

    /** `data:<mime>;base64,<...>` — the wire `previewUrl` format (web parity). */
    fun dataUrl(mimeType: String, bytes: ByteArray): String =
        "data:$mimeType;base64,${Base64.getEncoder().encodeToString(bytes)}"

    /**
     * The base64 payload of a data URL, or null when [url] is not one.
     * Accepts any `data:*;base64,` head — web previews are `data:image/png`
     * etc., Android-authored ones are always JPEG.
     */
    fun base64FromDataUrl(url: String): String? {
        if (!url.startsWith("data:")) return null
        val comma = url.indexOf(',')
        if (comma < 0) return null
        if (!url.substring(0, comma).endsWith(";base64")) return null
        return url.substring(comma + 1).takeIf { it.isNotEmpty() }
    }

    /** Decoded bytes of a base64 data URL, or null when unparseable. */
    fun bytesFromDataUrl(url: String): ByteArray? {
        val base64 = base64FromDataUrl(url) ?: return null
        return try {
            Base64.getDecoder().decode(base64)
        } catch (_: IllegalArgumentException) {
            null
        }
    }
}

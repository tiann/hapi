package app.hapi.companion.feature.chat.blocks

import app.hapi.companion.R
import java.io.File
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * Client-side routing for generated media blocks — the Kotlin mirror of the
 * web's `generatedInlineMedia.ts` (behavior spec: web report §3 / G3-G4).
 *
 * The wire block is always `generated-image` (same hub endpoint for every
 * mime); the *display* intent is derived locally from the block's mimeType:
 *
 *  - `video/…`            -> [GeneratedMediaKind.VIDEO]
 *  - `audio/…`            -> [GeneratedMediaKind.AUDIO]
 *  - `image/…` or `null`  -> [GeneratedMediaKind.IMAGE] (null keeps the
 *    historical image treatment, matching the web)
 *  - anything else        -> [GeneratedMediaKind.FILE]
 *
 * Prefix checks are literal and case-sensitive, exactly like the web helper:
 * `VIDEO/MP4` routes to FILE there and here.
 */
enum class GeneratedMediaKind { IMAGE, VIDEO, AUDIO, FILE }

fun generatedMediaKind(mimeType: String?): GeneratedMediaKind = when {
    mimeType != null && mimeType.startsWith("video/") -> GeneratedMediaKind.VIDEO
    mimeType != null && mimeType.startsWith("audio/") -> GeneratedMediaKind.AUDIO
    mimeType == null || mimeType.startsWith("image/") -> GeneratedMediaKind.IMAGE
    else -> GeneratedMediaKind.FILE
}

/**
 * Web G4: images load on mount; every other kind "can be tens of MB" and
 * waits for an explicit user intent (the Load / Prepare download button).
 */
val GeneratedMediaKind.loadsOnMount: Boolean
    get() = this == GeneratedMediaKind.IMAGE

/** Label for the card header ("Displayed video" …), web `media.displayed.*`. */
val GeneratedMediaKind.labelRes: Int
    get() = when (this) {
        GeneratedMediaKind.IMAGE -> R.string.media_displayed_image
        GeneratedMediaKind.VIDEO -> R.string.media_displayed_video
        GeneratedMediaKind.AUDIO -> R.string.media_displayed_audio
        GeneratedMediaKind.FILE -> R.string.media_displayed_file
    }

/**
 * Load-gate button label for this kind, or null when it loads on mount
 * (IMAGE shows no button). English values match the web's hardcoded
 * `Load video` / `Load audio` / `Prepare download` verbatim.
 */
val GeneratedMediaKind.loadActionRes: Int?
    get() = when (this) {
        GeneratedMediaKind.IMAGE -> null
        GeneratedMediaKind.VIDEO -> R.string.media_load_video
        GeneratedMediaKind.AUDIO -> R.string.media_load_audio
        GeneratedMediaKind.FILE -> R.string.media_prepare_download
    }

/** Cache directory for downloaded non-image generated media. */
internal fun generatedMediaCacheDirectory(cacheDir: File): File = File(cacheDir, "generated-media")

/**
 * Filesystem-safe cache file name for one generated media blob. The wire
 * `fileName`/`imageId` are untrusted; strip path fragments and unsafe
 * characters, and keep both ids so distinct blobs never collide.
 */
internal fun sanitizedGeneratedMediaFileName(imageId: String, fileName: String): String {
    val base = fileName.substringAfterLast('/').substringAfterLast('\\')
    val safeName = base.filter { it.isLetterOrDigit() || it == '.' || it == '-' || it == '_' }
        .take(96)
        .trim('.', '-', '_')
        .ifEmpty { "media" }
    val safeId = imageId.filter { it.isLetterOrDigit() || it == '-' }.ifEmpty { "id" }
    return "$safeId-$safeName"
}

internal fun generatedMediaCacheFile(cacheDir: File, imageId: String, fileName: String): File =
    File(generatedMediaCacheDirectory(cacheDir), sanitizedGeneratedMediaFileName(imageId, fileName))

/**
 * Downloads a generated media blob to its deterministic cache file and
 * returns it — the byte-fetch counterpart of the web's
 * `api.getGeneratedImageBlob` (same `/generated-images/:id` endpoint, same
 * auth + ETag disk cache via the shared hub image client). Semantics:
 *
 *  - a previously completed file short-circuits (hub content is immutable
 *    and ETagged, so a present file is the 304-equivalent);
 *  - any non-2xx status throws [IOException]`("HTTP <code>")` exactly like
 *    the web's `ApiError("HTTP <status>")`;
 *  - the body is staged in a temp file and atomically renamed, so a failed
 *    download never leaves a partial file behind.
 */
internal suspend fun fetchGeneratedMediaFile(
    client: OkHttpClient,
    url: String,
    cacheDir: File,
    imageId: String,
    fileName: String,
): File = withContext(Dispatchers.IO) {
    val dest = generatedMediaCacheFile(cacheDir, imageId, fileName)
    if (dest.isFile && dest.length() > 0L) {
        return@withContext dest
    }
    dest.parentFile?.mkdirs()
    val request = Request.Builder().url(url).build()
    client.newCall(request).execute().use { response ->
        if (!response.isSuccessful) throw IOException("HTTP ${response.code}")
        val body = response.body ?: throw IOException("HTTP ${response.code}")
        val staging = File.createTempFile("generated-media", ".part", dest.parentFile)
        try {
            body.byteStream().use { input -> staging.outputStream().use { input.copyTo(it) } }
            if (staging.length() == 0L) throw IOException("Empty body")
            if (!staging.renameTo(dest)) {
                dest.delete()
                staging.copyTo(dest, overwrite = true)
                staging.delete()
            }
            dest
        } catch (t: Throwable) {
            staging.delete()
            throw t
        }
    }
}

/** `m:ss` readout for the audio player (minutes roll over: 61 min -> "61:00"). */
internal fun formatPlaybackTime(millis: Int): String {
    val totalSeconds = (millis.coerceAtLeast(0)) / 1000
    return "%d:%02d".format(java.util.Locale.US, totalSeconds / 60, totalSeconds % 60)
}

/** Non-image media without a fetcher (previews, unit tests) degrade to this. */
internal class GeneratedMediaUnavailableException :
    IOException("media client unavailable")

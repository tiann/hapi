package app.hapi.companion.feature.chat.blocks

import app.hapi.companion.R
import java.io.File
import java.io.IOException
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
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
 * Resolves the MIME type the file card's Open (ACTION_VIEW) and Save
 * (ACTION_CREATE_DOCUMENT) outlets should carry. A specific wire type passes
 * through untouched, but a missing or `application/octet-stream` wire type
 * would defeat Android's viewer matching — a PDF viewer registered for
 * `application/pdf` is not matched by an intent that explicitly says
 * `application/octet-stream` — so the type is re-derived from the original
 * filename's extension through [resolveExtension] (the app passes
 * `MimeTypeMap`; JVM tests pass a fake table), keeping the generic fallback
 * for extensions the table does not know.
 */
internal fun resolveFileMimeType(
    wireMimeType: String?,
    fileName: String,
    resolveExtension: (extension: String) -> String?,
): String {
    val wire = wireMimeType?.trim().orEmpty()
    if (wire.isNotEmpty() && !wire.equals("application/octet-stream", ignoreCase = true)) return wire
    val extension = fileName.substringAfterLast('.', "").lowercase(Locale.ROOT)
    if (extension.isEmpty()) return GENERIC_FILE_MIME_TYPE
    val resolved = resolveExtension(extension)?.takeIf { it.isNotBlank() && '/' in it && '*' !in it }
    return resolved ?: GENERIC_FILE_MIME_TYPE
}

/** Generic fallback for files whose extension yields nothing more specific. */
internal const val GENERIC_FILE_MIME_TYPE: String = "application/octet-stream"

/**
 * Filesystem-safe cache file name for one generated media blob. The wire
 * `fileName`/`imageId` are untrusted; strip path fragments and unsafe
 * characters, and keep both ids so distinct blobs never collide.
 *
 * The *complete* component (id prefix + stem + extension) is bounded by
 * UTF-8 bytes, because Android filename limits are byte limits (NAME_MAX
 * 255): a UTF-16 `take(96)` alone lets 96 CJK chars through at up to 288
 * bytes, and a UUID imageId prefix on an 80-hanzi ".pdf" name produced a
 * 281-byte component (r4370795787). The stem keeps its historical 96-char
 * cap — ASCII names keep their exact prior shape — and only bytes beyond
 * the budget are cut, taken from the stem on code-point boundaries so the
 * extension always survives intact.
 */
internal fun sanitizedGeneratedMediaFileName(imageId: String, fileName: String): String {
    val base = fileName.substringAfterLast('/').substringAfterLast('\\')
    val safe = base.filter { it.isLetterOrDigit() || it == '.' || it == '-' || it == '_' }
    val splitAt = safe.lastIndexOf('.').takeIf { it > 0 && it < safe.length - 1 }
    var stem = takeUtf16Chars(if (splitAt != null) safe.substring(0, splitAt) else safe, 96)
        .trim('.', '-', '_')
    var extension = if (splitAt != null) safe.substring(splitAt) else ""
    if (stem.isEmpty()) {
        // Keep the historical whole-name shapes: "" -> "media", and a stem
        // that trims to nothing ("..doc") -> the trimmed whole name, which
        // therefore carries no separate extension suffix.
        stem = takeUtf16Chars(safe, 96).trim('.', '-', '_').ifEmpty { "media" }
        extension = ""
    }
    val prefix = truncateUtf8Bytes(
        imageId.filter { it.isLetterOrDigit() || it == '-' }.ifEmpty { "id" } + "-",
        GENERATED_MEDIA_ID_PREFIX_MAX_BYTES,
    )
    val boundedExtension = truncateUtf8Bytes(extension, GENERATED_MEDIA_EXTENSION_MAX_BYTES)
    val stemBudget = GENERATED_MEDIA_NAME_MAX_BYTES -
        prefix.toByteArray(Charsets.UTF_8).size -
        boundedExtension.toByteArray(Charsets.UTF_8).size
    val boundedStem = truncateUtf8Bytes(stem, stemBudget).trimEnd('.', '-', '_')
    return prefix + boundedStem + boundedExtension
}

/**
 * Byte budget for one cache file name component — Linux NAME_MAX, the
 * bound Android filesystems actually enforce, counted in UTF-8 bytes.
 */
internal const val GENERATED_MEDIA_NAME_MAX_BYTES: Int = 255

/** Pathological ids/extensions get their own caps so the stem always keeps room. */
internal const val GENERATED_MEDIA_ID_PREFIX_MAX_BYTES: Int = 64
internal const val GENERATED_MEDIA_EXTENSION_MAX_BYTES: Int = 32

/** Like [String.take] on UTF-16 chars but never ends inside a surrogate pair. */
private fun takeUtf16Chars(value: String, maxChars: Int): String {
    if (value.length <= maxChars) return value
    var end = maxChars
    if (end > 0 && value[end - 1].isHighSurrogate() && end < value.length && value[end].isLowSurrogate()) {
        end--
    }
    return value.substring(0, end)
}

/**
 * Prefix of [value] fitting in [maxBytes] UTF-8 bytes, cut only on
 * code-point boundaries. The whitelist above drops surrogate halves (a lone
 * half is never a letter or digit), so pairs cannot reach this cut today —
 * the pair handling is defense in depth for any future code-point-aware
 * whitelist; an unpaired surrogate counts as its encoder output, the 1-byte
 * `?` replacement.
 */
private fun truncateUtf8Bytes(value: String, maxBytes: Int): String {
    var bytes = 0
    var end = 0
    while (end < value.length) {
        val first = value[end]
        val isPair = first.isHighSurrogate() && end + 1 < value.length && value[end + 1].isLowSurrogate()
        val byteCount = when {
            isPair -> 4
            first.isSurrogate() -> 1 // unpaired: the platform encoder writes '?'
            first.code < 0x80 -> 1
            first.code < 0x800 -> 2
            else -> 3
        }
        if (bytes + byteCount > maxBytes) break
        bytes += byteCount
        end += if (isPair) 2 else 1
    }
    return value.substring(0, end)
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

/**
 * The player surface the audio card needs — [android.media.MediaPlayer]
 * behind the app-side adapter, a fake in JVM tests — so the play/pause/seek/
 * release wiring is testable without a device.
 */
internal interface GeneratedAudioPlayer {
    fun setDataSource(path: String)

    fun prepareAsync()

    /** [onPrepared] receives the stream's duration in milliseconds. */
    fun setOnPreparedListener(onPrepared: (durationMs: Int) -> Unit)

    fun setOnCompletionListener(onCompletion: () -> Unit)

    /** Returns whether the error was handled (the framework contract). */
    fun setOnErrorListener(onError: () -> Boolean)

    fun start()

    fun pause()

    fun seekTo(positionMs: Int)

    fun currentPositionMs(): Int

    fun release()
}

/**
 * State + control core of the audio row (web G12's `<audio controls>` minus
 * the chrome): owns the play/pause toggle, fraction-to-position seeking, and
 * position polling over a [GeneratedAudioPlayer], kept free of Compose so
 * the wiring is JVM-testable — the card collects the flows, [release] is its
 * dispose hook (idempotent; a released session ignores further control).
 */
internal class GeneratedAudioSession(private val player: GeneratedAudioPlayer) {
    val prepared = MutableStateFlow(false)
    val playing = MutableStateFlow(false)
    val durationMs = MutableStateFlow(0)
    val positionMs = MutableStateFlow(0)
    val failed = MutableStateFlow(false)

    private var released = false

    fun prepare(dataSource: String) {
        if (released) return
        player.setOnPreparedListener { duration ->
            durationMs.value = duration
            prepared.value = true
        }
        player.setOnCompletionListener { playing.value = false }
        player.setOnErrorListener {
            playing.value = false
            failed.value = true
            true
        }
        runCatching {
            player.setDataSource(dataSource)
            player.prepareAsync()
        }.onFailure { failed.value = true }
    }

    fun togglePlayPause() {
        if (released || failed.value || !prepared.value) return
        if (playing.value) {
            player.pause()
            playing.value = false
        } else {
            player.start()
            playing.value = true
        }
    }

    /** Scrub-finished handler: commit [fraction] of the duration as a position. */
    fun seekToFraction(fraction: Float) {
        if (released || failed.value || !prepared.value) return
        val duration = durationMs.value
        if (duration <= 0) return
        player.seekTo((fraction * duration).toInt().coerceIn(0, duration))
        positionMs.value = player.currentPositionMs()
    }

    /** Poll tick from the card's LaunchedEffect while [playing] is true. */
    fun pollPosition() {
        if (released || !playing.value) return
        positionMs.value = player.currentPositionMs()
    }

    fun release() {
        if (released) return
        released = true
        playing.value = false
        player.release()
    }
}

/**
 * Pure description of the file card's platform outlets (web G13's single
 * browser download link): Open fires ACTION_VIEW with [openMimeType] over
 * the FileProvider uri; Save launches ACTION_CREATE_DOCUMENT suggesting
 * [suggestedName] and writes with [saveMimeType]. Extracted so the JVM
 * tests can pin that both outlets carry the *resolved* MIME type (a missing
 * or octet-stream wire type refined from the filename) without
 * android.content on the classpath.
 */
internal data class GeneratedFileOutlets(
    val openMimeType: String,
    val saveMimeType: String,
    val suggestedName: String,
)

internal fun generatedFileOutlets(
    wireMimeType: String?,
    fileName: String,
    resolveExtension: (extension: String) -> String?,
): GeneratedFileOutlets {
    val resolved = resolveFileMimeType(wireMimeType, fileName, resolveExtension)
    return GeneratedFileOutlets(
        openMimeType = resolved,
        saveMimeType = resolved,
        suggestedName = fileName,
    )
}

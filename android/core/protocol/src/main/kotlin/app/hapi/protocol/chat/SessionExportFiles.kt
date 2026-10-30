package app.hapi.protocol.chat

import app.hapi.protocol.wire.SESSION_EXPORT_MAX_BYTES
import app.hapi.protocol.wire.SessionExport
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.serialization.json.JsonElement

/**
 * Port of `web/src/lib/sessionExport/download.ts` — the format enum, filename
 * builder, artifact assembly (fetch → bytes → size guard) and the size
 * formatter shared with the dialog UI. Everything here is pure and
 * JVM-testable; the web's Blob download is replaced by Android's
 * SAF save / share outlets at the app layer.
 */

/** `SessionExportFormat` — JSON (lossless) or Markdown (readable). */
enum class SessionExportFormat(
    /** `hapi.sessionExportFormat` persistence value. */
    val storageValue: String,
    val extension: String,
    /** Intent/SAF mime (no `;charset` suffix — Android parses these itself). */
    val mimeType: String,
) {
    JSON("json", "json", "application/json"),
    MARKDOWN("markdown", "md", "text/markdown");

    companion object {
        /** `readSessionExportFormat`: only "markdown" selects Markdown; anything else → JSON. */
        fun fromStorageValue(value: String?): SessionExportFormat =
            if (value == MARKDOWN.storageValue) MARKDOWN else JSON
    }
}

/** `getSessionTitle` (download.ts variant): name ?? summary ?? path tail ?? id[:8]. */
private fun filenameTitle(export: SessionExport): String {
    val metadata = export.session.metadata
    return metadata?.name
        ?: metadata?.summary?.text
        ?: metadata?.path?.split('/')?.filter { it.isNotEmpty() }?.lastOrNull()
        ?: export.session.id.take(8)
}

private val SLUG_INVALID_RUN = Regex("[^a-z0-9一-鿿]+")
private val SLUG_EDGE_DASHES = Regex("^-+|-+$")

/** `slugify`: lowercase, keep [a-z0-9] + CJK, runs of anything else → '-', trim edges. */
internal fun slugifySessionExportTitle(value: String): String {
    val slug = value.trim().lowercase()
        .replace(SLUG_INVALID_RUN, "-")
        .replace(SLUG_EDGE_DASHES, "")
    return slug.ifEmpty { "session" }
}

/**
 * JS `Date` validity bound: epoch-ms magnitudes beyond ±8_640_000_000_000_000
 * are `NaN` in JS (`Invalid Date`), and the web formatters fall back to
 * `String(value)` / the current date.
 */
internal const val MAX_JS_EPOCH_MS: Long = 8_640_000_000_000_000L

private val ISO_MILLIS_UTC: DateTimeFormatter =
    DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

private val ISO_DATE_UTC: DateTimeFormatter =
    DateTimeFormatter.ofPattern("uuuu-MM-dd").withZone(ZoneOffset.UTC)

/** `formatTimestamp` (markdown.ts): `Date#toISOString()` — UTC, 3-digit millis. */
internal fun formatExportTimestamp(value: Long): String =
    if (kotlin.math.abs(value) > MAX_JS_EPOCH_MS) value.toString()
    else ISO_MILLIS_UTC.format(Instant.ofEpochMilli(value))

/** `formatDate` (download.ts): UTC `YYYY-MM-DD`; invalid dates fall back to today. */
internal fun formatExportDate(value: Long): String =
    if (kotlin.math.abs(value) > MAX_JS_EPOCH_MS) ISO_DATE_UTC.format(Instant.now())
    else ISO_DATE_UTC.format(Instant.ofEpochMilli(value))

/** `buildSessionExportFilename`: `{slug≤80}-{id[:8]}-{YYYY-MM-DD}.{json|md}`. */
fun buildSessionExportFilename(export: SessionExport, format: SessionExportFormat): String {
    val slug = slugifySessionExportTitle(filenameTitle(export)).take(80)
    val shortId = export.session.id.take(8)
    return "$slug-$shortId-${formatExportDate(export.exportedAt)}.${format.extension}"
}

/** A built export ready for the save/share outlet. */
data class SessionExportArtifact(
    val filename: String,
    val format: SessionExportFormat,
    val text: String,
    val messageCount: Int,
    /** UTF-8 size of [text] (the web twin's `blob.size`). */
    val byteCount: Long,
)

/** `downloadSessionExport`'s non-fetch half: build + size-guard. */
sealed class SessionExportArtifactResult {
    data class Ready(val artifact: SessionExportArtifact) : SessionExportArtifactResult()
    data class TooLarge(val count: Int, val estimatedBytes: Long, val maxBytes: Long) : SessionExportArtifactResult()
}

/**
 * Renders the fetched payload into outlet text (pretty JSON from the raw
 * element — byte-parity with `JSON.stringify(payload, null, 2)` — or the
 * Markdown serializer) and enforces the client-side byte cap.
 */
fun buildSessionExportArtifact(
    export: SessionExport,
    raw: JsonElement,
    format: SessionExportFormat,
    maxBytes: Long = SESSION_EXPORT_MAX_BYTES,
): SessionExportArtifactResult {
    val text = when (format) {
        SessionExportFormat.JSON -> safeStringify(raw) + "\n"
        SessionExportFormat.MARKDOWN -> serializeSessionMarkdown(export)
    }
    val byteCount = text.toByteArray(Charsets.UTF_8).size.toLong()
    if (byteCount > maxBytes) {
        return SessionExportArtifactResult.TooLarge(
            count = export.messages.size,
            estimatedBytes = byteCount,
            maxBytes = maxBytes,
        )
    }
    return SessionExportArtifactResult.Ready(
        SessionExportArtifact(
            filename = buildSessionExportFilename(export, format),
            format = format,
            text = text,
            messageCount = export.messages.size,
            byteCount = byteCount,
        ),
    )
}

/** `formatExportSize` (SessionExportDialog.tsx): B / KiB / MiB / GiB, 0 or 1 fraction digit. */
fun formatExportSize(bytes: Long): String {
    val units = arrayOf("B", "KiB", "MiB", "GiB")
    var value = bytes.toDouble()
    var unitIndex = 0
    while (value >= 1024 && unitIndex < units.size - 1) {
        value /= 1024
        unitIndex += 1
    }
    val text = String.format(Locale.US, if (unitIndex == 0) "%.0f" else "%.1f", value)
    return "$text ${units[unitIndex]}"
}

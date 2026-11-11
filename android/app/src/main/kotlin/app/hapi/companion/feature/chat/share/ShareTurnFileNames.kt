package app.hapi.companion.feature.chat.share

import java.text.Normalizer
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Export file naming for shared turns: `HAPI-<sanitized title>-<local
 * timestamp>.png`. Title sanitizing keeps the name a single safe path
 * segment on any platform.
 */
object ShareTurnFileNames {

    /** Characters no filename component may carry. */
    private val ILLEGAL_CHARACTERS = setOf('<', '>', ':', '"', '/', '\\', '|', '?', '*')

    /** Longest title allowed in a file name, counted in code points. */
    private const val MAX_TITLE_CODE_POINTS = 80

    private val WHITESPACE = Regex("\\s+")
    private val DASH_RUN = Regex("-{2,}")
    private val EDGE_TRIM = Regex("^[ .-]+|[ .-]+$")

    private val STAMP_FORMAT = DateTimeFormatter.ofPattern("yyyyMMddHHmmss", Locale.US)

    /** Fallback segment when the title carries no usable characters. */
    const val FALLBACK_TITLE = "Shared turn"

    /**
     * Reduce a session title to a file-name-safe segment: compatibility
     * normalization, control-character removal, illegal-character
     * replacement, whitespace collapsing (runs become one space, kept in
     * the name like the reference), dash collapsing, edge trimming, a
     * fallback for empty results, and a code-point length cap with a
     * final edge trim.
     */
    fun sanitizeTitle(title: String): String {
        val normalized = Normalizer.normalize(title, Normalizer.Form.NFKC)
        val cleaned = buildString(normalized.length) {
            for (character in normalized) {
                val code = character.code
                when {
                    code < 32 || code == 127 -> Unit
                    character in ILLEGAL_CHARACTERS -> append('-')
                    else -> append(character)
                }
            }
        }
        val dashed = DASH_RUN.replace(WHITESPACE.replace(cleaned, " "), "-")
        val trimmed = EDGE_TRIM.replace(dashed, "")
        val usable = trimmed.ifEmpty { FALLBACK_TITLE }
        if (usable.codePointCount(0, usable.length) <= MAX_TITLE_CODE_POINTS) return usable
        val builder = StringBuilder()
        var count = 0
        var index = 0
        while (index < usable.length && count < MAX_TITLE_CODE_POINTS) {
            val codePoint = usable.codePointAt(index)
            builder.appendCodePoint(codePoint)
            count++
            index += Character.charCount(codePoint)
        }
        return EDGE_TRIM.replace(builder.toString(), "")
    }

    /**
     * Full export name with a local-time `yyyyMMddHHmmss` stamp, e.g.
     * `HAPI-Release Notes-20260802103045.png`.
     */
    fun shareImageFileName(
        title: String,
        timestampMs: Long,
        zone: ZoneId = ZoneId.systemDefault(),
    ): String {
        val stamp = STAMP_FORMAT.withZone(zone).format(Instant.ofEpochMilli(timestampMs))
        return "HAPI-${sanitizeTitle(title)}-$stamp.png"
    }
}

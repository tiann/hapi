package app.hapi.companion.feature.sessions

/**
 * Copy-reference clipboard text, the Android mirror of the web's
 * `web/src/lib/sessionReference.ts` (`buildSessionReferenceText`): prose that
 * cites this session in another HAPI chat. Not a public share link — the path
 * is a hub path the cited agent resolves through the `inspect_peer` MCP tool,
 * which is what the steer suffix instructs it to do (tiann/hapi#1370).
 */
object SessionReference {

    /** Byte-identical to `SESSION_REFERENCE_STEER_SUFFIX` in `shared/src/sessionCitation.ts`. */
    const val STEER_SUFFIX =
        " HAPI hub peer - call inspect_peer with that session id; do not Grep/Glob/Read /sessions/ as a local file."

    /** Hub path form; JS `encodeURIComponent` unreserved set kept as-is. */
    fun buildSessionReferencePath(sessionId: String): String = "/sessions/" + encodeURIComponent(sessionId)

    /** Clipboard text for citing this session in another HAPI chat. */
    fun buildSessionReferenceText(sessionTitle: String?, sessionId: String): String {
        val path = buildSessionReferencePath(sessionId)
        val title = sanitizeSessionReferenceTitle(sessionTitle)
        val base = if (title != null) {
            "See session \"${title.jsonEscape()}\" ($path) for context"
        } else {
            "See HAPI session $path for context"
        }
        return "$base.$STEER_SUFFIX"
    }

    /**
     * Whitespace-collapse + trim + cap at 120 code points (the web truncates
     * 120 **grapheme clusters**; code points are the closest pure-Kotlin
     * equivalent and only differ inside composed emoji sequences).
     */
    internal fun sanitizeSessionReferenceTitle(sessionTitle: String?): String? {
        if (sessionTitle == null) return null
        val collapsed = sessionTitle.replace(Regex("\\s+"), " ").trim()
        if (collapsed.isEmpty()) return null
        val codePoints = collapsed.codePoints().toArray()
        if (codePoints.size <= MAX_TITLE_CODE_POINTS) return collapsed
        return String(codePoints, 0, MAX_TITLE_CODE_POINTS)
    }

    /** JS `JSON.stringify` string escaping — the reference prose quotes the title JSON-style. */
    private fun String.jsonEscape(): String = buildString {
        for (char in this@jsonEscape) {
            when (char) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                '\b' -> append("\\b")
                '\u000C' -> append("\\f")
                else ->
                    if (char.code < 0x20) append("\\u%04x".format(char.code))
                    else append(char)
            }
        }
    }

    /** JS `encodeURIComponent`: everything outside `[A-Za-z0-9-_.!~*'()]` is percent-encoded. */
    private fun encodeURIComponent(value: String): String = buildString {
        for (byte in value.toByteArray(Charsets.UTF_8)) {
            val c = byte.toInt() and 0xFF
            if (c in '0'.code..'9'.code || c in 'A'.code..'Z'.code || c in 'a'.code..'z'.code ||
                c == '-'.code || c == '_'.code || c == '.'.code || c == '!'.code || c == '~'.code ||
                c == '*'.code || c == '\''.code || c == '('.code || c == ')'.code
            ) {
                append(c.toChar())
            } else {
                // "%02X" formats the byte as two hex digits; the literal % is ours.
                append('%').append("%02X".format(c))
            }
        }
    }

    private const val MAX_TITLE_CODE_POINTS = 120
}

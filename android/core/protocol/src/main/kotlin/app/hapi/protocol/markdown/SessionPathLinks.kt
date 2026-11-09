package app.hapi.protocol.markdown

/**
 * Session-citation parsing/detection, ported from the web client so chat
 * markdown can cite other sessions as clickable links (web
 * `web/src/lib/sessionReference.ts` + the remark plugin
 * `web/src/lib/remark-session-path-links.ts`).
 *
 * Two directions, mirroring the web pipeline:
 * - [parseSessionPathHref] — link destinations (`[title](/sessions/<id>)`)
 *   match the web `parseSessionPathHref`: optional `./`/`/` or BASE_URL
 *   prefix segments, `sessions/` + id, strict `decodeURIComponent` id decoding.
 * - [detectBareSessionCitations] — plain-text scanning for bare
 *   `/sessions/<id>` paths (web `BARE_SESSION_PATH`), converting them to
 *   citations whose display text is the path itself.
 *
 * Session ids exclude `.` so source paths under a `sessions/` directory
 * (`web/src/routes/sessions/chat.tsx`) stay available for file-path
 * autolinking (plugin order on the web: session links before file links).
 *
 * Pure JVM on purpose: unit-tested in `:core:protocol`.
 */
object SessionPathLinks {

    /** Web `SESSION_PATH_RE`: optional `./`/`/` + BASE_URL segments + id. */
    private val SESSION_PATH_RE = Regex("""^(?:\.?\/)?(?:[\w.-]+\/)*sessions\/([^\/?#]+)\/?$""")

    /**
     * Web `BARE_SESSION_PATH`: preceded by start/whitespace/`(`, captured
     * `sessions/<id>` path (id charset has no dots), followed by a delimiter,
     * end-of-input, or a sentence period that itself ends the path. Raw string
     * on purpose — the `$` assertions are literal in raw strings and would
     * become template interpolation if anyone "fixed" this into an escaped
     * string.
     *
     * Java `$` matches before a final line terminator where JS `$` does not;
     * benign here because a trailing `\n` also satisfies the whitespace
     * alternative of the lookahead (locked by a dedicated test).
     */
    private val BARE_SESSION_PATH = Regex(
        """(?:^|[\s(])((?:\.?\/)?(?:[\w.-]+\/)*sessions\/[A-Za-z0-9_~%-]+)(?=[\s),;:!?]|$(?!\.)|(?=\.(?:[\s),;:!?]|$)))""",
    )

    /** Web scheme guard `/^[a-z][a-z0-9+.-]*:/i` — absolute URLs never parse. */
    private val HREF_SCHEME = Regex("""^[a-z][a-z0-9+.-]*:""", RegexOption.IGNORE_CASE)

    /**
     * Hub session ids are UUIDs (no dots). Rejects dotted tails so source
     * paths like `web/src/routes/sessions/chat.tsx` stay for file autolinking.
     */
    fun isPlausibleSessionId(id: String): Boolean = id.isNotEmpty() && '.' !in id

    /** Parse a session id from a relative `/sessions/<id>` (or prefixed) href. */
    fun parseSessionPathHref(href: String): String? {
        val trimmed = href.trim()
        if (trimmed.isEmpty()) return null
        if (HREF_SCHEME.containsMatchIn(trimmed)) return null
        val id = SESSION_PATH_RE.find(trimmed)?.groupValues?.get(1)?.let {
            HrefPolicy.percentDecodeOrNull(it)
        } ?: return null
        return if (isPlausibleSessionId(id)) id else null
    }

    /** A linkable `/sessions/<id>` citation found in plain text. */
    data class SessionCitation(
        /** Indices in the input covering the matched path text. */
        val range: IntRange,
        /** Decoded session id the citation points at. */
        val sessionId: String,
        /** The exact matched path text (the web link keeps the path as label). */
        val display: String,
    )

    /**
     * Find bare session citations in plain prose (the text-node pass of the
     * web plugin). Each candidate is re-validated through
     * [parseSessionPathHref] with an ensured leading slash, like the web
     * `linkifyTextNode`; invalid candidates are skipped, not failed.
     */
    fun detectBareSessionCitations(text: String): List<SessionCitation> {
        val results = mutableListOf<SessionCitation>()
        for (match in BARE_SESSION_PATH.findAll(text)) {
            val path = match.groups[1]?.value ?: continue
            val url = if (path.startsWith("/") || path.startsWith("./")) path else "/$path"
            val id = parseSessionPathHref(url) ?: continue
            results += SessionCitation(
                range = match.groups[1]!!.range,
                sessionId = id,
                display = path,
            )
        }
        return results
    }
}

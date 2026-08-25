package app.hapi.protocol.markdown

import java.io.ByteArrayOutputStream

/**
 * Fail-closed policy for markdown link destinations, ported from the web
 * client's scheme policy (`web/src/components/assistant-ui/markdown-text.tsx`)
 * and scheme-less href policy (`web/src/lib/markdown-href-policy.ts`).
 *
 * Product rule (#1452): never paint a clickable control that dead-ends.
 * Native mapping of the web decisions:
 * - IANA-safe schemes (`https` ...)         -> [HrefDecision.Allowed]: open directly.
 * - Custom schemes (`vscode:` ...)          -> [HrefDecision.ConfirmFirst]: confirm dialog,
 *   optionally "always allow" per scheme (persisted by the app, not here).
 * - Deny-listed schemes / scheme-less rest  -> [HrefDecision.Blocked]: inert text.
 *
 * Scheme-less targets differ from the web on purpose: the SPA-route branch
 * (`/settings`, `#anchor`, protocol-relative `//host`) has no native equivalent,
 * so those fall to Blocked. Workspace-file targets are the caller's job:
 * run [MarkdownTransforms.rewriteExplicitLinkTarget] BEFORE [classify]; anything
 * that survives to classify() without a scheme is inert.
 */
sealed interface HrefDecision {
    /** IANA-registered safe scheme: open without ceremony. */
    data object Allowed : HrefDecision

    /** Unknown custom scheme: ask the user before dispatching. */
    data class ConfirmFirst(val scheme: String) : HrefDecision

    /** Deny-listed or unresolvable: render as inert text, never dispatch. */
    data object Blocked : HrefDecision
}

object HrefPolicy {

    /** Mirrors react-markdown's `defaultUrlTransform` allowlist exactly. */
    val IANA_SAFE_SCHEMES: Set<String> = setOf("http", "https", "irc", "ircs", "mailto", "xmpp")

    /** Always blocked regardless of user preference. */
    val DENY_SCHEMES: Set<String> = setOf("javascript", "data", "vbscript", "file")

    private val SCHEME_STRIP = Regex("""[\x00-\x1F\x7F\s]""")

    /**
     * Extract the normalised scheme from a URL string.
     *
     * Applies up to two rounds of percent-decoding so double-encoded bypasses
     * (`javascript%253A` -> `javascript%3A` -> `javascript:`) are unwrapped, then
     * strips ASCII control characters and whitespace from the scheme name --
     * platform URL handling silently discards those during dispatch, so
     * `java\nscript:alert(1)` must classify as `javascript`.
     *
     * Returns null when no scheme separator is found.
     */
    fun normalizedScheme(url: String): String? {
        var value = url.trimStart()
        repeat(2) {
            val next = percentDecodeOrNull(value) ?: return@repeat
            if (next == value) return@repeat
            value = next
        }
        val colonIndex = value.indexOf(':')
        if (colonIndex <= 0) return null
        return SCHEME_STRIP.replace(value.take(colonIndex), "").lowercase()
    }

    /**
     * True when [href] carries a URL scheme -- a `scheme:` prefix appearing before
     * any `/`, `?` or `#`. Distinguishes `mailto:x` (true) from relative targets
     * like `docs/a.md`, `#section`, or `/path:colon` (false).
     */
    fun hasScheme(href: String): Boolean {
        val colonIdx = href.indexOf(':')
        if (colonIdx <= 0) return false
        val boundaryIdx = href.indexOfFirst { it == '/' || it == '?' || it == '#' }
        return boundaryIdx < 0 || colonIdx < boundaryIdx
    }

    /**
     * Classify a markdown link destination. Callers handle workspace file paths
     * first (see [MarkdownTransforms.rewriteExplicitLinkTarget]); everything else
     * flows through here.
     */
    fun classify(url: String): HrefDecision {
        val trimmed = url.trim()
        if (trimmed.isEmpty()) return HrefDecision.Blocked

        // Windows drive paths look like a `c:` scheme; they are file candidates
        // owned by the file-path layer, never confirmable custom schemes.
        if (MarkdownTransforms.isWindowsAbsolutePath(trimmed)) return HrefDecision.Blocked

        // Scheme-less: no SPA router on native -- fail closed to inert.
        if (!hasScheme(trimmed)) return HrefDecision.Blocked

        val scheme = normalizedScheme(trimmed) ?: return HrefDecision.Blocked
        return when {
            scheme in DENY_SCHEMES -> HrefDecision.Blocked
            scheme in IANA_SAFE_SCHEMES -> HrefDecision.Allowed
            else -> HrefDecision.ConfirmFirst(scheme)
        }
    }

    /**
     * JS `decodeURIComponent` equivalent: strict `%HH` decoding (no `+` -> space),
     * null on malformed escapes so the caller keeps the previous value, mirroring
     * the web's try/catch-break loop.
     */
    private fun percentDecodeOrNull(value: String): String? {
        if ('%' !in value) return value
        val bytes = ByteArrayOutputStream(value.length)
        var i = 0
        while (i < value.length) {
            val c = value[i]
            if (c == '%') {
                if (i + 3 > value.length) return null
                val hi = Character.digit(value[i + 1], 16)
                val lo = Character.digit(value[i + 2], 16)
                if (hi < 0 || lo < 0) return null
                bytes.write((hi shl 4) or lo)
                i += 3
            } else {
                for (b in c.toString().toByteArray(Charsets.UTF_8)) bytes.write(b.toInt())
                i += 1
            }
        }
        return bytes.toByteArray().toString(Charsets.UTF_8)
    }
}

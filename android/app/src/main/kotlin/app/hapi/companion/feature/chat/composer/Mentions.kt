package app.hapi.companion.feature.chat.composer

import app.hapi.protocol.wire.FileSearchItem
import app.hapi.protocol.wire.SessionSummary
import java.text.BreakIterator
import java.util.Locale

/**
 * One composer `@`-mention row: [SessionMention] (session chips) or
 * [FileMention] (session file paths, codex/copilot flavors only). Mirrors the
 * web suggestion shape (`web/src/router.tsx getAutocompleteSuggestions`):
 * [label]/[description] render in the dropdown, [insertText] replaces the
 * active word on selection, and [key] identifies the row across refreshes.
 */
sealed interface MentionSuggestion {
    val key: String
    val label: String
    val description: String

    /** Verbatim replacement for the active `@word` (textarea-mode semantics). */
    val insertText: String

    /** A mentionable conversation; [insertText] is Copy-reference prose. */
    data class SessionMention(
        val id: String,
        /** Display title (`title || idPrefix8`, web `sessionMention.title`). */
        val title: String,
        override val key: String,
        override val label: String,
        override val description: String,
        override val insertText: String,
    ) : MentionSuggestion

    /** A session file hit; [insertText] is the flavor's `@path` mention form. */
    data class FileMention(
        override val key: String,
        override val label: String,
        override val description: String,
        override val insertText: String,
    ) : MentionSuggestion
}

/**
 * Pure logic behind the composer's `@`-mention autocomplete (B-M16a): trigger
 * detection, session ranking, insertion prose, and file-mention formatting.
 * The UI dropdown lives in `ChatComposer`; `ChatViewModel` drives the sources
 * (session-list rows + `GET /api/sessions/:id/files`, codex/copilot only).
 *
 * Web 同构/分歧:
 * - Trigger mirrors `web/src/utils/findActiveWord.ts` byte-for-byte (hard-stop
 *   scan, `@` boundary rule, `.`/`/` path continuation, bare-`@` popup) — with
 *   one divergence: the Android composer is a plain `String` field without a
 *   cursor API, so [mentionQueryOf] evaluates the word at the END of the text
 *   (the web evaluates at the real cursor). The full cursor-aware mirror is
 *   still exposed as [findActiveWord] for future `TextFieldValue` wiring.
 * - Like the web, there is NO code-fence awareness — a ``` block suppresses
 *   nothing; the character rules above are the whole anti-false-trigger set.
 * - Session ranking mirrors `web/src/lib/sessionReference.ts
 *   matchSessionsForMention` (sidebar dedupe pool + `hasConversationContent`
 *   gate + `scoreMatchedSession`), but `sessionMatchesQuery` searches
 *   title/summary/flavor/path/id only: the web additionally matches the
 *   worktree label and the machine label, which have no cheap Android source
 *   here (divergence, v1).
 * - Wildcard glob queries (the web's `shared/src/search.ts matchesSearchQuery`
 *   path) are not supported — plain case-insensitive substring terms, ANDed
 *   across whitespace tokens like the web's non-wildcard branch.
 */
object Mentions {

    /** `SESSION_REFERENCE_STEER_SUFFIX`, `shared/src/sessionCitation.ts`. */
    const val SESSION_REFERENCE_STEER_SUFFIX =
        " HAPI hub peer - call inspect_peer with that session id; do not Grep/Glob/Read /sessions/ as a local file."

    /** File-mention RPC cap (`router.tsx` passes 50). */
    const val FILE_SEARCH_LIMIT = 50

    /** Session-mention shortlist cap (`router.tsx` passes 20). */
    const val SESSION_LIMIT = 20

    /** Flavors whose agents accept file mentions (web: codex `@"p"`, copilot `@p`). */
    val FILE_MENTION_FLAVORS = setOf("codex", "copilot")

    /** Hard stops — the active-word scan never crosses (`findActiveWord.ts`). */
    private val STOP_CHARACTERS = "\n,()[]{}<>;!?.".toSet() + MENTION_MIRROR_CHAR

    /** Rich-composer mirror atom (U+FFFC) — hard word boundary. */
    private const val MENTION_MIRROR_CHAR = '￼'

    // --------------------------------------------------------- active word --

    /** Active-word scan result (`ActiveWord`, `findActiveWord.ts`). */
    data class ActiveWord(
        /** Full word from prefix to word end (e.g. `@username`). */
        val word: String,
        /** Part from prefix to cursor (e.g. `@use`). */
        val activeWord: String,
        /** Starting position of the word. */
        val offset: Int,
        /** Total length of the complete word. */
        val length: Int,
        /** Length from prefix to cursor. */
        val activeLength: Int,
        /** Position where the word ends (`offset + length`). */
        val endOffset: Int,
    )

    private fun isHardStopChar(char: Char): Boolean = char in STOP_CHARACTERS

    /** `@` counts as a prefix only at start / after blank / after a chip atom. */
    private fun isPrefixBoundaryBefore(content: String, index: Int): Boolean {
        if (index == 0) return true
        val prev = content[index - 1]
        return prev == ' ' || prev == '\n' || prev == MENTION_MIRROR_CHAR
    }

    private fun findActiveWordStart(
        content: String,
        selectionStart: Int,
        prefixes: Set<Char>,
    ): Int {
        var startIndex = selectionStart - 1
        var spaceIndex = -1
        while (startIndex >= 0) {
            val char = content[startIndex]
            // Hard stops (newline / mention atom / punctuation) — never cross.
            if (isHardStopChar(char)) return startIndex + 1
            // Soft space boundary (historical textarea behavior).
            if (char == ' ') {
                if (spaceIndex >= 0) return spaceIndex + 1
                spaceIndex = startIndex
                startIndex--
                continue
            }
            // Prefix at a word boundary.
            if (char in prefixes && isPrefixBoundaryBefore(content, startIndex)) {
                return startIndex
            }
            startIndex--
        }
        // Reached the beginning of text.
        return (if (spaceIndex >= 0) spaceIndex else startIndex) + 1
    }

    private fun findActiveWordEnd(content: String, cursorPos: Int, wordStartPos: Int): Int {
        var endIndex = cursorPos
        // `@`-led words are file-path candidates: `/` and `.` continue the word.
        val isFilePath = wordStartPos >= 0 && wordStartPos < content.length &&
            content[wordStartPos] == '@'
        while (endIndex < content.length) {
            val char = content[endIndex]
            if (isFilePath && (char == '/' || char == '.')) {
                endIndex++
                continue
            }
            if (char == ' ' || isHardStopChar(char)) break
            endIndex++
        }
        return endIndex
    }

    /**
     * Cursor-aware mirror of `findActiveWord.ts` — returns the prefixed word
     * under a collapsed cursor, or null. A bare prefix (just `@`) still returns
     * a result so suggestions pop immediately. The default prefix set mirrors
     * the web trigger set `['@', '/', '$']` (`HappyComposer.tsx`): a boundary-
     * legal `/` or `$` word stops the backward scan too, so `@ref /tmp` yields
     * the `/tmp` word (routed to the slash/skill domain) instead of swallowing
     * the whole `@ref /tmp` span as a mention query — [mentionQueryOf] still
     * gates on the `@` prefix.
     */
    fun findActiveWord(
        content: String,
        selectionStart: Int,
        selectionEnd: Int,
        prefixes: Set<Char> = setOf('@', '/', '$'),
    ): ActiveWord? {
        // Only detect when the cursor is at a single point (no selection).
        if (selectionStart != selectionEnd) return null
        // No active word at the very beginning of the text.
        if (selectionStart == 0) return null

        val startIndex = findActiveWordStart(content, selectionStart, prefixes)
        val activeWordPart = content.substring(startIndex, selectionEnd)
        // A word ending in a space is not active.
        if (activeWordPart.endsWith(' ')) return null

        if (activeWordPart.isNotEmpty() && activeWordPart[0] in prefixes) {
            val endIndex = findActiveWordEnd(content, selectionEnd, startIndex)
            val fullWord = content.substring(startIndex, endIndex)
            return ActiveWord(
                word = fullWord,
                activeWord = activeWordPart,
                offset = startIndex,
                length = fullWord.length,
                activeLength = activeWordPart.length,
                endOffset = endIndex,
            )
        }
        return null
    }

    /** Query without the prefix (`getActiveWordQuery`): bare prefix → `""`. */
    fun activeWordQuery(activeWord: String): String =
        if (activeWord.length > 1) activeWord.substring(1) else ""

    /**
     * The active `@` mention query for the composer text, evaluated at the end
     * of the input (cursor divergence — see object kdoc). Returns the search
     * term after `@` (may be empty for a bare `@`), or null when no mention
     * word is active.
     */
    fun mentionQueryOf(text: String): String? {
        if (text.isEmpty()) return null
        val activeWord = findActiveWord(text, text.length, text.length) ?: return null
        if (!activeWord.activeWord.startsWith('@')) return null
        return activeWordQuery(activeWord.activeWord)
    }

    /** Result of [applySuggestion]: the new text + cursor resting position. */
    data class TextEdit(val text: String, val cursorPosition: Int)

    /**
     * Replace the active word with [suggestion] (`web/src/utils/applySuggestion.ts`):
     * the whole word `[offset, endOffset)` is swapped (not just the typed
     * part), a trailing space is appended when nothing (or a non-space)
     * follows, and the cursor lands after the insertion. Without an active
     * word the suggestion is inserted at the cursor instead.
     */
    fun applySuggestion(
        content: String,
        selectionStart: Int,
        selectionEnd: Int,
        suggestion: String,
        addSpace: Boolean = true,
    ): TextEdit {
        val activeWord = findActiveWord(content, selectionStart, selectionEnd)
        if (activeWord == null) {
            val beforeCursor = content.substring(0, selectionStart)
            val afterCursor = content.substring(selectionEnd)
            val suggestionWithSpace = if (addSpace) "$suggestion " else suggestion
            return TextEdit(
                text = beforeCursor + suggestionWithSpace + afterCursor,
                cursorPosition = selectionStart + suggestionWithSpace.length,
            )
        }
        val beforeWord = content.substring(0, activeWord.offset)
        val afterWord = content.substring(activeWord.endOffset)
        var suggestionToInsert = suggestion
        if (addSpace && (afterWord.isEmpty() || afterWord[0] != ' ')) {
            suggestionToInsert += " "
        }
        return TextEdit(
            text = beforeWord + suggestionToInsert + afterWord,
            cursorPosition = activeWord.offset + suggestionToInsert.length,
        )
    }

    // ---------------------------------------------------- mention prose --

    /** `encodeURIComponent` (JS): unreserved set kept, rest as `%XX` UTF-8. */
    internal fun encodeUriComponent(value: String): String {
        val sb = StringBuilder(value.length)
        for (byte in value.toByteArray(Charsets.UTF_8)) {
            val c = byte.toInt() and 0xFF
            val unreserved = c in 0x41..0x5A || c in 0x61..0x7A || c in 0x30..0x39 ||
                c == 0x2D || c == 0x5F || c == 0x2E || c == 0x21 || c == 0x7E ||
                c == 0x2A || c == 0x27 || c == 0x28 || c == 0x29
            if (unreserved) {
                sb.append(c.toChar())
            } else {
                sb.append('%').append("%02X".format(c))
            }
        }
        return sb.toString()
    }

    /** Hub session path (`/sessions/<encoded id>`, default `BASE_URL`). */
    fun buildSessionReferencePath(sessionId: String): String =
        "/sessions/${encodeUriComponent(sessionId)}"

    private fun truncateGraphemes(value: String, maxLength: Int): String {
        if (maxLength <= 0 || value.isEmpty()) return ""
        val boundaries = BreakIterator.getCharacterInstance(Locale.ROOT)
        boundaries.setText(value)
        val sb = StringBuilder()
        var start = boundaries.first()
        while (start != BreakIterator.DONE) {
            val end = boundaries.next()
            if (end == BreakIterator.DONE) break
            if (sb.length + (end - start) > maxLength) break
            sb.append(value, start, end)
            start = end
        }
        return sb.toString()
    }

    /**
     * JS `/\s+/` equivalent: `\s` there matches Unicode whitespace (NBSP,
     * U+3000 ideographic space, U+2028/2029, U+FEFF, ...) which Kotlin's
     * default ASCII `\s` does not — the explicit class keeps collapsing
     * byte-identical to the web for CJK titles.
     */
    private val JS_WHITESPACE_REGEX =
        Regex("[\\t\\n\\u000B\\u000C\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+")

    /** Whitespace-normalize + trim + 120-grapheme cap (`sanitizeSessionReferenceTitle`). */
    internal fun sanitizeSessionReferenceTitle(sessionTitle: String): String =
        truncateGraphemes(sessionTitle.replace(JS_WHITESPACE_REGEX, " ").trim(), 120)

    /** `JSON.stringify` string quoting (V8 escape set, lowercase `\u00xx`). */
    internal fun jsonQuote(value: String): String {
        val sb = StringBuilder(value.length + 2)
        sb.append('"')
        for (char in value) {
            when (char) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\b' -> sb.append("\\b")
                '\u000C' -> sb.append("\\f")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else ->
                    if (char.code < 0x20) {
                        sb.append("\\u").append(char.code.toString(16).padStart(4, '0'))
                    } else {
                        sb.append(char)
                    }
            }
        }
        sb.append('"')
        return sb.toString()
    }

    /**
     * Copy-reference prose for citing a session in a chat (textarea-mode
     * insert text, `buildSessionReferenceText`): blank title falls back to the
     * untitled form. Steer suffix included verbatim.
     */
    fun buildSessionReferenceText(sessionTitle: String, sessionId: String): String {
        val path = buildSessionReferencePath(sessionId)
        val title = sanitizeSessionReferenceTitle(sessionTitle)
        val base = if (title.isNotEmpty()) {
            "See session ${jsonQuote(title)} ($path) for context"
        } else {
            "See HAPI session $path for context"
        }
        return "$base.$SESSION_REFERENCE_STEER_SUFFIX"
    }

    /**
     * File-mention insert text (`router.tsx`): copilot `@<fullPath>`;
     * codex `@"<fullPath>"` with `"` and `\` backslash-escaped.
     */
    fun fileMentionText(flavor: String, fullPath: String): String =
        if (flavor == "copilot") {
            "@$fullPath"
        } else {
            "@\"${fullPath.replace(Regex("([\"\\\\])"), "\\\\$1")}\""
        }

    // ----------------------------------------------------- session pool --

    /** `getSessionTitle` (`sessionTitle.ts`): name → summary → path tail → id prefix. */
    fun sessionTitle(session: SessionSummary): String {
        val meta = session.metadata
        if (meta == null) return session.id.take(8)
        meta.name?.takeIf { it.isNotEmpty() }?.let { return it }
        meta.summary?.text?.takeIf { it.isNotEmpty() }?.let { return it }
        if (meta.path.isNotEmpty()) {
            val parts = meta.path.split('/').filter { it.isNotEmpty() }
            if (parts.isNotEmpty()) return parts.last()
        }
        return session.id.take(8)
    }

    /** Dedupe key `flavor:agentSessionId` (`getSessionDedupKey`); null = no key. */
    private fun sessionDedupKey(session: SessionSummary): String? {
        val agentId = session.metadata?.agentSessionId?.trim()
        if (agentId.isNullOrEmpty()) return null
        val flavor = session.metadata?.flavor ?: "unknown"
        return "$flavor:$agentId"
    }

    /** Sidebar dedupe (`deduplicateSessionsByAgentId`): one representative per agent id. */
    private fun deduplicateSessionsByAgentId(
        sessions: List<SessionSummary>,
        selectedSessionId: String?,
    ): List<SessionSummary> {
        val byAgentId = LinkedHashMap<String, MutableList<SessionSummary>>()
        val result = ArrayList<SessionSummary>()
        for (session in sessions) {
            val key = sessionDedupKey(session)
            if (key == null) {
                result += session
                continue
            }
            byAgentId.getOrPut(key) { mutableListOf() }.add(session)
        }
        val comparator = compareByDescending<SessionSummary> { it.active }
            .thenBy { it.id != selectedSessionId }
            .thenByDescending { it.globalPinned == true }
            .thenByDescending { it.pinned == true }
            .thenByDescending { it.updatedAt }
        for (group in byAgentId.values) {
            group.sortWith(comparator)
            result += group.first()
        }
        return result
    }

    /** Searchable fields — web diverges by also matching worktree/machine labels. */
    private fun sessionSearchFields(session: SessionSummary): List<String> {
        val values = ArrayList<String>()
        sessionTitle(session).takeIf { it.isNotEmpty() }?.let(values::add)
        val meta = session.metadata
        if (meta != null) {
            meta.summary?.text?.takeIf { it.isNotEmpty() }?.let(values::add)
            meta.flavor?.takeIf { it.isNotEmpty() }?.let(values::add)
            if (meta.path.isNotEmpty()) values += meta.path
            meta.worktree?.let { worktree ->
                if (worktree.basePath.isNotEmpty()) values += worktree.basePath
                worktree.worktreePath?.takeIf { it.isNotEmpty() }?.let(values::add)
            }
        }
        values += session.id
        return values
    }

    /**
     * `sessionMatchesQuery` (substring inclusion gate, NOT a score): terms are
     * whitespace tokens of the normalized query, ANDed; each must hit some
     * field. Empty query matches everything.
     */
    fun sessionMatchesQuery(session: SessionSummary, normalizedQuery: String): Boolean {
        if (normalizedQuery.isEmpty()) return true
        val terms = normalizedQuery.trim().lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (terms.isEmpty()) return true
        val values = sessionSearchFields(session)
        return terms.all { term -> values.any { it.lowercase().contains(term) } }
    }

    /** `scoreMatchedSession`: title tiers → id tiers → other-field 150; active/archived adjust. */
    private fun scoreMatchedSession(session: SessionSummary, query: String): Long {
        val title = sessionTitle(session).lowercase()
        val id = session.id.lowercase()
        val idPrefix = id.take(8)
        var score = when {
            title == query -> 500
            title.startsWith(query) -> 400
            title.contains(query) -> 300
            idPrefix.startsWith(query) || id.startsWith(query) -> 200
            id.contains(query) -> 100
            else -> 150
        }
        if (session.active) score += 50
        if (session.metadata?.lifecycleState == "archived") score -= 25
        return score * 10_000_000_000_000L + session.updatedAt
    }

    /**
     * Rank sessions for composer `@` autocomplete
     * (`matchSessionsForMention`): sidebar-deduped pool that must also carry
     * conversation content (`hasConversationContent === true` — empty stubs
     * are never mentionable), current session excluded. Empty query →
     * active-first + recent shortlist, archived hidden (they stay searchable
     * once the user types). Sorted by score desc, stable, capped at [limit].
     */
    fun matchSessionsForMention(
        sessions: List<SessionSummary>,
        query: String,
        excludeId: String? = null,
        limit: Int = SESSION_LIMIT,
    ): List<SessionSummary> {
        val normalized = query.trim().lowercase()
        val candidates = deduplicateSessionsByAgentId(sessions, excludeId)
        class Scored(val session: SessionSummary, val score: Long)
        val scored = ArrayList<Scored>()
        for (session in candidates) {
            if (excludeId != null && session.id == excludeId) continue
            // Empty stubs are not reference targets, regardless of their title.
            if (session.hasConversationContent != true) continue
            if (normalized.isEmpty()) {
                // Shortlist: active first, then recent; archived stay out
                // until the user types (same as share: type to widen).
                if (session.metadata?.lifecycleState == "archived") continue
                val score = if (session.active) 1_000_000_000L + session.updatedAt else session.updatedAt
                scored += Scored(session, score)
                continue
            }
            if (!sessionMatchesQuery(session, normalized)) continue
            scored += Scored(session, scoreMatchedSession(session, normalized))
        }
        return scored.sortedByDescending { it.score }.take(limit).map { it.session }
    }

    // ------------------------------------------------------ suggestions --

    /** Dropdown row for a session hit (web: label `@<title|idPrefix8>`, `Session · …`). */
    fun sessionSuggestion(session: SessionSummary): MentionSuggestion.SessionMention {
        val title = sessionTitle(session)
        val idPrefix = session.id.take(8)
        val displayTitle = title.ifEmpty { idPrefix }
        return MentionSuggestion.SessionMention(
            id = session.id,
            title = displayTitle,
            key = "session:${session.id}",
            label = "@$displayTitle",
            description = if (session.active) "Session · $idPrefix · active" else "Session · $idPrefix",
            insertText = buildSessionReferenceText(title, session.id),
        )
    }

    /** Dropdown row for a file hit (web: label `@<fileName>`, description `filePath || fullPath`). */
    fun fileSuggestion(flavor: String, file: FileSearchItem): MentionSuggestion.FileMention {
        val mentionText = fileMentionText(flavor, file.fullPath)
        return MentionSuggestion.FileMention(
            key = mentionText,
            label = "@${file.fileName}",
            description = file.filePath.ifEmpty { file.fullPath },
            insertText = mentionText,
        )
    }

    /** Session rows for the dropdown (`[...sessionHits]` leg of the web merge). */
    fun sessionSuggestions(
        sessions: List<SessionSummary>,
        query: String,
        excludeId: String? = null,
        limit: Int = SESSION_LIMIT,
    ): List<MentionSuggestion.SessionMention> =
        matchSessionsForMention(sessions, query, excludeId, limit).map(::sessionSuggestion)
}

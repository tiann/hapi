package app.hapi.companion.feature.chat.composer

import app.hapi.protocol.wire.SkillSummary

/** A row belongs to one active token and one catalogue load, not just a skill name. */
class SkillSuggestion internal constructor(
    val skill: SkillSummary,
    internal val token: SkillSuggestions.Token,
    internal val opening: Long,
    internal val replacementEnd: Int = token.end,
)

internal object SkillSuggestions {
    data class Token(val start: Int, val end: Int, val word: String, val query: String)
    data class Edit(val text: String, val caret: Int)

    private fun isNameChar(text: String, index: Int): Boolean {
        val char = text.getOrNull(index) ?: return false
        val codePoint = if (char.isLowSurrogate() && index > 0 && text[index - 1].isHighSurrogate()) {
            text.codePointAt(index - 1)
        } else {
            text.codePointAt(index)
        }
        return Character.isLetterOrDigit(codePoint) || char in "-_" || when (Character.getType(codePoint)) {
            Character.NON_SPACING_MARK.toInt(), Character.COMBINING_SPACING_MARK.toInt() -> true
            else -> false
        }
    }

    private fun isNameAt(text: String, index: Int): Boolean = if (text.getOrNull(index) == '.') {
        // A dot in foo.bar belongs to the name; a sentence-final dot does not.
        isNameChar(text, index - 1) && isNameChar(text, index + 1)
    } else {
        isNameChar(text, index)
    }

    private fun isCandidateAt(text: String, index: Int): Boolean = if (text.getOrNull(index) == ':') {
        isNameChar(text, index - 1) && (index == text.lastIndex || isNameChar(text, index + 1))
    } else {
        isNameAt(text, index)
    }

    fun token(text: String, start: Int, end: Int): Token? {
        if (start != end || start !in 1..text.length) return null
        var wordStart = start - 1
        while (isCandidateAt(text, wordStart)) wordStart--
        if (text.getOrNull(wordStart) != '$' || isNameAt(text, wordStart - 1)) return null
        var wordEnd = start
        while (isCandidateAt(text, wordEnd)) wordEnd++
        return Token(wordStart, wordEnd, text.substring(wordStart, wordEnd), text.substring(wordStart + 1, start))
    }

    /** Use the catalogue to distinguish a Claude plugin qualifier from a prose colon. */
    fun resolveToken(token: Token, skills: List<SkillSummary>): Token? {
        val colon = token.word.indexOf(':')
        if (colon < 0) return token
        val secondColon = token.word.indexOf(':', colon + 1)
        val qualifiedEnd = if (secondColon < 0) token.word.length else secondColon
        val plugin = token.word.substring(1, colon)
        val name = token.word.substring(colon + 1, qualifiedEnd)
        val caretIsAfterColon = token.query.length >= colon
        val qualified = skills.any { skill ->
            val separator = skill.name.indexOf(':')
            if (separator < 0) return@any false
            val pluginMatches = skill.name.substring(0, separator).startsWith(plugin, ignoreCase = true)
            val namePrefix = if (caretIsAfterColon) token.query.substring(colon) else name
            pluginMatches && skill.name.substring(separator + 1).startsWith(namePrefix, ignoreCase = true)
        }
        val length = if (qualified) qualifiedEnd else colon
        if (token.query.length + 1 > length) return null
        return token.copy(end = token.start + length, word = token.word.take(length))
    }

    fun filter(skills: List<SkillSummary>, query: String, recent: List<String>): List<SkillSummary> {
        val term = skillNameKey(query)
        val recency = recent.withIndex().associate { (rank, name) -> name to rank }
        return skills.mapNotNull { skill ->
            val name = skillNameKey(skill.name)
            val rank = when {
                name == term -> 0
                name.startsWith(term) -> 1
                term in name -> 2
                else -> return@mapNotNull null
            }
            rank to skill
        }.sortedWith(compareBy(
            { it.first },
            { recency[skillNameKey(it.second.name)] ?: Int.MAX_VALUE },
            { skillNameKey(it.second.name) },
            { it.second.name },
        )).map { it.second }
    }

    fun insert(text: String, suggestion: SkillSuggestion): Edit {
        val start = suggestion.token.start
        val end = suggestion.replacementEnd
        val name = suggestion.skill.name
        // Claude and Codex consume one whitespace-delimited leading token. Inline
        // references keep their existing punctuation and spacing verbatim.
        val next = text.getOrNull(end)
        val leading = text.take(start).all { it.isWhitespace() || it == '\uFEFF' }
        val addSpace = next == null || (leading && !next.isWhitespace() && next != '\uFEFF')
        val replaced = text.replaceRange(start, end, "\$$name" + if (addSpace) " " else "")
        val separatorLength = when {
            addSpace -> 1
            text.startsWith("\r\n", end) -> 2
            else -> Character.charCount(text.codePointAt(end))
        }
        return Edit(replaced, start + 1 + name.length + separatorLength)
    }
}

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
        // Interior dots are provisional until the catalogue resolves the boundary.
        isNameChar(text, index - 1) && isNameChar(text, index + 1)
    } else {
        isNameChar(text, index)
    }

    private fun isCandidateAt(text: String, index: Int, caret: Int): Boolean = when (text.getOrNull(index)) {
        ':' -> isNameChar(text, index - 1) &&
            (index == caret - 1 || index == text.lastIndex || isNameChar(text, index + 1))
        // Just-typed punctuation is provisional even before a space or at the end.
        '.' -> if (index == caret - 1) isNameChar(text, index - 1) else isNameAt(text, index)
        else -> isNameAt(text, index)
    }

    fun token(text: String, start: Int, end: Int): Token? {
        if (start != end || start !in 1..text.length) return null
        var wordStart = start - 1
        while (isCandidateAt(text, wordStart, start)) wordStart--
        if (text.getOrNull(wordStart) != '$' || isNameAt(text, wordStart - 1)) return null
        var wordEnd = start
        while (isCandidateAt(text, wordEnd, start)) wordEnd++
        return Token(wordStart, wordEnd, text.substring(wordStart, wordEnd), text.substring(wordStart + 1, start))
    }

    /** Exact catalogue tokens outrank partial suffixes that only match the selected skill. */
    fun replacementEnd(token: Token, skill: SkillSummary, knownNames: Set<String>, maxNameLength: Int): Int {
        val word = token.word
        val caret = token.query.length + 1 // Include '$'.
        val beforeCaret = caret - 1
        // A caret just past punctuation can still sit before prose after an existing skill.
        val start = if (word[beforeCaret] in ".:" && skillNameKey(word.substring(1, beforeCaret)) in knownNames) {
            beforeCaret
        } else caret
        val boundary = word.indexOfAny(charArrayOf('.', ':'), startIndex = start)
        if (boundary == -1) return token.end
        val name = skillNameKey(skill.name)
        var partialEnd: Int? = null
        for (end in minOf(word.length, maxNameLength + 1) downTo boundary + 1) {
            if (end < word.length && word[end] !in ".:") continue
            val candidate = skillNameKey(word.substring(1, end))
            if (candidate in knownNames) return token.start + end
            if (partialEnd == null && candidate in name) partialEnd = end
        }
        return token.start + (partialEnd ?: boundary)
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

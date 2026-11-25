package app.hapi.companion.feature.chat.composer

import app.hapi.protocol.wire.SkillSummary

/** A row belongs to one active token and one catalogue load, not just a skill name. */
class SkillSuggestion internal constructor(
    val skill: SkillSummary,
    internal val token: SkillSuggestions.Token,
    internal val opening: Long,
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

    fun token(text: String, start: Int, end: Int): Token? {
        if (start != end || start !in 1..text.length) return null
        var wordStart = start - 1
        while (isNameAt(text, wordStart)) wordStart--
        if (text.getOrNull(wordStart) != '$' || isNameAt(text, wordStart - 1)) return null
        var wordEnd = start
        while (isNameAt(text, wordEnd)) wordEnd++
        return Token(wordStart, wordEnd, text.substring(wordStart, wordEnd), text.substring(wordStart + 1, start))
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

    fun insert(text: String, token: Token, name: String): Edit {
        // Keep existing punctuation and whitespace verbatim; only a bare word at EOF needs a space.
        val suffix = if (token.end == text.length) " " else ""
        val replaced = text.replaceRange(token.start, token.end, "\$$name$suffix")
        val separatorLength = when {
            token.end == text.length -> 1 // The appended space.
            text.startsWith("\r\n", token.end) -> 2
            else -> Character.charCount(text.codePointAt(token.end))
        }
        return Edit(replaced, token.start + 1 + name.length + separatorLength)
    }
}

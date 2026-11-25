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

    private fun isNameChar(char: Char?): Boolean = char != null && (
        char.isLetterOrDigit() || char.isSurrogate() || char in "-_" ||
            char.category == CharCategory.NON_SPACING_MARK || char.category == CharCategory.COMBINING_SPACING_MARK
    )

    private fun isBoundary(text: String, index: Int): Boolean {
        val char = text[index]
        return when (char) {
            // A dot in foo.bar belongs to the name; a sentence-final dot does not.
            '.' -> !(isNameChar(text.getOrNull(index - 1)) && isNameChar(text.getOrNull(index + 1)))
            '-', '_' -> false
            '<', '>', '\uFFFC' -> true
            else -> char.isWhitespace() || when (char.category) {
                CharCategory.CONNECTOR_PUNCTUATION,
                CharCategory.DASH_PUNCTUATION,
                CharCategory.START_PUNCTUATION,
                CharCategory.END_PUNCTUATION,
                CharCategory.INITIAL_QUOTE_PUNCTUATION,
                CharCategory.FINAL_QUOTE_PUNCTUATION,
                CharCategory.OTHER_PUNCTUATION -> true
                else -> false
            }
        }
    }

    fun token(text: String, start: Int, end: Int): Token? {
        if (start != end || start !in 1..text.length || isBoundary(text, start - 1)) return null
        var wordStart = start - 1
        while (wordStart > 0 && !isBoundary(text, wordStart - 1)) wordStart--
        if (text[wordStart] != '$') return null
        var wordEnd = start
        while (wordEnd < text.length && !isBoundary(text, wordEnd)) wordEnd++
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
        val separatorLength = if (text.startsWith("\r\n", token.end)) 2 else 1
        return Edit(replaced, token.start + 1 + name.length + separatorLength)
    }
}

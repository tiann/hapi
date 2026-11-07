package app.hapi.companion.feature.chat.composer

import app.hapi.protocol.wire.SkillSummary
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class SkillSuggestionsTest {

    private fun skill(name: String) = SkillSummary(name = name, description = null)

    // ------------------------------------------------------------ queryOf --

    @Test
    fun `queryOf triggers only on a lone dollar token`() {
        assertEquals("", SkillSuggestions.queryOf("$"))
        assertEquals("code", SkillSuggestions.queryOf("\$code"))
        assertEquals("code-review.v2", SkillSuggestions.queryOf("\$code-review.v2"))
    }

    @Test
    fun `queryOf rejects plain text slash input and post-token input`() {
        assertNull(SkillSuggestions.queryOf(""))
        assertNull(SkillSuggestions.queryOf("hello"))
        assertNull(SkillSuggestions.queryOf("/cmd"))
        assertNull(SkillSuggestions.queryOf("say \$code"))
        // A space or newline after the token closes the menu.
        assertNull(SkillSuggestions.queryOf("\$code "))
        assertNull(SkillSuggestions.queryOf("\$code now"))
        assertNull(SkillSuggestions.queryOf("\$code\nnext"))
    }

    // -------------------------------------------------------------- filter --

    @Test
    fun `empty query ranks by recency then name`() {
        val skills = listOf(skill("alpha"), skill("delta"), skill("bravo"))
        val recent = mapOf("delta" to 30L, "bravo" to 20L)
        assertEquals(
            listOf("delta", "bravo", "alpha"),
            SkillSuggestions.filter(skills, "", recent).map { it.name },
        )
        // Without recency: pure name order (case-insensitive).
        assertEquals(
            listOf("alpha", "bravo", "delta"),
            SkillSuggestions.filter(skills, "").map { it.name },
        )
    }

    @Test
    fun `scoring ranks exact then prefix then contains`() {
        val skills = listOf(skill("container"), skill("con"), skill("confirm"), skill("second"))
        // "con": exact. "confirm"/"container": prefix. "second": contains
        // ("se·con·d") — includes ranks last.
        assertEquals(
            listOf("con", "confirm", "container", "second"),
            SkillSuggestions.filter(skills, "con").map { it.name },
        )
    }

    @Test
    fun `levenshtein hits rank after contains and drop beyond the budget`() {
        val skills = listOf(skill("deploy"), skill("display"), skill("delete"))
        // Query "deployy": exact-less. "deploy" is distance 1 → 3+1=4;
        // "display"/"delete" exceed max(2, floor(7/2)=3) edits → dropped.
        assertEquals(
            listOf("deploy"),
            SkillSuggestions.filter(skills, "deployy").map { it.name },
        )
        // Query "depl": budget max(2, 2). "deploy" distance 2 → 5. "delete"
        // distance 3 → dropped ("display" further still).
        assertEquals(
            listOf("deploy"),
            SkillSuggestions.filter(skills, "depl").map { it.name },
        )
    }

    @Test
    fun `ties break recency desc then name`() {
        val skills = listOf(skill("b-one"), skill("a-nine"), skill("c-three"))
        val recent = mapOf("c-three" to 10L)
        // All contain "e": same rank, recency lifts c-three, then name order.
        assertEquals(
            listOf("c-three", "a-nine", "b-one"),
            SkillSuggestions.filter(skills, "e", recent).map { it.name },
        )
    }

    @Test
    fun `matching is case-insensitive`() {
        val skills = listOf(skill("Code-Review"))
        assertEquals(skills, SkillSuggestions.filter(skills, "CODE"))
    }

    // ---------------------------------------------------------- levenshtein --

    @Test
    fun `levenshtein basics and early exit`() {
        assertEquals(0, SkillSuggestions.levenshtein("abc", "abc", 3))
        assertEquals(3, SkillSuggestions.levenshtein("abc", "", 3))
        assertEquals(1, SkillSuggestions.levenshtein("kitten", "sitten", 2))
        assertEquals(3, SkillSuggestions.levenshtein("kitten", "sitting", 3))
        // A budget below the true distance short-circuits at limit + 1.
        assertEquals(3, SkillSuggestions.levenshtein("kitten", "sitting", 2))
        assertEquals(2, SkillSuggestions.levenshtein("aaaa", "bbbb", 1))
    }
}

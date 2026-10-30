package app.hapi.companion.feature.chat

import app.hapi.protocol.chat.ConversationOutlineItem
import kotlin.test.assertEquals
import org.junit.Test

class OutlineFilterTest {

    private fun entry(id: String, label: String) = ConversationOutlineItem(
        id = "outline:user-text:$id",
        targetBlockId = id,
        label = label,
        createdAt = 1000,
    )

    private val entries = listOf(
        entry("m1", "Implement the outline panel"),
        entry("m2", "Fix the flaky test"),
        entry("m3", "Ship the release"),
    )

    @Test
    fun blankQueryKeepsEverythingInOrder() {
        assertEquals(entries, filterOutlineItems(entries, ""))
        assertEquals(entries, filterOutlineItems(entries, "   \t "))
    }

    @Test
    fun plainQueryMatchesSubstringsCaseInsensitively() {
        assertEquals(
            listOf("outline:user-text:m2"),
            filterOutlineItems(entries, "flaky").map { it.id },
        )
        assertEquals(
            listOf("outline:user-text:m1"),
            filterOutlineItems(entries, "OUTLINE").map { it.id },
        )
        assertEquals(
            listOf("outline:user-text:m3"),
            filterOutlineItems(entries, "shIP").map { it.id },
        )
    }

    @Test
    fun queryIsTrimmedBeforeMatching() {
        assertEquals(
            filterOutlineItems(entries, "ship").map { it.id },
            filterOutlineItems(entries, "  ship  ").map { it.id },
        )
    }

    @Test
    fun wildcardStarMatchesAcrossWords() {
        assertEquals(
            listOf("outline:user-text:m1"),
            filterOutlineItems(entries, "implement*panel").map { it.id },
        )
        assertEquals(
            emptyList<String>(),
            filterOutlineItems(entries, "implement*release*now").map { it.id },
        )
    }

    @Test
    fun wildcardQuestionMarkMatchesOneCharacter() {
        // Wildcard patterns match the whole label: `?` eats exactly one code point.
        assertEquals(
            listOf("outline:user-text:m2"),
            filterOutlineItems(entries, "fix the flak? test").map { it.id },
        )
        assertEquals(
            emptyList<String>(),
            filterOutlineItems(entries, "fix the flak?? test").map { it.id },
        )
    }
}

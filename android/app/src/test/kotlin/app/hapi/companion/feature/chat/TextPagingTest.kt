package app.hapi.companion.feature.chat

import org.junit.Assert.*
import org.junit.Test

class TextPagingTest {
    @Test fun ordinaryMultiscreenMessagesStayComplete() {
        for (source in listOf("x".repeat(8_000), ("line\n".repeat(119) + "end"))) {
            assertEquals(source, messagePreview(source).text)
        }
        assertEquals(2_000, messagePreview("x".repeat(8_001)).end)
        val lines = "x\n".repeat(120) + "end"
        assertTrue(messagePreview(lines).end < lines.length)
    }

    @Test fun pagesPreserveGraphemesAndExactWhitespace() {
        val atoms = listOf("👨‍👩‍👧‍👦", "👩🏽‍💻", "e\u0301", "🇨🇳", "\r\n", "中", " ", "\t")
        val source = atoms.joinToString("").repeat(40)
        var position = 0
        val parts = mutableListOf<String>()
        while (position < source.length) {
            val page = readTextPage(source, position, TextBudget(1, 2))
            assertTrue(page.end > position)
            assertTrue(page.text in atoms)
            parts += page.text
            position = page.end
        }
        assertEquals(source, parts.joinToString(""))
    }

    @Test fun giantSingleLinesAndNewlinesHaveBoundedLayoutInput() {
        val giant = "x".repeat(1_000_000)
        assertEquals(2_000, messagePreview(giant).text.length)
        assertEquals(4_000, readTextPage(giant).text.length)
        assertTrue(readTextPage("\n".repeat(1_000_000)).text.length <= 80)
        assertEquals(TextPage("", 0), readTextPage(""))
    }
}

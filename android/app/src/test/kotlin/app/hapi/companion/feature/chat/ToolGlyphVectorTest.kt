package app.hapi.companion.feature.chat

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

class ToolGlyphVectorTest {
    @Test fun everyGlyphMapsToADistinctVector() {
        val vectors = ToolGlyph.entries.map { it.vector() }
        assertEquals(ToolGlyph.entries.size, vectors.size)
        vectors.forEach { assertNotNull(it) }
        assertEquals(ToolGlyph.entries.size, vectors.toSet().size)
    }
}

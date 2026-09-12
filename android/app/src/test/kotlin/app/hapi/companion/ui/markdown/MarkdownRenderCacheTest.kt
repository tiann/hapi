package app.hapi.companion.ui.markdown

import kotlin.test.assertNotSame
import kotlin.test.assertNull
import kotlin.test.assertSame
import org.junit.Test

class MarkdownRenderCacheTest {
    @Test fun `ready hits survive recycling and eviction is bounded`() {
        val cache = MarkdownRenderCache(maxCost = 32)
        val first = cache.document("one")
        assertSame(first, cache.cached("one"))
        cache.document("two")
        assertNull(cache.cached("one"))
        assertNotSame(first, cache.document("one"))
    }

    @Test fun `oversize trees render but do not enter the shared cache`() {
        val cache = MarkdownRenderCache(maxCost = 8)
        cache.document("long document")
        assertNull(cache.cached("long document"))
    }
}

package app.hapi.companion.ui.markdown

import androidx.compose.runtime.staticCompositionLocalOf

internal val LocalMarkdownRenderCache = staticCompositionLocalOf<MarkdownRenderCache?> { null }

/** Per-chat LRU. Trees are normalized before publication, then read-only.
 * Call document/prepare off the UI thread; cached is a synchronous ready hit. */
internal class MarkdownRenderCache(private val maxCost: Long = 8L * 1024 * 1024) {
    private val entries = LinkedHashMap<String, ParsedMarkdown>(16, 0.75f, true)
    private var cost = 0L

    @Synchronized fun cached(text: String): ParsedMarkdown? = entries[text]

    fun document(text: String): ParsedMarkdown {
        cached(text)?.let { return it }
        val parsed = prepareDocument(text)
        synchronized(this) {
            entries[text]?.let { return it }
            val size = costOf(text)
            if (size <= maxCost) {
                entries[text] = parsed
                cost += size
                while (cost > maxCost || entries.size > 800) {
                    val iterator = entries.iterator()
                    val oldest = iterator.next()
                    cost -= costOf(oldest.key)
                    iterator.remove()
                }
            }
        }
        return parsed
    }

    fun prepare(sources: Set<String>) {
        for (text in sources) {
            if (costOf(text) <= maxCost) document(text)
        }
    }

    // Approximate AST + source cost, not a heap-size guarantee.
    private fun costOf(text: String): Long = maxOf(1, text.length.toLong() * 8)
}

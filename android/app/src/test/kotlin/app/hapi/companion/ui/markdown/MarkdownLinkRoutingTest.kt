package app.hapi.companion.ui.markdown

import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.buildAnnotatedString
import app.hapi.companion.ui.theme.HapiLightExtendedColors
import app.hapi.protocol.markdown.HrefDecision
import app.hapi.protocol.markdown.MarkdownTransforms
import kotlin.test.Test
import kotlin.test.assertEquals
import org.commonmark.node.Link
import org.commonmark.node.Node

/**
 * Routing decisions of [appendLink]: which handler a markdown link resolves
 * to, by href. The regression classes here are links whose LABEL equals their
 * destination — the autolink heuristic (text == destination) used to run
 * first and reclassified `/sessions/x` citations as URLs, where the
 * scheme-less path is Blocked and the citation rendered inert (web A()
 * resolves every link by href before label shape).
 */
class MarkdownLinkRoutingTest {

    private val events = mutableListOf<String>()
    private val handler = object : MarkdownLinkHandler {
        override fun onFilePath(path: String, line: Int?) {
            events += "file:$path"
        }

        override fun onSessionReference(sessionId: String) {
            events += "session:$sessionId"
        }

        override fun onUrl(url: String, decision: HrefDecision) {
            events += "url:$url"
        }
    }
    private val ctx = InlineContext(HapiLightExtendedColors, handler)

    /** First Link node in the parsed markdown (breadth-first walk). */
    private fun firstLink(markdown: String): Link {
        val queue = ArrayDeque<Node>()
        var root: Node? = MarkdownTransforms.parse(markdown)
        while (root != null) {
            if (root is Link) return root
            var child = root.firstChild
            while (child != null) {
                queue.addLast(child)
                child = child.next
            }
            root = queue.removeFirstOrNull()
        }
        error("no Link node in: $markdown")
    }

    private fun render(markdown: String): AnnotatedString = buildAnnotatedString {
        appendLink(firstLink(markdown), ctx)
    }

    private fun linkTags(annotated: AnnotatedString): List<String> =
        annotated.getLinkAnnotations(0, annotated.length)
            .map { it.item }
            .filterIsInstance<LinkAnnotation.Clickable>()
            .map { it.tag }

    @Test
    fun `label equals destination session citation navigates to the session`() {
        val annotated = render("[/sessions/abc-def](/sessions/abc-def)")
        // Before the fix this fell into the autolink branch, classified the
        // scheme-less path as Blocked and produced NO clickable annotation.
        assertEquals(listOf("hapi-session:abc-def"), linkTags(annotated))
    }

    @Test
    fun `labeled session citations keep navigating`() {
        assertEquals(
            listOf("hapi-session:abc-def"),
            linkTags(render("[the earlier chat](/sessions/abc-def)")),
        )
        assertEquals(
            listOf("hapi-session:a/b"),
            linkTags(render("[/sessions/a%2Fb](/sessions/a%2Fb)")),
        )
    }

    @Test
    fun `label equals destination file citation still routes to the file viewer`() {
        // Text == destination here too, but a workspace file href is not a
        // session path — it keeps its file-viewer semantics.
        assertEquals(listOf("hapi-file:src/app.ts"), linkTags(render("[src/app.ts](src/app.ts)")))
    }

    @Test
    fun `autolinked urls keep their classified semantics`() {
        // The autolink extension wraps the bare URL into a Link whose text
        // equals its destination, swallowing the trailing CJK comma; the
        // session branch must not steal URLs (scheme guard) and the CJK
        // strip keeps working.
        val annotated = render("see https://x.dev/a，")
        assertEquals(listOf("url:https://x.dev/a"), linkTags(annotated))
        assertEquals("https://x.dev/a，", annotated.text)
    }

    @Test
    fun `listener wiring opens the cited session`() {
        val annotated = render("[/sessions/abc-def](/sessions/abc-def)")
        val link = annotated.getLinkAnnotations(0, annotated.length)
            .map { it.item }
            .filterIsInstance<LinkAnnotation.Clickable>()
            .first()
        link.linkInteractionListener?.onClick(link)
        assertEquals(listOf("session:abc-def"), events)
    }
}

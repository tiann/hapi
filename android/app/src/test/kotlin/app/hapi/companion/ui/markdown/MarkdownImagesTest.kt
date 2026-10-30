package app.hapi.companion.ui.markdown

import app.hapi.protocol.markdown.MarkdownTransforms
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import org.commonmark.node.Image
import org.commonmark.node.Node

class MarkdownImagesTest {

    // ── src routing (web `denyOnlyTransform` parity) ─────────────────────────

    @Test
    fun `scheme-less srcs stay relative like the web pass-through`() {
        assertEquals(MarkdownImageSrc.Relative("assets/shot.png"), resolveMarkdownImageSrc("assets/shot.png"))
        assertEquals(
            MarkdownImageSrc.Relative("/api/sessions/s1/generated-images/g1"),
            resolveMarkdownImageSrc("/api/sessions/s1/generated-images/g1"),
        )
        assertEquals(MarkdownImageSrc.Relative("#fragment"), resolveMarkdownImageSrc("#fragment"))
        // web 同构: protocol-relative srcs classify as relative (the web lets the
        // browser dispatch them cross-origin; native hub-joins and fails safe).
        assertEquals(MarkdownImageSrc.Relative("//cdn.example.com/x.png"), resolveMarkdownImageSrc("//cdn.example.com/x.png"))
    }

    @Test
    fun `http and https srcs are absolute loadable images`() {
        assertEquals(MarkdownImageSrc.Absolute("https://example.com/a.png"), resolveMarkdownImageSrc("https://example.com/a.png"))
        assertEquals(MarkdownImageSrc.Absolute("http://example.com/b.webp?x=1"), resolveMarkdownImageSrc("http://example.com/b.webp?x=1"))
    }

    @Test
    fun `denied and unrenderable schemes degrade to the link fallback`() {
        // The web strips data: srcs (known upstream limitation); native matches.
        assertNull(resolveMarkdownImageSrc("data:image/png;base64,AAAA"))
        assertNull(resolveMarkdownImageSrc("javascript:alert(1)"))
        assertNull(resolveMarkdownImageSrc("vbscript:x"))
        assertNull(resolveMarkdownImageSrc("file:///etc/logo.png"))
        // A browser cannot render these as images either; native keeps today's
        // classified-link degradation instead of a broken image.
        assertNull(resolveMarkdownImageSrc("mailto:a@b.example"))
        assertNull(resolveMarkdownImageSrc("vscode://file/a.png"))
        assertNull(resolveMarkdownImageSrc("C:/win/path.png"))
        assertNull(resolveMarkdownImageSrc("   "))
        assertNull(resolveMarkdownImageSrc(""))
    }

    @Test
    fun `percent-encoded and control-character scheme bypasses are unwrapped`() {
        // A literal colon with obfuscation still unwraps to a denied scheme.
        assertNull(resolveMarkdownImageSrc("java\nscript:alert(1)"))
        assertNull(resolveMarkdownImageSrc("java%0Ascript:alert(1)"))
        // web 同构: a src with NO literal colon (the %253A stays encoded) is
        // scheme-less, so the web passes it through as a relative URL too —
        // harmless as an image request (the hub 404s it).
        assertEquals(
            MarkdownImageSrc.Relative("javascript%253Aalert(1)"),
            resolveMarkdownImageSrc("javascript%253Aalert(1)"),
        )
    }

    // ── spec building (inline vs fallback decision) ──────────────────────────

    private val hubResolver: (String) -> String? = { path ->
        "https://hub.example.test/${path.trimStart('/')}"
    }

    @Test
    fun `absolute srcs render regardless of media availability`() {
        val spec = markdownInlineImageSpec("https://example.com/a.png", "alt text", 0)
        assertEquals("hapi-md-img:0", spec?.id)
        assertEquals("https://example.com/a.png", spec?.url)
        assertEquals(false, spec?.authed)
    }

    @Test
    fun `relative srcs need the authed loader and a live resolver`() {
        assertNull(markdownInlineImageSpec("/api/x.png", "a", 0, hubResolver, hasAuthedLoader = false))
        assertNull(markdownInlineImageSpec("/api/x.png", "a", 0, { null }, hasAuthedLoader = true))
        val spec = markdownInlineImageSpec("/api/x.png", "a", 1, hubResolver, hasAuthedLoader = true)
        assertEquals("hapi-md-img:1", spec?.id)
        assertEquals("https://hub.example.test/api/x.png", spec?.url)
        assertEquals(true, spec?.authed)
    }

    @Test
    fun `denied srcs never produce a spec`() {
        assertNull(markdownInlineImageSpec("data:image/png;base64,AAAA", "a", 0, hubResolver, hasAuthedLoader = true))
    }

    // ── alt extraction ────────────────────────────────────────────────────────

    @Test
    fun `alt text collects nested inline literals`() {
        assertEquals("shot of the bug", imageAltText(onlyImage("![*shot* of the `bug`](u)")))
        assertEquals("", imageAltText(onlyImage("![](u)")))
    }

    // ── placeholder key uniqueness and stability ─────────────────────────────

    @Test
    fun `image placeholder ids are unique per span and stable across parses`() {
        val text = "before ![one](https://a/1.png) middle ![two](assets/2.png) ![three](https://a/3.png) after"
        val first = renderedIds(MarkdownTransforms.parse(text))
        val second = renderedIds(MarkdownTransforms.parse(text))
        assertEquals(listOf("hapi-md-img:0", "hapi-md-img:1", "hapi-md-img:2"), first)
        assertEquals(first, second)
        assertEquals(first.size, first.toSet().size)
    }

    @Test
    fun `ordinals count every image node so degraded images never shift later ids`() {
        val text = "![denied](data:image/png;base64,AA) ![kept](https://a/1.png)"
        val doc = MarkdownTransforms.parse(text)
        // The denied image consumes ordinal 0 (mirroring the walker's counter);
        // the kept one stays at ordinal 1 in both parses.
        assertEquals(listOf(null, "hapi-md-img:1"), specIdsWithDegradation(doc))
        assertEquals(specIdsWithDegradation(MarkdownTransforms.parse(text)), specIdsWithDegradation(doc))
    }

    // ── helpers (mirror the production walker's document-order traversal) ─────

    private fun onlyImage(markdown: String): Image {
        val doc = MarkdownTransforms.parse(markdown)
        val images = collectImages(doc)
        assertEquals(1, images.size, "expected exactly one image in: $markdown")
        return images.first()
    }

    private fun renderedIds(doc: Node): List<String> =
        specIdsWithDegradation(doc).filterNotNull()

    private fun specIdsWithDegradation(doc: Node): List<String?> {
        val ids = mutableListOf<String?>()
        collectImages(doc).forEachIndexed { ordinal, image ->
            val spec = markdownInlineImageSpec(
                destination = image.destination.orEmpty(),
                alt = "",
                ordinal = ordinal,
                hubMediaUrl = hubResolver,
                hasAuthedLoader = true,
            )
            ids.add(spec?.id)
        }
        return ids
    }

    /** Depth-first document-order image collection, like `appendInlineChildren`. */
    private fun collectImages(root: Node): List<Image> {
        val images = mutableListOf<Image>()
        fun walk(from: Node?) {
            var child = from?.firstChild
            while (child != null) {
                if (child is Image) images.add(child)
                walk(child)
                child = child.next
            }
        }
        walk(root)
        return images
    }
}

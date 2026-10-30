package app.hapi.companion.ui.markdown

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Pure JVM tests for the offline mermaid document builder and fence dispatch,
 * mirroring the web component's requirements: exact-key dispatch, strict
 * security initialization, the web's dark/light palettes verbatim, the
 * validate-then-render gate, per-instance svg ids, and no http(s) reference
 * escaping into the document.
 */
class MermaidDocumentTest {

    private fun spec(dark: Boolean = false, id: String = "1") =
        MermaidRenderSpec(code = "flowchart LR\n A --> B", dark = dark, diagramId = id)

    // ── Fence dispatch (web: MARKDOWN_COMPONENTS_BY_LANGUAGE exact key) ──

    @Test
    fun dispatchMatchesExactlyLowercaseMermaid() {
        assertTrue(isMermaidFence("mermaid"))
    }

    @Test
    fun dispatchRejectsCaseVariantsOtherLanguagesAndNoLanguage() {
        // Case-sensitive like the web's exact key lookup — the info string's
        // casing travels with the fence.
        assertFalse(isMermaidFence("Mermaid"))
        assertFalse(isMermaidFence("MERMAID"))
        assertFalse(isMermaidFence("mermaid-js"))
        assertFalse(isMermaidFence("kotlin"))
        assertFalse(isMermaidFence(""))
        assertFalse(isMermaidFence(null))
    }

    // ── Offline iron rule ──

    @Test
    fun documentReferencesOnlyLocalMermaidAssets() {
        val html = buildMermaidDocument(spec(), generation = 1)
        assertTrue(html.contains("""<script src="mermaid.min.js"></script>"""))
        assertFalse(html.contains("http://"), "no http URLs")
        assertFalse(html.contains("https://"), "no https URLs")
        assertFalse(html.contains("//cdn"), "no CDN references")
        assertFalse(html.contains("import"), "no module imports — classic script only")
    }

    // ── Theme injection (web dark/light palettes verbatim) ──

    @Test
    fun documentInjectsDarkThemeAndPalette() {
        val html = buildMermaidDocument(spec(dark = true), generation = 1)
        assertTrue(html.contains("theme: 'dark',"))
        assertTrue(html.contains("\"primaryColor\":\"#323843\""))
        assertTrue(html.contains("\"background\":\"#2a2f35\""))
        assertTrue(html.contains("\"noteTextColor\":\"#edf1f5\""))
    }

    @Test
    fun documentInjectsLightThemeAndPalette() {
        val html = buildMermaidDocument(spec(dark = false), generation = 1)
        assertTrue(html.contains("theme: 'default',"))
        assertTrue(html.contains("\"primaryColor\":\"#f8fbff\""))
        assertTrue(html.contains("\"background\":\"#f5f6f7\""))
        assertTrue(html.contains("\"noteTextColor\":\"#2d333b\""))
    }

    @Test
    fun palettesCarryTheWebKeysInOrder() {
        val expectedKeys = listOf(
            "primaryColor", "primaryTextColor", "primaryBorderColor", "lineColor",
            "tertiaryColor", "background", "mainBkg", "secondBkg", "tertiaryBkg",
            "clusterBkg", "clusterBorder", "edgeLabelBackground", "actorBkg",
            "actorBorder", "actorTextColor", "signalColor", "labelBoxBkgColor",
            "labelTextColor", "loopTextColor", "noteBkgColor", "noteTextColor",
        )
        assertEquals(expectedKeys, MERMAID_THEME_VARIABLES_DARK.keys.toList())
        assertEquals(expectedKeys, MERMAID_THEME_VARIABLES_LIGHT.keys.toList())
        assertEquals(MERMAID_THEME_VARIABLES_DARK.size, 21)
    }

    // ── Initialization security posture ──

    @Test
    fun documentInitializesMermaidLikeTheWeb() {
        val html = buildMermaidDocument(spec(), generation = 1)
        assertTrue(html.contains("securityLevel: 'strict'"))
        assertTrue(html.contains("startOnLoad: false"))
        assertTrue(html.contains("suppressErrorRendering: true"))
        // Swallow the global parse-error side-effect channel.
        assertTrue(html.contains("mermaid.setParseErrorHandler"))
    }

    // ── Validate-then-render gate (#785/#813/#1117) ──

    @Test
    fun documentValidatesSilentlyBeforeRendering() {
        val html = buildMermaidDocument(spec(), generation = 1)
        assertTrue(html.contains("mermaid.parse(code, { suppressErrors: true })"))
        assertTrue(html.contains("mermaid.render(elementId, code)"))
        assertTrue(html.contains("Mermaid rejected this diagram but gave no reason."))
        assertTrue(html.contains("Mermaid could not render this diagram."))
    }

    // ── svg-id uniqueness (web: mermaid-${useId()}) ──

    @Test
    fun documentUsesUniqueElementIdPerInstance() {
        val first = buildMermaidDocument(spec(id = "7"), generation = 1)
        val second = buildMermaidDocument(spec(id = "8"), generation = 1)
        assertTrue(first.contains("var elementId = \"mermaid-7\";"))
        assertTrue(second.contains("var elementId = \"mermaid-8\";"))
    }

    // ── Stale-callback filtering ──

    @Test
    fun documentEmbedsItsGeneration() {
        val html = buildMermaidDocument(spec(), generation = 12)
        assertTrue(html.contains("var GEN = 12;"))
        assertTrue(html.contains("MermaidBridge.onRendered(GEN)"))
        assertTrue(html.contains("MermaidBridge.onError(GEN, message)"))
    }

    // ── Payload safety ──

    @Test
    fun diagramSourceCannotBreakOutOfTheInlineScript() {
        val hostile = "</script><script>alert(1)</script>"
        val html = buildMermaidDocument(spec().copy(code = hostile), generation = 1)
        assertFalse(html.contains("</script><script>"), "raw </script><script> must not survive")
        assertTrue(html.contains("\\u003c"), "expected \\u003c escape of the payload")
    }

    // ── Sizing: adaptive width, horizontal scroll for wide diagrams ──

    @Test
    fun documentScrollsWideDiagramsAndShrinksSvgToContainer() {
        val html = buildMermaidDocument(spec(), generation = 1)
        assertTrue(html.contains("#diagram { overflow-x: auto;"))
        assertTrue(html.contains("max-width: 100%; height: auto;"))
        assertTrue(html.contains("margin: 0 auto;"))
        // Height reporting drives the Android-side view height.
        assertTrue(html.contains("MermaidBridge.onHeight(height)"))
        assertTrue(html.contains("ResizeObserver"))
    }
}

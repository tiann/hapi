package app.hapi.companion.ui.markdown

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Pure JVM tests for the offline KaTeX document builder, mirroring the web
 * pipeline's safety requirements: no http(s) reference escapes into the
 * document, TeX payloads cannot break out of the inline script, and error
 * handling follows rehype-katex's three tiers.
 */
class MathDocumentTest {

    @Test
    fun jsonStringLiteralEscapesQuotesAndBackslashes() {
        assertEquals("\"a \\\"b\\\" c\"", jsonStringLiteral("a \"b\" c"))
        assertEquals("\"\\\\frac{1}{2}\"", jsonStringLiteral("\\frac{1}{2}"))
    }

    @Test
    fun jsonStringLiteralEscapesControlCharacters() {
        assertEquals("\"a\\nb\"", jsonStringLiteral("a\nb"))
        assertEquals("\"a\\rb\"", jsonStringLiteral("a\rb"))
        assertEquals("\"a\\tb\"", jsonStringLiteral("a\tb"))
        assertEquals("\"a\\u0001b\"", jsonStringLiteral("a\u0001b"))
        assertEquals("\"\\f\"", jsonStringLiteral("\u000C"))
    }

    @Test
    fun jsonStringLiteralEscapesScriptBreakout() {
        // A raw "</script>" inside the payload would terminate the inline
        // script element; "<" must be escaped.
        val literal = jsonStringLiteral("</script><script>alert(1)</script>")
        assertFalse(literal.contains("</script>"), "raw </script> must not survive")
        assertTrue(literal.contains("\\u003c"), "expected \\u003c escape")
    }

    @Test
    fun jsonStringLiteralEscapesLineAndParagraphSeparators() {
        assertEquals("\"a\\u2028b\\u2029c\"", jsonStringLiteral("a\u2028b\u2029c"))
    }

    @Test
    fun documentReferencesOnlyLocalKatexAssets() {
        val html = buildMathDocument(MathRenderSpec("x", displayMode = true, textColorArgb = 0xFF112233.toInt(), fontSizePx = 18))
        assertTrue(html.contains("katex.min.css"))
        assertTrue(html.contains("katex.min.js"))
        assertFalse(html.contains("http://"), "no http URLs")
        assertFalse(html.contains("https://"), "no https URLs")
        assertFalse(html.contains("//cdn"), "no CDN references")
    }

    @Test
    fun documentInjectsColorSizeAndDisplayMode() {
        val html = buildMathDocument(MathRenderSpec("x", displayMode = true, textColorArgb = 0xFFAB12CD.toInt(), fontSizePx = 21))
        assertTrue(html.contains("color: #AB12CD;"), "6-hex color slot")
        assertTrue(html.contains("font-size: 21px;"), "font size slot")
        assertTrue(html.contains("displayMode: displayMode, throwOnError: true"))
        assertTrue(html.contains("var displayMode = true;"))

        val inline = buildMathDocument(MathRenderSpec("x", displayMode = false, textColorArgb = 0xFF000000.toInt(), fontSizePx = 16))
        assertTrue(inline.contains("var displayMode = false;"))
    }

    @Test
    fun documentRendersThreeErrorTiers() {
        val html = buildMathDocument(MathRenderSpec("x", displayMode = true, textColorArgb = 0xFF000000.toInt(), fontSizePx = 16))
        assertTrue(html.contains("throwOnError: true"))
        assertTrue(html.contains("strict: 'ignore', throwOnError: false"))
        assertTrue(html.contains("katex-fallback"))
        assertTrue(html.contains("pre.textContent = latex"))
    }

    @Test
    fun documentWiresHeightBridge() {
        val html = buildMathDocument(MathRenderSpec("x", displayMode = true, textColorArgb = 0xFF000000.toInt(), fontSizePx = 16))
        assertTrue(html.contains("MathBridge.onHeight(height)"))
        assertTrue(html.contains("ResizeObserver"))
        assertTrue(html.contains("scrollHeight"))
    }

    @Test
    fun templateMarkersInLatexCannotCorruptSlots() {
        // The TeX payload is substituted last, so a formula containing the
        // literal marker strings cannot rewrite the color/size slots.
        val hostile = "\\text{__COLOR__} \\text{__FONTSIZE__} \\text{__LATEX__}"
        val html = buildMathDocument(MathRenderSpec(hostile, displayMode = true, textColorArgb = 0xFF123456.toInt(), fontSizePx = 19))
        assertTrue(html.contains("color: #123456;"), "color slot intact")
        assertTrue(html.contains("font-size: 19px;"), "size slot intact")
        // The payload itself survives verbatim inside the JS literal.
        assertTrue(html.contains(jsonStringLiteral(hostile)))
    }

    @Test
    fun latexPayloadIsJsonEscapedExactlyOnce() {
        val html = buildMathDocument(MathRenderSpec("a \"quoted\" \\frac{1}{2}", displayMode = true, textColorArgb = 0xFF000000.toInt(), fontSizePx = 16))
        assertTrue(html.contains("var latex = \"a \\\"quoted\\\" \\\\frac{1}{2}\";"))
    }
}

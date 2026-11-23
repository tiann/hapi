package app.hapi.companion.ui.markdown

import kotlin.math.roundToInt

/**
 * Pure (JVM-testable) HTML document builder for the offline KaTeX WebView.
 *
 * The document loads `katex.min.css` / `katex.min.js` from the bundled
 * `assets/katex/` directory via the WebView's `file:///android_asset/katex/`
 * base URL — no http(s) URL appears anywhere, and the WebView client blocks
 * network loads on top (offline iron rule).
 *
 * Error semantics mirror the web pipeline (`rehype-katex` three-tier):
 *  1. `throwOnError: true` — render or throw;
 *  2. `strict: 'ignore'` + `throwOnError: false` — KaTeX renders its own red
 *     inline error for unsupported commands;
 *  3. anything still failing degrades to a monospace `<pre>` with the raw TeX
 *     (`color: #cc0000`, `title` carrying the message — web `katex-error`).
 */
internal data class MathRenderSpec(
    val latex: String,
    val displayMode: Boolean,
    /** ARGB color the formula text should inherit (KaTeX uses currentColor). */
    val textColorArgb: Int,
    /** Body font size in CSS px (density-independent like dp); see [spFontToCssPx]. */
    val fontSizePx: Int,
)

// ── CSS px <-> Android unit conversions (WebView boundary) ────────────────

/**
 * Chat font size (sp) -> CSS px for the document body.
 *
 * CSS px and sp are both density-independent units, so only the user's
 * font-scale preference crosses the WebView boundary — never the screen
 * density. Converting through physical pixels (sp x density) instead would
 * inflate the formula by the density factor: 16sp chat text would inject
 * `font-size: 48px` on a density-3 screen and render ~3x too large.
 */
internal fun spFontToCssPx(fontSizeSp: Float, fontScale: Float): Int =
    (fontSizeSp * fontScale).roundToInt().coerceAtLeast(1)

/**
 * Document-reported height (CSS px) -> dp height for the Compose modifier.
 *
 * The document pins `width=device-width, initial-scale=1`, so at the default
 * WebView scale 1 CSS px covers exactly 1 dp; [webViewScale] (from
 * `WebView.scale`, non-1.0 only when zoomed) multiplies each CSS px by the
 * dp it occupies. Treating the reported CSS px as Android physical px and
 * dividing by density instead would shrink the block by the density factor:
 * 90 reported CSS px would become a 30dp view on a density-3 screen.
 */
internal fun cssPxToDp(reportedCssPx: Int, webViewScale: Float = 1f): Float =
    reportedCssPx * webViewScale.coerceAtLeast(0f)

internal fun buildMathDocument(spec: MathRenderSpec): String {
    // The TeX payload is substituted last so a formula that happens to contain
    // a template marker can never rewrite the color/size slots.
    return MATH_DOCUMENT_TEMPLATE
        .replace("__COLOR__", "%06X".format(spec.textColorArgb and 0xFFFFFF))
        .replace("__FONTSIZE__", spec.fontSizePx.coerceAtLeast(1).toString())
        .replace("__DISPLAY__", if (spec.displayMode) "true" else "false")
        .replace("__LATEX__", jsonStringLiteral(spec.latex))
}

/**
 * Minimal JSON string literal: escapes quotes, backslashes and control
 * characters, plus `<` (breaks `</script>` out of the inline script) and the
 * Unicode line/paragraph separators that are illegal in JS string literals.
 */
internal fun jsonStringLiteral(value: String): String {
    val out = StringBuilder(value.length + 2)
    out.append('"')
    for (ch in value) {
        when (ch) {
            '"' -> out.append("\\\"")
            '\\' -> out.append("\\\\")
            '\n' -> out.append("\\n")
            '\r' -> out.append("\\r")
            '\t' -> out.append("\\t")
            '\b' -> out.append("\\b")
            '\u000C' -> out.append("\\f")
            '<' -> out.append("\\u003c")
            '\u2028' -> out.append("\\u2028")
            '\u2029' -> out.append("\\u2029")
            else -> if (ch.code < 0x20) {
                out.append("\\u%04x".format(ch.code))
            } else {
                out.append(ch)
            }
        }
    }
    out.append('"')
    return out.toString()
}

private val MATH_DOCUMENT_TEMPLATE = """
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="katex.min.css">
<script src="katex.min.js"></script>
<style>
html, body { margin: 0; padding: 0; background: transparent; color: #__COLOR__; }
body { font-size: __FONTSIZE__px; line-height: 1.45; }
#math { overflow-x: auto; overflow-y: hidden; }
.katex-display { margin: 0.45em 0; }
.katex-fallback {
  font-family: monospace;
  white-space: pre-wrap;
  word-break: break-word;
  color: #cc0000;
  margin: 0;
}
</style>
</head>
<body>
<div id="math"></div>
<script>
(function () {
  var el = document.getElementById('math');
  var latex = __LATEX__;
  var displayMode = __DISPLAY__;
  try {
    katex.render(latex, el, { displayMode: displayMode, throwOnError: true });
  } catch (error) {
    try {
      katex.render(latex, el, { displayMode: displayMode, strict: 'ignore', throwOnError: false });
    } catch (nested) {
      var pre = document.createElement('pre');
      pre.className = 'katex-fallback';
      pre.textContent = latex;
      pre.title = String(nested && nested.message ? nested.message : nested);
      el.textContent = '';
      el.appendChild(pre);
    }
  }
  function report() {
    var body = document.body;
    var height = Math.max(
      document.documentElement ? document.documentElement.scrollHeight : 0,
      body ? body.scrollHeight : 0
    ) | 0;
    if (height > 0) MathBridge.onHeight(height);
  }
  if (typeof ResizeObserver !== 'undefined' && document.documentElement) {
    new ResizeObserver(report).observe(document.documentElement);
  }
  window.addEventListener('load', report);
  setTimeout(report, 120);
})();
</script>
</body>
</html>
"""

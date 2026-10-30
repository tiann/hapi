package app.hapi.companion.ui.markdown

/**
 * Pure (JVM-testable) pieces for offline Mermaid diagram rendering.
 *
 * The document built here loads the bundled `assets/mermaid/mermaid.min.js`
 * (Mermaid 11.14.0, byte-identical to the web app's locked dependency) as a
 * classic script through the `file:///android_asset/mermaid/` base URL. That
 * dist file is fully self-contained (no imports, no runtime fetches), so no
 * ES-module CORS workaround is needed and no http(s) URL appears anywhere in
 * the document; the WebView client blocks network loads on top (offline iron
 * rule).
 *
 * Behavior mirrors `web/src/components/assistant-ui/mermaid-diagram.tsx`:
 *  - dispatch: fences whose language is exactly `mermaid` (case-sensitive,
 *    like the web's `MARKDOWN_COMPONENTS_BY_LANGUAGE` exact key lookup);
 *  - initialization: `startOnLoad:false`, `securityLevel:'strict'`,
 *    `suppressErrorRendering:true` and the web's dark/light `themeVariables`
 *    palettes verbatim;
 *  - validation gate: parse with `suppressErrors:true`; a falsy result
 *    re-parses once without suppression purely to surface a human-readable
 *    reason, and `render()` is never called after a failed validation;
 *  - ids: every diagram gets a `mermaid-<n>` element id unique to its view
 *    instance (web: `mermaid-${useId()}`), so the scoped `<style>` mermaid
 *    emits per diagram cannot collide across instances;
 *  - sizing: the diagram host scrolls horizontally and the SVG is centered
 *    with `max-width:100%; height:auto` (web: `[&_svg]:mx-auto h-auto
 *    max-w-full` inside an `overflow-x-auto` button).
 */
internal fun isMermaidFence(language: String?): Boolean = language == "mermaid"

/** Inputs for one diagram render; theme flip or code change means a new spec. */
internal data class MermaidRenderSpec(
    val code: String,
    val dark: Boolean,
    /** Per-view-instance suffix for the `mermaid-<id>` element id (M5). */
    val diagramId: String,
)

/**
 * Dark palette from the web component (`#323843` nodes etc. — same family as
 * the Android HapiDark code colors so diagrams blend into the code surface).
 */
internal val MERMAID_THEME_VARIABLES_DARK: Map<String, String> = linkedMapOf(
    "primaryColor" to "#323843",
    "primaryTextColor" to "#edf1f5",
    "primaryBorderColor" to "#6d8fd6",
    "lineColor" to "#94a3b8",
    "tertiaryColor" to "#2d3440",
    "background" to "#2a2f35",
    "mainBkg" to "#323843",
    "secondBkg" to "#2d3440",
    "tertiaryBkg" to "#29313b",
    "clusterBkg" to "#2d3440",
    "clusterBorder" to "#6d8fd6",
    "edgeLabelBackground" to "#2a2f35",
    "actorBkg" to "#323843",
    "actorBorder" to "#6d8fd6",
    "actorTextColor" to "#edf1f5",
    "signalColor" to "#94a3b8",
    "labelBoxBkgColor" to "#323843",
    "labelTextColor" to "#edf1f5",
    "loopTextColor" to "#edf1f5",
    "noteBkgColor" to "#2d3440",
    "noteTextColor" to "#edf1f5",
)

/** Light palette from the web component, same keys in the same order. */
internal val MERMAID_THEME_VARIABLES_LIGHT: Map<String, String> = linkedMapOf(
    "primaryColor" to "#f8fbff",
    "primaryTextColor" to "#2d333b",
    "primaryBorderColor" to "#b8cdfd",
    "lineColor" to "#94a3b8",
    "tertiaryColor" to "#eef4ff",
    "background" to "#f5f6f7",
    "mainBkg" to "#f8fbff",
    "secondBkg" to "#eef4ff",
    "tertiaryBkg" to "#edf3fb",
    "clusterBkg" to "#eef4ff",
    "clusterBorder" to "#b8cdfd",
    "edgeLabelBackground" to "#f5f6f7",
    "actorBkg" to "#f8fbff",
    "actorBorder" to "#b8cdfd",
    "actorTextColor" to "#2d333b",
    "signalColor" to "#94a3b8",
    "labelBoxBkgColor" to "#f8fbff",
    "labelTextColor" to "#2d333b",
    "loopTextColor" to "#2d333b",
    "noteBkgColor" to "#eef4ff",
    "noteTextColor" to "#2d333b",
)

internal fun mermaidThemeVariables(dark: Boolean): Map<String, String> =
    if (dark) MERMAID_THEME_VARIABLES_DARK else MERMAID_THEME_VARIABLES_LIGHT

/**
 * Builds the offline HTML document. [generation] is a monotonic per-WebView
 * counter echoed back by every bridge callback so stale results from a
 * replaced document (theme flip, code edit) are dropped on the Kotlin side.
 */
internal fun buildMermaidDocument(spec: MermaidRenderSpec, generation: Int): String {
    return MERMAID_DOCUMENT_TEMPLATE
        .replace("__GENERATION__", generation.coerceAtLeast(0).toString())
        .replace("__THEME__", if (spec.dark) "'dark'" else "'default'")
        .replace("__THEMEVARS__", jsonObjectLiteral(mermaidThemeVariables(spec.dark)))
        // Payload last: a diagram source containing a template marker can
        // never rewrite the already-substituted slots.
        .replace("__CODE__", jsonStringLiteral(spec.code))
        .replace("__ID__", jsonStringLiteral("mermaid-" + spec.diagramId))
}

/** `{"k":"v",…}` with the map's insertion order preserved (stable for tests). */
private fun jsonObjectLiteral(values: Map<String, String>): String {
    val out = StringBuilder()
    out.append('{')
    for ((key, value) in values) {
        if (out.length > 1) out.append(',')
        out.append(jsonStringLiteral(key))
        out.append(':')
        out.append(jsonStringLiteral(value))
    }
    out.append('}')
    return out.toString()
}

private val MERMAID_DOCUMENT_TEMPLATE = """
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<script src="mermaid.min.js"></script>
<style>
html, body { margin: 0; padding: 0; background: transparent; }
#diagram { overflow-x: auto; overflow-y: hidden; }
#diagram svg { display: block; margin: 0 auto; max-width: 100%; height: auto; }
</style>
</head>
<body>
<div id="diagram"></div>
<script>
(function () {
  var GEN = __GENERATION__;
  var mermaid = globalThis.mermaid;
  function messageOf(error) {
    var message = error && error.message ? error.message : '';
    if (!message && typeof error === 'string') message = error;
    message = String(message).trim();
    return message || 'Mermaid could not render this diagram.';
  }
  function fail(message) {
    MermaidBridge.onError(GEN, message);
  }
  function report() {
    var body = document.body;
    var height = Math.max(
      document.documentElement ? document.documentElement.scrollHeight : 0,
      body ? body.scrollHeight : 0
    ) | 0;
    if (height > 0) MermaidBridge.onHeight(height);
  }
  if (!mermaid) {
    fail('Mermaid failed to load from the bundled assets.');
    return;
  }
  try {
    // Swallow the global parse-error side-effect channel (web: () => undefined).
    mermaid.setParseErrorHandler(function () { return undefined; });
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: __THEME__,
      themeVariables: __THEMEVARS__
    });
  } catch (initError) {
    fail(messageOf(initError));
    return;
  }
  var code = __CODE__;
  var elementId = __ID__;
  // Validation gate (web #785/#813/#1117): parse silently first; only when
  // that fails, re-parse without suppression to capture the reason. render()
  // is never reached after a failed validation.
  Promise.resolve(mermaid.parse(code, { suppressErrors: true }))
    .then(function (valid) {
      if (valid) return null;
      return Promise.resolve(mermaid.parse(code)).then(
        function () { return 'Mermaid rejected this diagram but gave no reason.'; },
        function (parseError) { return messageOf(parseError); }
      );
    })
    .then(function (reason) {
      if (reason) {
        fail(reason);
        return null;
      }
      return Promise.resolve(mermaid.render(elementId, code)).then(
        function (result) {
          var host = document.getElementById('diagram');
          // securityLevel 'strict' means mermaid sanitized the markup itself
          // (DOMPurify); the web injects this same svg with innerHTML.
          host.innerHTML = result && result.svg ? result.svg : '';
          MermaidBridge.onRendered(GEN);
          report();
        },
        function (renderError) { fail(messageOf(renderError)); }
      );
    })
    .catch(function (error) { fail(messageOf(error)); });
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

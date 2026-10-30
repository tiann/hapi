package app.hapi.companion.ui.markdown

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Pure JVM tests for the fallback/source-exit decision, mirroring the web
 * component's `MermaidFallback`: the raw source stays visible while the
 * diagram has not rendered (the async load window shows no error notice) and
 * on failure alongside the error notice; a rendered diagram hides both.
 */
class MermaidFallbackTest {

    @Test
    fun loadingShowsSourceWithoutErrorNotice() {
        val ui = mermaidFallbackUi(MermaidRenderState.Loading)
        assertEquals(MermaidFallbackUi(showSource = true, showErrorNotice = false), ui)
    }

    @Test
    fun errorShowsSourceAndErrorNotice() {
        val ui = mermaidFallbackUi(MermaidRenderState.Error("Parse error: no diagram type detected"))
        assertEquals(MermaidFallbackUi(showSource = true, showErrorNotice = true), ui)
    }

    @Test
    fun renderedHidesFallbackEntirely() {
        val ui = mermaidFallbackUi(MermaidRenderState.Rendered)
        assertEquals(MermaidFallbackUi(showSource = false, showErrorNotice = false), ui)
    }
}

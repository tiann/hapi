package app.hapi.companion.ui.markdown

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color as AndroidColor
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import app.hapi.companion.R
import app.hapi.companion.ui.components.FullTextAction
import app.hapi.companion.ui.theme.HapiExtendedColors
import app.hapi.companion.ui.theme.hapi
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/** Diagram render outcome, driven by the document's bridge callbacks. */
internal sealed interface MermaidRenderState {
    /** Document loading / mermaid parsing; the source fallback is showing. */
    data object Loading : MermaidRenderState

    /** `mermaid.render` produced an SVG that the WebView is displaying. */
    data object Rendered : MermaidRenderState

    /** Validation or rendering failed; [message] is the human-readable reason. */
    data class Error(val message: String) : MermaidRenderState
}

/**
 * What the fallback area below the header should show (pure, JVM-tested).
 *
 * Web semantics (`MermaidFallback`): the raw source stays visible while the
 * diagram has not rendered yet and on failure — it is the block's "view the
 * source" exit — while the failure notice line appears only for an actual
 * error, never during the async loading window (no "could not render" flash
 * before the diagram appears).
 */
internal data class MermaidFallbackUi(
    val showSource: Boolean,
    val showErrorNotice: Boolean,
)

internal fun mermaidFallbackUi(state: MermaidRenderState): MermaidFallbackUi = when (state) {
    MermaidRenderState.Loading -> MermaidFallbackUi(showSource = true, showErrorNotice = false)
    is MermaidRenderState.Error -> MermaidFallbackUi(showSource = true, showErrorNotice = true)
    MermaidRenderState.Rendered -> MermaidFallbackUi(showSource = false, showErrorNotice = false)
}

/** Events forwarded from the document (bridge) and the WebView client. */
internal sealed interface MermaidViewEvent {
    data class Height(val px: Int) : MermaidViewEvent
    data class Rendered(val generation: Int) : MermaidViewEvent
    data class Failed(val generation: Int, val message: String) : MermaidViewEvent
}

/**
 * JS bridge for the mermaid document. Callbacks arrive on the WebView's
 * bridge thread and hop to the main thread; [release] detaches permanently
 * (a callback landing after [WebView.destroy] would otherwise crash).
 */
private class MermaidBridge(mainThread: Handler, private val onEvent: (MermaidViewEvent) -> Unit) {
    private val handler = mainThread
    private val released = AtomicBoolean(false)

    fun release() {
        released.set(true)
    }

    @JavascriptInterface
    fun onHeight(px: Int) {
        post(px > 0) { onEvent(MermaidViewEvent.Height(px)) }
    }

    @JavascriptInterface
    fun onRendered(generation: Int) {
        post(true) { onEvent(MermaidViewEvent.Rendered(generation)) }
    }

    @JavascriptInterface
    fun onError(generation: Int, message: String?) {
        post(true) { onEvent(MermaidViewEvent.Failed(generation, message.orEmpty())) }
    }
    private fun post(condition: Boolean, block: () -> Unit) {
        if (released.get() || !condition) return
        handler.post {
            if (!released.get()) block()
        }
    }
}

/** Monotonic source of per-instance `mermaid-<id>` element ids (web: useId). */
private val MERMAID_DIAGRAM_IDS = AtomicLong(0)

/**
 * [WebView] configured once and reused across recompositions by [render].
 * Hardening identical to [MathWebView]: JS on, file/content access off,
 * network stack blocked, transparent background; the only content ever
 * loaded is [buildMermaidDocument] HTML plus `assets/mermaid/` files through
 * the `file:///android_asset/mermaid/` base URL. Rendered/failed callbacks
 * carry the document generation so results from a replaced document (theme
 * flip, code edit) are dropped; height reports are generation-agnostic and
 * simply overwritten by the next report, exactly like the KaTeX view.
 */
private class MermaidWebView(context: Context) : WebView(context) {
    private val mainThread = Handler(Looper.getMainLooper())
    private val bridge = MermaidBridge(mainThread) { event -> handleEvent(event) }
    private val generationCounter = AtomicInteger(0)
    private val activeGeneration = AtomicInteger(0)
    private var lastSpec: MermaidRenderSpec? = null

    /** Assigned by the composable once at factory time; stable across recompositions. */
    var onEvent: ((MermaidViewEvent) -> Unit)? = null

    init {
        @SuppressLint("SetJavaScriptEnabled")
        settings.apply {
            javaScriptEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            cacheMode = WebSettings.LOAD_NO_CACHE
            blockNetworkLoads = true
        }
        setBackgroundColor(AndroidColor.TRANSPARENT)
        isVerticalScrollBarEnabled = false
        isHorizontalScrollBarEnabled = false
        addJavascriptInterface(bridge, "MermaidBridge")
        webViewClient = OfflineMarkdownWebViewClient { px ->
            mainThread.post { handleEvent(MermaidViewEvent.Height(px)) }
        }
    }

    /**
     * Load [spec] unless byte-identical to the previous one (reloading an
     * unchanged diagram would restart the render loop and flash the source
     * fallback). Horizontal scrolling for wide diagrams happens inside the
     * document (`#diagram { overflow-x: auto }`), not in the view.
     */
    fun render(spec: MermaidRenderSpec) {
        if (spec == lastSpec) return
        lastSpec = spec
        val generation = generationCounter.incrementAndGet()
        activeGeneration.set(generation)
        loadDataWithBaseURL(
            "file:///android_asset/mermaid/",
            buildMermaidDocument(spec, generation),
            "text/html",
            "utf-8",
            null,
        )
    }

    private fun handleEvent(event: MermaidViewEvent) {
        when (event) {
            is MermaidViewEvent.Height -> onEvent?.invoke(event)
            is MermaidViewEvent.Rendered ->
                if (event.generation == activeGeneration.get()) onEvent?.invoke(event)
            is MermaidViewEvent.Failed ->
                if (event.generation == activeGeneration.get()) onEvent?.invoke(event)
        }
    }

    override fun onDetachedFromWindow() {
        bridge.release()
        super.onDetachedFromWindow()
    }
}

/**
 * A ` ```mermaid ` fence rendered as a diagram, mirroring the web component:
 * the standard code header (language chip + copy) stays above the body, the
 * body is the offline mermaid WebView, and until the diagram has rendered —
 * or when mermaid rejects the source — the raw source is shown instead with
 * an error notice carrying mermaid's reason. Theme flips re-render through
 * the dark/light `themeVariables` palettes; multiple diagrams in one message
 * each own a WebView with a unique `mermaid-<id>` element id.
 */
@Composable
internal fun MermaidDiagramView(code: String, modifier: Modifier = Modifier) {
    val colors = MaterialTheme.hapi
    val contentColor = LocalContentColor.current
    val diagramId = remember { MERMAID_DIAGRAM_IDS.incrementAndGet().toString() }
    val spec = remember(code, colors.isDark, diagramId) {
        MermaidRenderSpec(code = code, dark = colors.isDark, diagramId = diagramId)
    }
    // Deliberately not keyed by [spec]: the AndroidView factory closure
    // captures these state objects once; a re-keyed remember would orphan it.
    var renderState by remember { mutableStateOf<MermaidRenderState>(MermaidRenderState.Loading) }
    var heightPx by remember { mutableIntStateOf(0) }
    LaunchedEffect(spec) {
        renderState = MermaidRenderState.Loading
        heightPx = 0
    }
    val fallback = mermaidFallbackUi(renderState)
    val rendered = renderState is MermaidRenderState.Rendered
    val density = LocalDensity.current

    Column(
        modifier = modifier
            .clip(RoundedCornerShape(12.dp))
            .background(colors.codeBackground),
    ) {
        MermaidDiagramHeader(code = code, colors = colors)
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .then(
                    if (rendered) {
                        if (heightPx > 0) {
                            Modifier.height(with(density) { heightPx.toDp() })
                        } else {
                            // Reported height lands within a frame or two of
                            // the rendered callback; hold a sane floor.
                            Modifier.defaultMinSize(minHeight = 48.dp)
                        }
                    } else {
                        // Wrap content: the fallback source sizes the box.
                        Modifier
                    },
                ),
        ) {
            AndroidView(
                modifier = Modifier
                    .matchParentSize()
                    .alpha(if (rendered) 1f else 0f)
                    .semantics { contentDescription = code },
                factory = { context ->
                    MermaidWebView(context).also { view ->
                        view.onEvent = { event ->
                            when (event) {
                                is MermaidViewEvent.Height -> if (event.px > 0) heightPx = event.px
                                is MermaidViewEvent.Rendered -> renderState = MermaidRenderState.Rendered
                                is MermaidViewEvent.Failed ->
                                    renderState = MermaidRenderState.Error(event.message)
                            }
                        }
                    }
                },
                update = { it.render(spec) },
                onRelease = { it.destroy() },
            )
            if (fallback.showSource) {
                MermaidDiagramFallback(
                    code = code,
                    message = (renderState as? MermaidRenderState.Error)?.message,
                    colors = colors,
                    contentColor = contentColor,
                )
            }
        }
    }
}

/** Language chip + copy action, identical chrome to [CodeBlock]'s header (web keeps its code header). */
@Composable
private fun MermaidDiagramHeader(code: String, colors: HapiExtendedColors) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(colors.codeHeaderBackground)
            .padding(start = 12.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = "mermaid".uppercase(),
            fontFamily = FontFamily.Monospace,
            fontSize = 11.sp,
            lineHeight = 16.sp,
            letterSpacing = 0.8.sp,
            color = colors.codeHeaderForeground,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        FullTextAction(code, compact = true)
    }
}

/** Error notice (only on failure) + raw source pre — the block's source exit. */
@Composable
private fun MermaidDiagramFallback(
    code: String,
    message: String?,
    colors: HapiExtendedColors,
    contentColor: Color,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(colors.codeBackground),
    ) {
        if (message != null) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp, vertical = 8.dp),
            ) {
                Text(
                    text = stringResource(R.string.mermaid_render_error),
                    fontSize = 12.sp,
                    lineHeight = 16.sp,
                    fontWeight = FontWeight.Medium,
                    color = contentColor,
                )
                Text(
                    text = message,
                    fontSize = 11.sp,
                    lineHeight = 15.sp,
                    fontFamily = FontFamily.Monospace,
                    color = colors.hint,
                )
            }
            HorizontalDivider(color = colors.divider)
        }
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState()),
        ) {
            Text(
                text = code,
                fontFamily = FontFamily.Monospace,
                fontSize = 14.sp,
                lineHeight = 20.sp,
                softWrap = false,
                color = contentColor,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
            )
        }
    }
}

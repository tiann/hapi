package app.hapi.companion.ui.markdown

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.LocalTextStyle
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import java.io.ByteArrayInputStream
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Shared offline KaTeX WebView for markdown math.
 *
 * Offline iron rule: the only content ever loaded is
 * [buildMathDocument] HTML plus the bundled `assets/katex/` files, referenced
 * through the `file:///android_asset/katex/` base URL (asset URLs remain
 * loadable with file access disabled). [OfflineMarkdownWebViewClient] rejects
 * every http(s)/ws(s) request and [WebSettings.blockNetworkLoads] blocks the
 * network stack outright, so a hostile formula cannot make the view fetch
 * anything at runtime.
 *
 * Height adaptation: the document reports its height through the
 * `MathBridge.onHeight` JS interface (ResizeObserver + load + timeout) and
 * [OfflineMarkdownWebViewClient.onPageFinished] re-measures via
 * `evaluateJavascript(scrollHeight)`; whichever lands first wins.
 */
private class MathBridge(mainThread: Handler, onHeight: (Int) -> Unit) {
    private val handler = mainThread
    private val callback = onHeight
    private val released = AtomicBoolean(false)

    fun release() {
        released.set(true)
    }

    @JavascriptInterface
    fun onHeight(px: Int) {
        if (released.get() || px <= 0) return
        handler.post {
            if (!released.get()) callback(px)
        }
    }
}

/**
 * Rejects all network requests; offline markdown views render from bundled
 * assets only (KaTeX math, Mermaid diagrams).
 */
internal class OfflineMarkdownWebViewClient(private val onHeight: (Int) -> Unit) : WebViewClient() {
    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
        return when (request.url.scheme?.lowercase()) {
            "http", "https", "ws", "wss" -> WebResourceResponse(
                "text/plain",
                "utf-8",
                ByteArrayInputStream(ByteArray(0)),
            )
            else -> super.shouldInterceptRequest(view, request)
        }
    }

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true

    override fun onPageFinished(view: WebView, url: String?) {
        view.evaluateJavascript(
            "(function(){var b=document.body;return Math.max(document.documentElement?document.documentElement.scrollHeight:0,b?b.scrollHeight:0)|0})()",
        ) { value ->
            value.toIntOrNull()?.let(onHeight)
        }
    }
}

/** [WebView] configured once and reused across recompositions by [render]. */
private class MathWebView(context: Context) : WebView(context) {
    private val mainThread = Handler(Looper.getMainLooper())
    private val bridge = MathBridge(mainThread) { px -> reportedHeight = px }

    /** Latest height reported by the document; read by the size callback. */
    var reportedHeight: Int = 0
        set(value) {
            field = value
            onHeightChanged?.invoke(value)
        }

    /** Assigned by the composable each composition; see [render]. */
    var onHeightChanged: ((Int) -> Unit)? = null

    private var lastSpec: MathRenderSpec? = null

    init {
        @SuppressLint("SetJavaScriptEnabled")
        settings.apply {
            javaScriptEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            cacheMode = WebSettings.LOAD_NO_CACHE
            blockNetworkLoads = true
        }
        setBackgroundColor(Color.TRANSPARENT)
        isVerticalScrollBarEnabled = false
        isHorizontalScrollBarEnabled = false
        addJavascriptInterface(bridge, "MathBridge")
        webViewClient = OfflineMarkdownWebViewClient { px ->
            mainThread.post { reportedHeight = px }
        }
    }

    /**
     * Load [spec] unless it is byte-identical to the previous one: the Compose
     * `update` lambda runs on every recomposition and reloading would restart
     * the render loop (flicker + height churn) for unchanged formulas.
     */
    fun render(spec: MathRenderSpec) {
        if (spec == lastSpec) return
        lastSpec = spec
        reportedHeight = 0
        loadDataWithBaseURL(
            "file:///android_asset/katex/",
            buildMathDocument(spec),
            "text/html",
            "utf-8",
            null,
        )
    }

    override fun onDetachedFromWindow() {
        bridge.release()
        super.onDetachedFromWindow()
    }
}

/**
 * Block-level KaTeX math for chat markdown ([app.hapi.protocol.markdown.MathBlockNode]):
 * an offline [MathWebView] sized to the rendered formula, colored with the
 * ambient content color and transparent background so light/dark/OLED themes
 * apply without reloading assets.
 */
@Composable
internal fun KaTeXMathBlock(
    latex: String,
    modifier: Modifier = Modifier,
    displayMode: Boolean = true,
) {
    val contentColor = LocalContentColor.current
    val style = LocalTextStyle.current
    val fontSize: TextUnit = if (style.fontSize != TextUnit.Unspecified) style.fontSize else 16.sp
    val fontSizePx = with(LocalDensity.current) { fontSize.toPx() }.toInt()
    val spec = remember(latex, displayMode, contentColor, fontSizePx) {
        MathRenderSpec(latex = latex, displayMode = displayMode, textColorArgb = contentColor.toArgb(), fontSizePx = fontSizePx)
    }
    var heightPx by remember(spec) { mutableIntStateOf(0) }
    val density = LocalDensity.current

    AndroidView(
        modifier = modifier
            .fillMaxWidth()
            .semantics { contentDescription = latex }
            .then(
                if (heightPx > 0) {
                    Modifier.height(with(density) { heightPx.toDp() })
                } else {
                    Modifier.defaultMinSize(minHeight = 22.dp)
                },
            ),
        factory = { context ->
            MathWebView(context).also { view ->
                view.onHeightChanged = { px -> if (px > 0) heightPx = px }
            }
        },
        update = { it.render(spec) },
        onRelease = { it.destroy() },
    )
}

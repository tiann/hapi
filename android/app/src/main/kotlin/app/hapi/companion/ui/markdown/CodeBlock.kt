package app.hapi.companion.ui.markdown

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.hapi.companion.R
import app.hapi.companion.ui.theme.HapiExtendedColors
import app.hapi.companion.ui.theme.hapi
import dev.snipme.highlights.Highlights
import dev.snipme.highlights.model.BoldHighlight
import dev.snipme.highlights.model.CodeHighlight
import dev.snipme.highlights.model.ColorHighlight
import dev.snipme.highlights.model.SyntaxLanguage
import dev.snipme.highlights.model.SyntaxThemes
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

/** Above this many lines highlighting is skipped and the block renders plain. */
private const val MAX_HIGHLIGHT_LINES = 400

private const val HIGHLIGHT_CACHE_SIZE = 200

private data class HighlightKey(
    val codeHash: Int,
    val codeLength: Int,
    val language: String?,
    val dark: Boolean,
)

/** LRU (access-order) cache of computed highlight spans, shared app-wide. */
private object HighlightCache {
    private val map = object : LinkedHashMap<HighlightKey, List<CodeHighlight>>(64, 0.75f, true) {
        override fun removeEldestEntry(
            eldest: MutableMap.MutableEntry<HighlightKey, List<CodeHighlight>>,
        ): Boolean = size > HIGHLIGHT_CACHE_SIZE
    }

    @Synchronized
    fun get(key: HighlightKey): List<CodeHighlight>? = map[key]

    @Synchronized
    fun put(key: HighlightKey, value: List<CodeHighlight>) {
        map[key] = value
    }
}

/**
 * Fenced-code surface: language chip + copy button header, horizontally
 * scrolling monospaced body with `highlights`-based syntax coloring computed
 * off the main thread ([produceState] + LRU cache). Long blocks (>
 * [MAX_HIGHLIGHT_LINES] lines) and unknown languages stay plain.
 */
@Composable
fun CodeBlock(code: String, language: String?, modifier: Modifier = Modifier) {
    val colors = MaterialTheme.hapi

    Column(
        modifier = modifier
            .clip(RoundedCornerShape(12.dp))
            .background(colors.codeBackground),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(colors.codeHeaderBackground)
                .padding(start = 12.dp, end = 6.dp, top = 4.dp, bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = (language ?: stringResource(R.string.code_plain_fallback)).uppercase(),
                fontFamily = FontFamily.Monospace,
                fontSize = 11.sp,
                letterSpacing = 0.8.sp,
                color = colors.codeHeaderForeground,
                maxLines = 1,
                modifier = Modifier.weight(1f, fill = false),
            )
            Spacer(Modifier.weight(1f))
            CopyButton(code, colors)
        }
        val highlighted = rememberHighlightedCode(code, language, colors.isDark)
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState()),
        ) {
            Text(
                text = highlighted,
                fontFamily = FontFamily.Monospace,
                fontSize = 13.sp,
                lineHeight = 19.sp,
                softWrap = false,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
            )
        }
    }
}

@Composable
private fun CopyButton(code: String, colors: HapiExtendedColors) {
    // LocalClipboard (the suspend replacement) buys nothing for a plain text
    // copy and would force a scope launch in the click handler; the deprecated
    // sync API is the deliberate choice here.
    @Suppress("DEPRECATION")
    val clipboard = LocalClipboardManager.current
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            delay(1600)
            copied = false
        }
    }
    Text(
        text = stringResource(if (copied) R.string.code_copied else R.string.code_copy),
        fontSize = 11.sp,
        fontWeight = FontWeight.Medium,
        color = if (copied) MaterialTheme.colorScheme.primary else colors.codeHeaderForeground,
        modifier = Modifier
            .clip(RoundedCornerShape(6.dp))
            .clickable {
                clipboard.setText(AnnotatedString(code))
                copied = true
            }
            .padding(horizontal = 8.dp, vertical = 4.dp),
    )
}

@Composable
private fun rememberHighlightedCode(code: String, language: String?, dark: Boolean): AnnotatedString {
    val eligible = language != null &&
        code.isNotBlank() &&
        countLines(code) <= MAX_HIGHLIGHT_LINES &&
        resolveLanguage(language) != SyntaxLanguage.DEFAULT
    val key = HighlightKey(code.hashCode(), code.length, language?.lowercase(), dark)

    val highlighted by produceState(
        initialValue = HighlightCache.get(key)?.let { applyHighlights(code, it) } ?: AnnotatedString(code),
        key1 = key,
    ) {
        // Producer restarts on key change: reset synchronously (cache or plain)
        // so a recycled composable never shows spans from the previous code.
        val cached = HighlightCache.get(key)
        value = cached?.let { applyHighlights(code, it) } ?: AnnotatedString(code)
        if (cached == null && eligible) {
            val spans = withContext(Dispatchers.Default) {
                computeHighlights(code, language!!, dark)
            }
            HighlightCache.put(key, spans)
            value = applyHighlights(code, spans)
        }
    }
    return highlighted
}

private fun countLines(code: String): Int {
    var lines = 1
    for (ch in code) if (ch == '\n') lines += 1
    return lines
}

private val LANGUAGE_ALIASES = mapOf(
    "js" to "javascript",
    "jsx" to "javascript",
    "mjs" to "javascript",
    "cjs" to "javascript",
    "ts" to "typescript",
    "tsx" to "typescript",
    "py" to "python",
    "rb" to "ruby",
    "kts" to "kotlin",
    "sh" to "shell",
    "bash" to "shell",
    "zsh" to "shell",
    "shellsession" to "shell",
    "c++" to "cpp",
    "cs" to "csharp",
    "golang" to "go",
)

private fun resolveLanguage(raw: String?): SyntaxLanguage {
    if (raw == null) return SyntaxLanguage.DEFAULT
    val name = LANGUAGE_ALIASES[raw.lowercase()] ?: raw.lowercase()
    return SyntaxLanguage.values().firstOrNull { it.name.equals(name, ignoreCase = true) }
        ?: SyntaxLanguage.DEFAULT
}

private fun computeHighlights(code: String, language: String, dark: Boolean): List<CodeHighlight> =
    try {
        Highlights.Builder()
            .code(code)
            .language(resolveLanguage(language))
            .theme(SyntaxThemes.darcula(darkMode = dark))
            .build()
            .getHighlights()
    } catch (_: Exception) {
        // Highlighting is cosmetic; malformed input must never take the UI down.
        emptyList()
    }

private fun applyHighlights(code: String, highlights: List<CodeHighlight>): AnnotatedString {
    if (highlights.isEmpty()) return AnnotatedString(code)
    return buildAnnotatedString {
        append(code)
        for (highlight in highlights) {
            val start = highlight.location.start.coerceIn(0, code.length)
            val end = highlight.location.end.coerceIn(0, code.length)
            if (end <= start) continue
            when (highlight) {
                is ColorHighlight -> addStyle(
                    SpanStyle(color = Color(0xFF000000.toInt() or highlight.rgb)),
                    start,
                    end,
                )
                is BoldHighlight -> addStyle(SpanStyle(fontWeight = FontWeight.Bold), start, end)
            }
        }
    }
}

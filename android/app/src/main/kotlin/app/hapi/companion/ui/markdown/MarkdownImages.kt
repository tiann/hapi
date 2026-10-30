package app.hapi.companion.ui.markdown

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.isFinite
import app.hapi.companion.R
import app.hapi.companion.feature.chat.ChatMedia
import app.hapi.companion.ui.theme.hapi
import app.hapi.protocol.markdown.HrefPolicy
import coil.compose.AsyncImagePainter
import coil.compose.SubcomposeAsyncImage
import coil.compose.SubcomposeAsyncImageContent
import coil.imageLoader
import org.commonmark.node.Code
import org.commonmark.node.Image
import org.commonmark.node.Node
import org.commonmark.node.Text as MdText

// ── src routing (web `denyOnlyTransform` parity) ─────────────────────────────

/**
 * A markdown image src the inline renderer can actually load. Classification
 * mirrors the web's `denyOnlyTransform` (`markdown-text.tsx`): scheme-less
 * srcs pass through as relative, deny-listed schemes are stripped, and only
 * `http`/`https` are renderable images.
 *
 * web 同构/分歧:
 * - Relative srcs pass through unchanged (web resolves them against the page
 *   origin unauthenticated, which 401s on private routes; native resolves them
 *   against the hub origin through the authed [ChatMedia] loader instead).
 * - Protocol-relative `//host/x` classifies as relative like the web, but is
 *   hub-joined (and fails safe) instead of being dispatched cross-origin.
 * - `data:` srcs are rejected exactly like the web strips them (a known
 *   upstream limitation); `mailto:`/`irc:`/custom schemes degrade to the
 *   classified-link fallback instead of a browser-broken `<img>`.
 */
internal sealed interface MarkdownImageSrc {
    /** Absolute `http(s)` URL; loaded without hub credentials (web sends none). */
    data class Absolute(val url: String) : MarkdownImageSrc

    /** Scheme-less src; resolved against the hub origin with auth injection. */
    data class Relative(val path: String) : MarkdownImageSrc
}

/** Resolve a markdown image destination; null degrades to the link fallback. */
internal fun resolveMarkdownImageSrc(destination: String): MarkdownImageSrc? {
    val trimmed = destination.trim()
    if (trimmed.isEmpty()) return null
    if (!HrefPolicy.hasScheme(trimmed)) return MarkdownImageSrc.Relative(trimmed)
    return when (HrefPolicy.normalizedScheme(trimmed)) {
        "http", "https" -> MarkdownImageSrc.Absolute(trimmed)
        // Deny-listed schemes (javascript/data/vbscript/file) plus everything
        // a browser could not render as an image either (mailto/irc/custom).
        else -> null
    }
}

// ── Inline spec (placeholder key + load target) ──────────────────────────────

/** Placeholder key prefix for markdown inline images inside one [androidx.compose.ui.text.Text]. */
internal const val INLINE_IMAGE_ID_PREFIX = "hapi-md-img"

/** Alternate text appended with the placeholder when the image has no alt. */
internal const val INLINE_IMAGE_ALT_FALLBACK = "[image]"

/** One renderable inline image: placeholder id, alt text, resolved URL, loader routing. */
internal data class MarkdownInlineImageSpec(
    val id: String,
    val alt: String,
    val url: String,
    /** True → hub-origin src, must go through the authed [ChatMedia] loader. */
    val authed: Boolean,
)

/**
 * Build the spec for one markdown image node, or null when it must degrade to
 * the classified-link fallback: denied/unrenderable src, or a relative src
 * without both the authed loader and a live hub resolver (previews, tests).
 *
 * web 同构/分歧: the web renders every surviving `<img>` src as-is with no
 * credentials; native additionally refuses relative srcs it cannot auth-load
 * rather than emitting a request that is guaranteed to 401.
 */
internal fun markdownInlineImageSpec(
    destination: String,
    alt: String,
    ordinal: Int,
    hubMediaUrl: (path: String) -> String? = { null },
    hasAuthedLoader: Boolean = false,
): MarkdownInlineImageSpec? {
    return when (val src = resolveMarkdownImageSrc(destination)) {
        is MarkdownImageSrc.Absolute -> MarkdownInlineImageSpec(
            id = "$INLINE_IMAGE_ID_PREFIX:$ordinal",
            alt = alt,
            url = src.url,
            authed = false,
        )
        is MarkdownImageSrc.Relative -> {
            if (!hasAuthedLoader) return null
            val url = hubMediaUrl(src.path) ?: return null
            MarkdownInlineImageSpec(
                id = "$INLINE_IMAGE_ID_PREFIX:$ordinal",
                alt = alt,
                url = url,
                authed = true,
            )
        }
        null -> null
    }
}

/** Alt text = the image node's inline children concatenated (web `alt` attribute). */
internal fun imageAltText(node: Image): String {
    val sb = StringBuilder()
    fun walk(from: Node?) {
        var child = from?.firstChild
        while (child != null) {
            when (child) {
                is MdText -> sb.append(child.literal.orEmpty())
                is Code -> sb.append(child.literal.orEmpty())
            }
            walk(child)
            child = child.next
        }
    }
    walk(node)
    return sb.toString().trim()
}

// ── Inline content assembly ──────────────────────────────────────────────────

/**
 * Placeholder box height as a fraction of the column width. AnnotatedString
 * placeholders cannot resize after layout, so one fixed aspect reserves space
 * and [ContentScale.Inside] letterboxes the bitmap inside it.
 *
 * web 同构/分歧: the web `<img>` settles at its natural size capped by
 * `max-w-full` with no height constraint; native reserves a fixed 3:4 box
 * (the transparent letterbox doubles as the web `my-3` spacing).
 */
private const val INLINE_IMAGE_BOX_ASPECT = 3f / 4f

/** Width used when the incoming constraints are unbounded (intrinsic measurement). */
private val INLINE_IMAGE_UNBOUNDED_WIDTH = 320.dp

/** Map of placeholder id → inline content for one image-bearing [androidx.compose.ui.text.Text]. */
internal fun markdownImageInlineContent(
    specs: List<MarkdownInlineImageSpec>,
    maxWidth: Dp,
    density: Density,
    media: ChatMedia,
): Map<String, InlineTextContent> {
    val width = if (maxWidth.isFinite) maxWidth else INLINE_IMAGE_UNBOUNDED_WIDTH
    val widthSp = with(density) { width.toSp() }
    val heightSp = with(density) { (width * INLINE_IMAGE_BOX_ASPECT).toSp() }
    return specs.associate { spec ->
        spec.id to InlineTextContent(
            placeholder = Placeholder(
                width = widthSp,
                height = heightSp,
                placeholderVerticalAlign = PlaceholderVerticalAlign.Bottom,
            ),
        ) {
            InlineMarkdownImage(spec = spec, media = media, modifier = Modifier.fillMaxSize())
        }
    }
}

// ── Rendering ────────────────────────────────────────────────────────────────

/**
 * One inline markdown image rendered with Coil through `LocalChatMedia`
 * (mirrors `GeneratedImageBlockView`'s loader usage). Loading shows a quiet
 * tonal placeholder; failure shows a tappable retry label (a fresh
 * `key(attempt)` composition re-runs the request).
 *
 * web 同构/分歧: the web's markdown `<img>` is bare (no loading/failure UI —
 * broken images just vanish); native surfaces both states because Coil's
 * async pipeline would otherwise render an empty hole.
 */
@Composable
internal fun InlineMarkdownImage(
    spec: MarkdownInlineImageSpec,
    media: ChatMedia,
    modifier: Modifier = Modifier,
) {
    // Authed (hub-relative) srcs must go through the JWT loader; absolute URLs
    // use the process-default loader so the hub token is never attached to a
    // third-party host (the web sends no headers either).
    val loader = (if (spec.authed) media.imageLoader else null) ?: LocalContext.current.imageLoader
    val colors = MaterialTheme.hapi
    var attempt by remember(spec.id) { mutableStateOf(0) }
    key(attempt) {
        SubcomposeAsyncImage(
            model = spec.url,
            imageLoader = loader,
            contentDescription = spec.alt.ifBlank { null },
            contentScale = ContentScale.Inside,
            modifier = modifier,
        ) {
            when (painter.state) {
                is AsyncImagePainter.State.Error -> Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .clip(RoundedCornerShape(12.dp))
                        .background(colors.codeBackground)
                        .clickable { attempt += 1 },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = stringResource(R.string.chat_markdown_image_failed),
                        style = MaterialTheme.typography.labelMedium,
                        color = colors.hint,
                        textAlign = TextAlign.Center,
                    )
                }
                is AsyncImagePainter.State.Success -> SubcomposeAsyncImageContent(
                    modifier = Modifier.fillMaxSize().clip(RoundedCornerShape(12.dp)),
                )
                else -> Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .clip(RoundedCornerShape(12.dp))
                        .background(colors.codeBackground),
                )
            }
        }
    }
}

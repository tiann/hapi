package app.hapi.companion.ui.markdown

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertHeightIsEqualTo
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.unit.dp
import app.hapi.companion.ui.theme.HapiTheme
import org.junit.Rule
import org.junit.Test

/**
 * Layout regressions for inline markdown images inside the two containers
 * whose measurement walks intrinsics: table cells (TableGrid column sizing
 * calls `maxIntrinsicWidth` on cells) and blockquotes (previously
 * `height(IntrinsicSize.Min)`). Both crashed during layout before the
 * intrinsic-safe sizing boundary — the image-bearing BoxWithConstraints is a
 * SubcomposeLayout whose measure policy throws on intrinsic queries — and must
 * now lay the image out at the measured column width.
 *
 * Both tests use an absolute https src (renders with any [app.hapi.companion.feature.chat.ChatMedia])
 * and a `.invalid` host so Coil settles on its error state quickly; the
 * loading and error boxes both carry the alt as contentDescription and are
 * laid out at the fixed placeholder size in every load state, so the
 * assertions are state-independent.
 *
 * Expected sizes on the 160dpi CI AVD (1px = 1dp):
 * - table cell: image column = TableGrid's 320.dp cap, cell inner width =
 *   320 - 2x10 padding = 300dp, fixed 3:4 box -> 300 x 225dp;
 * - blockquote: Row(320) - 3dp bar leaves 317 for the column,
 *   - 2x12 padding = 293dp text width, 3:4 box -> 293 x 219.75dp.
 */
class MarkdownImageLayoutTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun tableCellImageLaysOutAtTheCappedColumnWidth() {
        compose.setContent {
            HapiTheme {
                Box(Modifier.width(320.dp)) {
                    Markdown(
                        "| shot | note |\n" +
                            "| --- | --- |\n" +
                            "| ![plot](https://images.invalid/plot.png) | see plot |",
                    )
                }
            }
        }
        // Pre-fix this throws IllegalStateException: the intrinsic width query
        // walks from TableGrid's column sizing into the subcompose.
        compose.onNodeWithContentDescription("plot", useUnmergedTree = true)
            .assertExists()
            .assertIsDisplayed()
            .assertWidthIsEqualTo(300.dp)
            .assertHeightIsEqualTo(225.dp)
    }

    @Test
    fun blockquoteImageLaysOutAtTheQuoteInnerWidth() {
        compose.setContent {
            HapiTheme {
                Box(Modifier.width(320.dp)) {
                    Markdown("> quoted ![shot](https://images.invalid/shot.png)")
                }
            }
        }
        // Pre-fix this throws IllegalStateException: the quote's intrinsic
        // height pass walks into the subcompose.
        compose.onNodeWithContentDescription("shot", useUnmergedTree = true)
            .assertExists()
            .assertIsDisplayed()
            .assertWidthIsEqualTo(293.dp)
            .assertHeightIsEqualTo(219.75.dp)
    }
}

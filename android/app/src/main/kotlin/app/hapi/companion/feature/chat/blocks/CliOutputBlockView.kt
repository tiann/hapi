package app.hapi.companion.feature.chat.blocks

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.companion.ui.theme.hapi
import app.hapi.protocol.chat.CliOutputBlock

/**
 * `<local-command-stdout>` / slash-command echo: terminal-styled monospace
 * panel (no header chrome — this is transcript, not a code sample).
 */
@Composable
fun CliOutputBlockView(block: CliOutputBlock, modifier: Modifier = Modifier) {
    TerminalText(text = block.text, modifier = modifier)
}

/** Shared terminal-look text panel (cli output + tool stdout). */
@Composable
internal fun TerminalText(text: String, modifier: Modifier = Modifier, isError: Boolean = false) {
    val colors = MaterialTheme.hapi
    Box(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(colors.codeBackground)
            .horizontalScroll(rememberScrollState()),
    ) {
        Text(
            text = text,
            fontFamily = FontFamily.Monospace,
            fontSize = 12.sp,
            lineHeight = 17.sp,
            softWrap = false,
            color = if (isError) MaterialTheme.colorScheme.error else colors.inlineCodeForeground,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
        )
    }
}

@Preview(showBackground = true)
@Composable
private fun CliOutputBlockPreview() {
    HapiTheme {
        Surface {
            CliOutputBlockView(
                CliOutputBlock(
                    id = "c1",
                    localId = null,
                    createdAt = 0,
                    invokedAt = null,
                    text = "$ bun test\n✓ message-window-store (48 tests)\n1 file, 0 failures",
                    source = "user",
                    meta = null,
                ),
                modifier = Modifier.padding(12.dp),
            )
        }
    }
}

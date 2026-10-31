package app.hapi.companion.ui.markdown

import android.content.ClipboardManager
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import app.hapi.companion.R
import app.hapi.companion.ui.theme.HapiTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class CodeBlockLayoutTest {
    @get:Rule val compose = createComposeRule()

    @Test fun shortLanguageKeepsCopyAtTrailingEdge() = checkHeader("json", 1f)

    @Test fun longLanguageAndLargeFontKeepCopyCompact() =
        checkHeader("a-very-long-language-name", 2f)

    private fun checkHeader(language: String, fontScale: Float) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val source = "  const value = 42;\r\n\tconsole.log(value);"
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, fontScale)) {
                HapiTheme {
                    Box(Modifier.width(320.dp)) {
                        CodeBlock(source, language, Modifier.testTag("code-block"))
                    }
                }
            }
        }
        val copyLabel = context.getString(R.string.chat_copy_full_content)
        assertHeaderAction(copyLabel)
        compose.onNodeWithContentDescription(copyLabel).performClick()
        assertHeaderAction(context.getString(R.string.chat_content_copied))
        compose.runOnIdle {
            assertEquals(source, context.getSystemService(ClipboardManager::class.java)
                .primaryClip!!.getItemAt(0).text.toString())
        }
    }

    private fun assertHeaderAction(label: String) {
        val button = compose.onNodeWithContentDescription(label)
        button.assertIsDisplayed()
        val bounds = button.getUnclippedBoundsInRoot()
        val block = compose.onNodeWithTag("code-block").getUnclippedBoundsInRoot()
        assertEquals("Action stays at the trailing edge", block.right.value - 4, bounds.right.value, 1f)
        button.assertWidthIsEqualTo(48.dp).assertHeightIsEqualTo(48.dp)
        compose.onNodeWithContentDescription(label, useUnmergedTree = true)
            .assertWidthIsEqualTo(18.dp).assertHeightIsEqualTo(18.dp)
    }
}

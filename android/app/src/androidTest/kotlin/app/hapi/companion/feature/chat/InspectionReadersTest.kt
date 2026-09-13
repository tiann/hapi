package app.hapi.companion.feature.chat

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import android.app.Activity
import android.app.Instrumentation
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import androidx.test.platform.app.InstrumentationRegistry
import app.hapi.companion.R
import app.hapi.companion.ui.components.FullTextAction
import app.hapi.companion.feature.chat.blocks.previewToolCall
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.protocol.chat.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.util.concurrent.atomic.AtomicReference

class InspectionReadersTest {
    @get:Rule val compose = createComposeRule()

    @Test fun androidGraphemePagingPreservesEmojiCombiningCharactersAndCrLf() {
        // Also runs on API 29's regex implementation, independently of the host JVM.
        val units = listOf("👩🏽‍💻", "e\u0301", "🇨🇳", "\r\n", " ", "中")
        val text = units.joinToString("").repeat(100)
        val pages = mutableListOf<String>()
        var start = 0
        while (start < text.length) {
            val page = readTextPage(text, start, TextBudget(1, 2))
            assertTrue(page.end > start)
            pages += page.text
            start = page.end
        }
        assertEquals(List(100) { units }.flatten(), pages)
        assertEquals(text, pages.joinToString(""))
        assertEquals(2_000, messagePreview("x".repeat(1_000_000)).text.length)
    }

    @Test fun largeFontReaderMountsOnlyTheSelectedPageAndRestoresIt() {
        val restore = StateRestorationTester(compose)
        val text = "a".repeat(4_000) + "b".repeat(4_000) + "c".repeat(992_000)
        restore.setContent {
            val density = LocalDensity.current.density
            CompositionLocalProvider(LocalDensity provides Density(density, fontScale = 2f)) {
                HapiTheme {
                    Box(Modifier.width(360.dp).fillMaxHeight()) { MessageReader(text, false, {}, {}) }
                }
            }
        }
        compose.onNodeWithTag("reader-text").assertTextEquals("a".repeat(4_000))
        compose.onNodeWithTag("reader-next").assertIsDisplayed().performClick()
        compose.onNodeWithTag("reader-text").assertTextEquals("b".repeat(4_000))
        compose.onAllNodesWithTag("reader-text").assertCountEquals(1)
        restore.emulateSavedInstanceStateRestore()
        compose.onNodeWithTag("reader-text").assertTextEquals("b".repeat(4_000))
        compose.onNodeWithTag("reader-previous").assertIsDisplayed().performClick()
        compose.onNodeWithTag("reader-text").assertTextEquals("a".repeat(4_000))
        compose.onNodeWithTag("inspection-close").assertIsDisplayed()
    }

    private fun group(count: Int): ToolGroupBlock = buildVisibleChatBlocks(
        (1..count).map { previewToolCall("tool-$it", "Read", input = mapOf("file_path" to "/repo/file-$it.kt")) },
        ToolGroupingOptions(hasMoreMessages = false),
    ).filterIsInstance<ToolGroupBlock>().single()

    @Test fun toolBrowserStartsAtLatestButDoesNotFollowUpdatesWhileReading() {
        val inspected = mutableStateOf(Inspected(group(200), false))
        var selected: String? = null
        compose.setContent {
            HapiTheme { ToolGroupBrowser(inspected.value, "/repo", { selected = it }, {}, {}) }
        }
        compose.onNodeWithTag("inspection-tool-tool-200").assertIsDisplayed()
        compose.onNodeWithTag("inspection-tools").performScrollToIndex(30)
        compose.onNodeWithTag("inspection-tool-tool-31").assertIsDisplayed()
        compose.runOnIdle { inspected.value = Inspected(group(201), false) }
        compose.onNodeWithTag("inspection-tool-tool-31").assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals("tool-31", selected) }
        compose.onNodeWithTag("inspection-tool-tool-201").assertDoesNotExist()
        compose.onNodeWithTag("inspection-latest-tool").performClick()
        compose.onNodeWithTag("inspection-tool-tool-201").assertIsDisplayed()
        compose.runOnIdle { inspected.value = inspected.value.copy(stale = true) }
        compose.onNodeWithTag("inspection-notice").assertIsDisplayed()
    }

    @Test fun fullContentUsesExactClipboardTextOrAReadableGrantedUri() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val source = mutableStateOf("  👩🏽‍💻\r\nexact clipboard text\t")
        val launched = AtomicReference<Intent?>()
        val monitor = object : Instrumentation.ActivityMonitor() {
            override fun onStartActivity(intent: Intent?): Instrumentation.ActivityResult? {
                if (intent?.action != Intent.ACTION_CHOOSER) return null
                launched.set(intent)
                // Verify the system handoff without opening a sharing target.
                return Instrumentation.ActivityResult(Activity.RESULT_CANCELED, null)
            }
        }
        instrumentation.addMonitor(monitor)
        try {
            compose.setContent { HapiTheme { FullTextAction(source.value, compact = true) } }
            compose.onNodeWithContentDescription(context.getString(R.string.chat_copy_full_content)).performClick()
            compose.runOnIdle {
                assertEquals(source.value, context.getSystemService(ClipboardManager::class.java).primaryClip!!.getItemAt(0).text.toString())
                source.value = "exact export 👩🏽‍💻\r\n".repeat(50_000)
            }
            compose.onNodeWithContentDescription(context.getString(R.string.chat_export_full_content)).performClick()
            compose.waitUntil(10_000) { launched.get() != null }
            @Suppress("DEPRECATION")
            val send = launched.get()!!.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)!!
            @Suppress("DEPRECATION")
            val uri = send.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)!!
            assertEquals(Intent.ACTION_SEND, send.action)
            assertEquals("text/plain", send.type)
            assertEquals("content", uri.scheme)
            assertEquals(uri, send.clipData!!.getItemAt(0).uri)
            assertTrue(send.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
            assertFalse(send.hasExtra(Intent.EXTRA_TEXT))
            assertEquals(source.value, context.contentResolver.openInputStream(uri)!!.bufferedReader(Charsets.UTF_8).use { it.readText() })
        } finally {
            instrumentation.removeMonitor(monitor)
        }
    }
}

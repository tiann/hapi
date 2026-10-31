package app.hapi.companion.feature.chat

import android.content.ActivityNotFoundException
import android.content.ContextWrapper
import android.content.Intent
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import app.hapi.companion.feature.chat.blocks.PendingPermissionFooter
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.protocol.chat.ChatToolCall
import app.hapi.protocol.chat.ToolPermission
import app.hapi.protocol.wire.HapiJson
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class RequestUserInputUrlTest {
    @get:Rule val compose = createComposeRule()
    private val url = "https://example.com/login?state=a|b"

    private fun showFooter(events: MutableList<String>, failToOpen: Boolean = false) {
        val tool = ChatToolCall(
            id = "login", name = "request_user_input", state = "running", createdAt = 0,
            description = null,
            input = HapiJson.parseToJsonElement(
                """{"url":"$url","questions":[{"id":"__mcp_url_confirmation","question":"Sign in","options":[{"label":"Continue","description":"$url"}]}]}""",
            ),
            permission = ToolPermission(id = "reply", status = "pending", presence = emptySet()),
        )
        compose.setContent {
            val baseContext = LocalContext.current
            val context = remember(baseContext) {
                object : ContextWrapper(baseContext) {
                    override fun startActivity(intent: Intent) {
                        assertEquals(Intent.ACTION_VIEW, intent.action)
                        assertEquals(url, intent.dataString)
                        events += "open"
                        if (failToOpen) throw ActivityNotFoundException()
                    }
                }
            }
            HapiTheme {
                CompositionLocalProvider(LocalContext provides context) {
                    PendingPermissionFooter(tool, "reply", "codex", null, { _, action ->
                        assertEquals(
                            PermissionAction.NestedAnswers(mapOf("__mcp_url_confirmation" to listOf("Continue"))),
                            action,
                        )
                        events += "approve"
                    })
                }
            }
        }
    }

    @Test fun confirmedBrowserValidUrlOpensBeforeApproval() {
        val events = mutableListOf<String>()
        showFooter(events)
        compose.onNodeWithText("Submit").performClick()
        compose.runOnIdle { assertEquals(emptyList<String>(), events) }
        compose.onNodeWithTag("request-input-__mcp_url_confirmation-option-0").performClick()
        compose.onNodeWithText("Submit").performClick()
        compose.runOnIdle { assertEquals(listOf("open", "approve"), events) }
    }

    @Test fun failureToOpenBrowserValidUrlPreventsApproval() {
        val events = mutableListOf<String>()
        showFooter(events, failToOpen = true)
        compose.onNodeWithTag("request-input-__mcp_url_confirmation-option-0").performClick()
        compose.onNodeWithText("Submit").performClick()
        compose.runOnIdle { assertEquals(listOf("open"), events) }
    }
}

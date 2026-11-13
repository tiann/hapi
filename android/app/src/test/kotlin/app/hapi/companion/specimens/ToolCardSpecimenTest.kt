package app.hapi.companion.specimens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import app.hapi.companion.feature.chat.ChatInteractions
import app.hapi.companion.feature.chat.LocalChatInteractions
import app.hapi.companion.feature.chat.PermissionRowOverride
import app.hapi.companion.feature.chat.blocks.ToolCallBlockView
import app.hapi.companion.feature.chat.blocks.ToolGroupBlockView
import app.hapi.companion.feature.chat.blocks.previewToolCall
import app.hapi.protocol.chat.ToolGroupBlock
import app.hapi.protocol.chat.ToolGroupingOptions
import app.hapi.protocol.chat.ToolPermission
import app.hapi.protocol.chat.ToolState
import app.hapi.protocol.chat.buildVisibleChatBlocks
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xxhdpi")
class ToolCardSpecimenTest {
    @get:Rule val compose = createComposeRule()

    @Test fun summariesLight() = summaries(SpecimenTheme.Light)
    @Test fun summariesDark() = summaries(SpecimenTheme.Dark)
    @Test fun approvalsLight() = approvals(SpecimenTheme.Light)
    @Test fun approvalsDark() = approvals(SpecimenTheme.Dark)

    private fun summaries(theme: SpecimenTheme) {
        compose.setContent {
            Specimen(theme) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    ToolCallBlockView(
                        previewToolCall("t1", "Bash", ToolState.RUNNING, mapOf("command" to "bun run test:web -- --run src/chat/reducer.test.ts")),
                        basePath = "/repo",
                    )
                    ToolCallBlockView(
                        previewToolCall("t2", "Read", input = mapOf("file_path" to "/repo/android/app/src/main/kotlin/app/hapi/companion/feature/chat/ChatTranscript.kt")),
                        basePath = "/repo",
                    )
                    ToolCallBlockView(
                        previewToolCall("t3", "Grep", ToolState.ERROR, mapOf("pattern" to "tailRevision", "path" to "/repo/web/src")),
                        basePath = "/repo",
                    )
                    ToolCallBlockView(
                        previewToolCall("t4", "Edit", input = mapOf("file_path" to "/repo/hub/src/sync/messages.ts")),
                        basePath = "/repo",
                    )
                    ToolGroupBlockView(group(), basePath = "/repo")
                }
            }
        }
        compose.captureSpecimen("tool-summaries", theme)
    }

    private fun approvals(theme: SpecimenTheme) {
        compose.setContent {
            Specimen(theme) {
                Interactions(mapOf("p2" to PermissionRowOverride.Resolving)) {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        ToolCallBlockView(pending("p1", "Bash", mapOf("command" to "rm -rf android/app/build && ./gradlew assembleDebug")), basePath = "/repo")
                        ToolCallBlockView(pending("p2", "Edit", mapOf("file_path" to "/repo/web/src/App.tsx")), basePath = "/repo")
                        ToolCallBlockView(settled("p3", "Bash", "approved", mapOf("command" to "git status")), basePath = "/repo")
                        ToolCallBlockView(settled("p4", "Write", "denied", mapOf("file_path" to "/repo/.env")), basePath = "/repo")
                    }
                }
            }
        }
        compose.captureSpecimen("tool-approvals", theme)
    }

    @Composable
    private fun Interactions(overrides: Map<String, PermissionRowOverride>, content: @Composable () -> Unit) {
        val interactions = ChatInteractions(
            flavor = "claude",
            permissionOverrides = overrides,
            resolvePermission = { _, _ -> },
            retryFailedMessage = {},
        )
        CompositionLocalProvider(LocalChatInteractions provides interactions, content = content)
    }

    private fun pending(id: String, name: String, input: Map<String, String>) = previewToolCall(
        id, name, ToolState.PENDING, input,
        permission = ToolPermission(id = id, status = "pending", presence = setOf("id", "status")),
    )

    private fun settled(id: String, name: String, status: String, input: Map<String, String>) = previewToolCall(
        id, name, if (status == "approved") ToolState.COMPLETED else ToolState.ERROR, input,
        permission = ToolPermission(id = id, status = status, presence = setOf("id", "status")),
    )

    private fun group(): ToolGroupBlock {
        val tools = listOf(
            previewToolCall("g1", "Read", input = mapOf("file_path" to "/repo/web/src/chat/reducer.ts")),
            previewToolCall("g2", "Read", input = mapOf("file_path" to "/repo/web/src/chat/window.ts")),
            previewToolCall("g3", "Grep", input = mapOf("pattern" to "tailRevision")),
            previewToolCall("g4", "Bash", ToolState.RUNNING, mapOf("command" to "bun test")),
        )
        return buildVisibleChatBlocks(tools, ToolGroupingOptions(hasMoreMessages = false))
            .filterIsInstance<ToolGroupBlock>().first()
    }
}

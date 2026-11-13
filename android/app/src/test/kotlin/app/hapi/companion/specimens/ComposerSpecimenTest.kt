package app.hapi.companion.specimens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.Composable
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import app.hapi.companion.feature.chat.ComposerUiState
import app.hapi.companion.feature.chat.QueuedRowUi
import app.hapi.companion.feature.chat.attachments.ComposerAttachmentStatus
import app.hapi.companion.feature.chat.attachments.ComposerAttachmentUi
import app.hapi.companion.feature.chat.composer.ChatComposer
import app.hapi.companion.feature.chat.composer.DictationState
import app.hapi.companion.feature.chat.composer.MentionSuggestion
import app.hapi.companion.feature.chat.composer.PendingSchedule
import app.hapi.companion.feature.chat.composer.QueuedMessagesBar
import app.hapi.protocol.wire.SlashCommand
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Composer states (iOS `ChatComposerView` parity review); fake data, no hub. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xxhdpi")
class ComposerSpecimenTest {
    @get:Rule val compose = createComposeRule()

    @Test fun statesLight() = capture("composer-states", SpecimenTheme.Light) { States() }
    @Test fun statesDark() = capture("composer-states", SpecimenTheme.Dark) { States() }
    @Test fun trayLight() = capture("composer-tray", SpecimenTheme.Light) { Tray() }
    @Test fun trayDark() = capture("composer-tray", SpecimenTheme.Dark) { Tray() }
    @Test fun queuedLight() = capture("composer-queued", SpecimenTheme.Light) { Queued() }
    @Test fun queuedDark() = capture("composer-queued", SpecimenTheme.Dark) { Queued() }
    @Test fun slashLight() = capture("composer-slash", SpecimenTheme.Light) { Slash() }
    @Test fun slashDark() = capture("composer-slash", SpecimenTheme.Dark) { Slash() }
    @Test fun mentionLight() = capture("composer-mention", SpecimenTheme.Light) { Mention() }
    @Test fun mentionDark() = capture("composer-mention", SpecimenTheme.Dark) { Mention() }

    private fun capture(name: String, theme: SpecimenTheme, content: @Composable () -> Unit) {
        compose.setContent {
            Specimen(theme) {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) { content() }
            }
        }
        compose.captureSpecimen(name, theme)
    }

    @Composable private fun States() {
        // Resting (collapsed), resting during a turn (Stop), a draft, sending.
        Composer(ComposerUiState(text = "", isSending = false, canSteer = false))
        Composer(ComposerUiState(text = "", isSending = false, canSteer = true))
        Composer(
            ComposerUiState(
                text = "Run the tests and summarize failures.\n然后给出最小的安全修复。",
                isSending = false,
                canSteer = true,
            ),
        )
        Composer(ComposerUiState(text = "Ship it", isSending = true, canSteer = false))
    }

    @Composable private fun Tray() {
        Composer(
            ComposerUiState(text = "Here are the logs", isSending = false, canSteer = false),
            attachments = listOf(
                chip("up", "IMG_20261113_133702.jpg", "image/jpeg", ComposerAttachmentStatus.Uploading),
                chip("ok", "build-log.txt", "text/plain", ComposerAttachmentStatus.Ready),
                chip("bad", "trace.bin", "application/octet-stream", ComposerAttachmentStatus.Failed),
            ),
        )
        Composer(
            ComposerUiState(text = "Wrap up the release notes and ping me", isSending = false, canSteer = false),
            pendingSchedule = PendingSchedule.Preset("+30m"),
        )
        Composer(
            ComposerUiState(text = "", isSending = false, canSteer = false),
            dictation = DictationState.Recording(startedAtMs = System.currentTimeMillis() - 42_000),
        )
    }

    @Composable private fun Queued() {
        Column {
            QueuedMessagesBar(
                rows = listOf(
                    QueuedRowUi("m1", "l1", "Also add tests for the pagination edge cases", emptyList(), null, canAct = true, canSteer = true),
                    QueuedRowUi("l2", "l2", "Waiting for the server echo before acting on this row", emptyList(), null, canAct = false, canSteer = false),
                    QueuedRowUi(
                        "m3", "l3", "Ship it", listOf("notes.txt"),
                        scheduledAt = System.currentTimeMillis() + 3_600_000, canAct = true, canSteer = false,
                    ),
                ),
                onSteer = {}, onRetry = {}, onEdit = {}, onCancel = {},
            )
            Composer(ComposerUiState(text = "", isSending = false, canSteer = true))
        }
    }

    @Composable private fun Slash() {
        Composer(
            ComposerUiState(text = "/co", isSending = false, canSteer = false),
            slashSuggestions = listOf(
                SlashCommand(name = "compact", description = "Clear conversation history but keep a summary in context", source = "builtin"),
                SlashCommand(name = "context", description = "Visualize current context usage as a colored grid", source = "builtin"),
                SlashCommand(name = "code-review", description = null, source = "project"),
            ),
        )
    }

    @Composable private fun Mention() {
        Composer(
            ComposerUiState(text = "@auth", isSending = false, canSteer = false),
            mentionSuggestions = listOf(
                MentionSuggestion.SessionMention(
                    id = "3f9d2c1b8e7a4d60", title = "Refactor auth flow", key = "session:3f9d2c1b8e7a4d60",
                    label = "@Refactor auth flow", description = "Session · 3f9d2c1b · active",
                    insertText = "See session \"Refactor auth flow\" (/sessions/3f9d2c1b8e7a4d60) for context.",
                ),
                MentionSuggestion.FileMention(
                    key = "@docs/auth.md", label = "@auth.md", description = "docs/guide/security/auth.md", insertText = "@docs/auth.md",
                ),
                MentionSuggestion.FileMention(
                    key = "@hub/src/auth.ts", label = "@auth.ts", description = "hub/src/web/middleware/auth.ts", insertText = "@hub/src/auth.ts",
                ),
            ),
        )
    }

    @Composable
    private fun Composer(
        state: ComposerUiState,
        attachments: List<ComposerAttachmentUi> = emptyList(),
        pendingSchedule: PendingSchedule? = null,
        dictation: DictationState = DictationState.Idle,
        slashSuggestions: List<SlashCommand> = emptyList(),
        mentionSuggestions: List<MentionSuggestion> = emptyList(),
    ) {
        ChatComposer(
            state = state,
            onTextChange = { _, _, _ -> }, onSend = {}, onSendSteer = {}, onAbort = {},
            attachments = attachments,
            onAddAttachment = {},
            pendingSchedule = pendingSchedule,
            dictation = dictation,
            slashSuggestions = slashSuggestions,
            mentionSuggestions = mentionSuggestions,
        )
    }

    private fun chip(id: String, name: String, mime: String, status: ComposerAttachmentStatus) = ComposerAttachmentUi(
        id = id, filename = name, mimeType = mime, sizeBytes = 48_500, previewBytes = null, status = status,
    )
}

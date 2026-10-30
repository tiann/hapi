package app.hapi.companion.feature.settings

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest

/**
 * Pure-model tests for the P2 Chat preference types: storage-key round-trips
 * and corruption degradation for both enums, the web-evidence defaults of
 * [ChatSettings] (including each documented Android divergence), and the
 * in-memory fake. Values hand-verified against the Study-Web hooks
 * (`hapi-composer-enter-behavior`, `hapi-reasoning-collapsed`,
 * `hapi-codex-exploration-collapsed`, `hapi-tool-group-bg`,
 * `hapi-user-message-bg`).
 */
class ChatPrefsTest {

    @Test
    fun `enter behavior round-trips its storage keys and degrades unknowns`() {
        assertEquals("send", ComposerEnterBehavior.SEND.storageKey)
        assertEquals("newline", ComposerEnterBehavior.NEWLINE.storageKey)
        ComposerEnterBehavior.entries.forEach { behavior ->
            assertEquals(behavior, ComposerEnterBehavior.fromStorageKey(behavior.storageKey))
        }
        // Absent, junk, and case-mismatched values all degrade to the Android
        // default NEWLINE (the web stores lowercase keys only).
        assertEquals(ComposerEnterBehavior.NEWLINE, ComposerEnterBehavior.fromStorageKey(null))
        assertEquals(ComposerEnterBehavior.NEWLINE, ComposerEnterBehavior.fromStorageKey("enter"))
        assertEquals(ComposerEnterBehavior.NEWLINE, ComposerEnterBehavior.fromStorageKey("Send"))
    }

    @Test
    fun `surface colors round-trip their storage keys and degrade unknowns`() {
        assertEquals("default", ChatSurfaceColor.DEFAULT.storageKey)
        assertEquals("soft-blue", ChatSurfaceColor.SOFT_BLUE.storageKey)
        assertEquals("soft-green", ChatSurfaceColor.SOFT_GREEN.storageKey)
        assertEquals("soft-yellow", ChatSurfaceColor.SOFT_YELLOW.storageKey)
        ChatSurfaceColor.entries.forEach { color ->
            assertEquals(color, ChatSurfaceColor.fromStorageKey(color.storageKey))
        }
        // The web also accepts `custom:#rrggbb`; Android is preset-only, so a
        // stored custom value (e.g. migrated from web settings) degrades to
        // DEFAULT rather than rendering an unknown tint.
        assertEquals(ChatSurfaceColor.DEFAULT, ChatSurfaceColor.fromStorageKey(null))
        assertEquals(ChatSurfaceColor.DEFAULT, ChatSurfaceColor.fromStorageKey("custom:#ff0000"))
        assertEquals(ChatSurfaceColor.DEFAULT, ChatSurfaceColor.fromStorageKey("soft-red"))
        assertEquals(ChatSurfaceColor.DEFAULT, ChatSurfaceColor.fromStorageKey("Soft-Blue"))
    }

    @Test
    fun `defaults follow the web field-for-field except the documented divergences`() {
        val settings = ChatSettings()

        // Divergence: web default 'send'; Android ships NEWLINE (a soft keyboard
        // with an IME Send action offers no newline entry — opt-in).
        assertEquals(ComposerEnterBehavior.NEWLINE, settings.enterBehavior)
        // Divergence: web hook default false, but the web twin only auto-expands
        // while streaming and keeps resumed blocks folded; Android has no
        // streaming auto-expand, so collapsed matches the shipped presentation.
        assertTrue(settings.reasoningCollapsed)
        // Divergence: web codex-exploration-collapsed defaults true for group
        // cards; its nearest Android surface (plan-proposal cards) shipped
        // expanded, and the stored default keeps that.
        assertFalse(settings.toolCardsCollapsed)
        assertEquals(ChatSurfaceColor.DEFAULT, settings.toolGroupBackground)
        assertEquals(ChatSurfaceColor.DEFAULT, settings.userMessageBackground)
    }

    @Test
    fun `in-memory fake emits its initial value and applies updates`() = runTest {
        val initial = ChatSettings(enterBehavior = ComposerEnterBehavior.SEND)
        val prefs = InMemoryChatPrefs(initial)

        assertEquals(initial, prefs.settings.first())

        prefs.update { it.copy(reasoningCollapsed = false, toolGroupBackground = ChatSurfaceColor.SOFT_GREEN) }
        assertEquals(ComposerEnterBehavior.SEND, prefs.settings.value.enterBehavior)
        assertFalse(prefs.settings.value.reasoningCollapsed)
        assertEquals(ChatSurfaceColor.SOFT_GREEN, prefs.settings.value.toolGroupBackground)
        // Untouched fields keep their defaults through the transform.
        assertFalse(prefs.settings.value.toolCardsCollapsed)
        assertEquals(ChatSurfaceColor.DEFAULT, prefs.settings.value.userMessageBackground)
    }
}

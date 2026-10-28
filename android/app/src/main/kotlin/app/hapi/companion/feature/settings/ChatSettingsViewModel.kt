package app.hapi.companion.feature.settings

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/**
 * Chat-subpage state: the persisted [ChatSettings] as UI state plus
 * field-level setters (every setter is one [ChatPrefs.update], the web page's
 * one-hook-per-control twin). Plain constructor for JVM tests; Navigation
 * hosts it behind a per-hub lifecycle holder.
 */
class ChatSettingsViewModel(
    private val prefs: ChatPrefs,
    private val scope: CoroutineScope,
) {

    val settings: StateFlow<ChatSettings> = prefs.settings
        .stateIn(scope, SharingStarted.Eagerly, ChatSettings())

    fun setEnterBehavior(behavior: ComposerEnterBehavior) {
        write { it.copy(enterBehavior = behavior) }
    }

    fun setReasoningCollapsed(collapsed: Boolean) {
        write { it.copy(reasoningCollapsed = collapsed) }
    }

    fun setToolCardsCollapsed(collapsed: Boolean) {
        write { it.copy(toolCardsCollapsed = collapsed) }
    }

    fun setToolGroupBackground(color: ChatSurfaceColor) {
        write { it.copy(toolGroupBackground = color) }
    }

    fun setUserMessageBackground(color: ChatSurfaceColor) {
        write { it.copy(userMessageBackground = color) }
    }

    private fun write(transform: (ChatSettings) -> ChatSettings) {
        scope.launch { prefs.update(transform) }
    }
}

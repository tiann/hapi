package app.hapi.companion.feature.settings

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.stringPreferencesKey
import java.io.IOException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update

/**
 * Composer Enter-key behavior (web `hapi-composer-enter-behavior`:
 * `'send' | 'newline'`). The web hook defaults to `'send'` because desktop
 * keyboards keep Shift+Enter for newlines; Android stores `'newline'` as the
 * absent-key default instead — a soft keyboard with an IME Send action offers
 * no way to type a newline, so enter-to-send is strictly opt-in here.
 */
enum class ComposerEnterBehavior(val storageKey: String) {
    SEND("send"),
    NEWLINE("newline");

    companion object {
        /** Unknown/corrupt stored values degrade to the Android default. */
        fun fromStorageKey(raw: String?): ComposerEnterBehavior =
            entries.firstOrNull { it.storageKey == raw } ?: NEWLINE
    }
}

/**
 * Chat surface-color presets (web `hapi-tool-group-bg` /
 * `hapi-user-message-bg`: `'default' | 'preset:soft-blue' | 'preset:soft-green'
 * | 'preset:soft-yellow' | custom:#rrggbb`, default `'default'`). The free
 * custom-hex picker stays web-only: every Android choice is one of the shared
 * presets, mixed onto the themed surface by [app.hapi.companion.feature.chat.ChatSurfaces].
 */
enum class ChatSurfaceColor(val storageKey: String) {
    DEFAULT("default"),
    SOFT_BLUE("soft-blue"),
    SOFT_GREEN("soft-green"),
    SOFT_YELLOW("soft-yellow");

    companion object {
        /** Unknown/corrupt stored values degrade to [DEFAULT]. */
        fun fromStorageKey(raw: String?): ChatSurfaceColor =
            entries.firstOrNull { it.storageKey == raw } ?: DEFAULT
    }
}

/**
 * Chat settings (P2 web `/settings/chat`, scoped to this roadmap slice: the
 * composer Enter behavior, the two collapse defaults, and the two surface
 * colors). Defaults follow the web hooks field-for-field except where the
 * Android surface differs — each such field documents why.
 */
data class ChatSettings(
    /**
     * Enter key sends instead of inserting a newline (web default `'send'`;
     * Android default [ComposerEnterBehavior.NEWLINE], see its KDoc).
     */
    val enterBehavior: ComposerEnterBehavior = ComposerEnterBehavior.NEWLINE,
    /**
     * Fold reasoning blocks to the subdued one-liner initially (web
     * `hapi-reasoning-collapsed`, hook default `false`). Android stores
     * `true`: the web twin only auto-expands reasoning while it streams and
     * keeps resumed blocks folded (its per-card state starts closed), while
     * the Android block has no streaming state — collapsed is the shipped
     * presentation on both.
     */
    val reasoningCollapsed: Boolean = true,
    /**
     * Fold plan-proposal tool cards initially (web
     * `hapi-codex-exploration-collapsed`, hook default `true` — it targets the
     * web's collapsible exploration *groups*). Plan-proposal cards are the
     * only inline-foldable tool content on Android (groups and ordinary calls
     * open the inspector), and they shipped expanded, so the stored default
     * keeps that.
     */
    val toolCardsCollapsed: Boolean = false,
    /** Grouped tool-use card surface (web `hapi-tool-group-bg`, default `'default'`). */
    val toolGroupBackground: ChatSurfaceColor = ChatSurfaceColor.DEFAULT,
    /** User message bubble surface (web `hapi-user-message-bg`, default `'default'`). */
    val userMessageBackground: ChatSurfaceColor = ChatSurfaceColor.DEFAULT,
)

/**
 * Chat-preferences persistence (DisplayPrefs pattern): interface + DataStore
 * implementation + in-memory fake. Settings UI writes; the composer, the
 * reasoning/tool-card blocks, and the surface consumers read via the
 * `LocalChatSettings` / `LocalChatSurfaceColors` composition locals.
 */
interface ChatPrefs {
    /** Current settings; emits again on every change. */
    val settings: Flow<ChatSettings>

    /** Applies [transform] to the current persisted settings atomically. */
    suspend fun update(transform: (ChatSettings) -> ChatSettings)
}

/** Pure-state fake for JVM tests and previews. */
class InMemoryChatPrefs(initial: ChatSettings = ChatSettings()) : ChatPrefs {
    private val state = MutableStateFlow(initial)
    override val settings: StateFlow<ChatSettings> = state.asStateFlow()
    override suspend fun update(transform: (ChatSettings) -> ChatSettings) {
        state.update(transform)
    }
}

/**
 * DataStore-backed implementation over the app-wide `hapi_prefs` store
 * (DisplayPrefs precedent): corrupt/unknown values degrade per field (enum
 * fallbacks, booleans honored), never crash.
 */
class DataStoreChatPrefs(private val dataStore: DataStore<Preferences>) : ChatPrefs {

    override val settings: Flow<ChatSettings> = dataStore.data
        .catch { error -> if (error is IOException) emit(emptyPreferences()) else throw error }
        .map(::read)
        .distinctUntilChanged()

    override suspend fun update(transform: (ChatSettings) -> ChatSettings) {
        dataStore.edit { prefs ->
            write(prefs, transform(read(prefs)))
        }
    }

    private fun read(prefs: Preferences): ChatSettings = ChatSettings(
        enterBehavior = ComposerEnterBehavior.fromStorageKey(prefs[ENTER_BEHAVIOR_KEY]),
        reasoningCollapsed = prefs[REASONING_COLLAPSED_KEY] ?: true,
        toolCardsCollapsed = prefs[TOOL_CARDS_COLLAPSED_KEY] ?: false,
        toolGroupBackground = ChatSurfaceColor.fromStorageKey(prefs[TOOL_GROUP_BACKGROUND_KEY]),
        userMessageBackground = ChatSurfaceColor.fromStorageKey(prefs[USER_MESSAGE_BACKGROUND_KEY]),
    )

    private fun write(prefs: androidx.datastore.preferences.core.MutablePreferences, next: ChatSettings) {
        prefs[ENTER_BEHAVIOR_KEY] = next.enterBehavior.storageKey
        prefs[REASONING_COLLAPSED_KEY] = next.reasoningCollapsed
        prefs[TOOL_CARDS_COLLAPSED_KEY] = next.toolCardsCollapsed
        prefs[TOOL_GROUP_BACKGROUND_KEY] = next.toolGroupBackground.storageKey
        prefs[USER_MESSAGE_BACKGROUND_KEY] = next.userMessageBackground.storageKey
    }

    companion object {
        val ENTER_BEHAVIOR_KEY: Preferences.Key<String> = stringPreferencesKey("chat_composer_enter_behavior")
        val REASONING_COLLAPSED_KEY: Preferences.Key<Boolean> = booleanPreferencesKey("chat_reasoning_collapsed")
        val TOOL_CARDS_COLLAPSED_KEY: Preferences.Key<Boolean> = booleanPreferencesKey("chat_tool_cards_collapsed")
        val TOOL_GROUP_BACKGROUND_KEY: Preferences.Key<String> = stringPreferencesKey("chat_tool_group_background")
        val USER_MESSAGE_BACKGROUND_KEY: Preferences.Key<String> = stringPreferencesKey("chat_user_message_background")
    }
}

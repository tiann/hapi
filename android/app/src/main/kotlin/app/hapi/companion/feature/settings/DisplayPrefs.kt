package app.hapi.companion.feature.settings

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.floatPreferencesKey
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import java.io.IOException
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update

/**
 * Status detail for session rows (web `hapi-session-list-status-mode`:
 * `'standard' | 'detailed'`, default `'standard'`). Origin/main renders the
 * standard row only; the detailed variant joins when the upstream list-lens
 * PRs land, so this stays preference-only until then.
 */
enum class SessionListStatusMode(val storageKey: String) {
    STANDARD("standard"),
    DETAILED("detailed");

    companion object {
        /** Unknown/corrupt stored values degrade to [STANDARD]. */
        fun fromStorageKey(raw: String?): SessionListStatusMode =
            entries.firstOrNull { it.storageKey == raw } ?: STANDARD
    }
}

/**
 * In-app font scale tiers (web `hapi-font-scale`: 0.8 | 0.9 | 1 | 1.1 | 1.2 |
 * 1.3, default 1). The factor multiplies the [app.hapi.companion.ui.theme.HapiTypography]
 * tiers and composes with the platform's sp scaling rather than replacing it.
 */
enum class AppFontScale(val factor: Float) {
    XS(0.8f),
    S(0.9f),
    M(1.0f),
    L(1.1f),
    XL(1.2f),
    XXL(1.3f);

    /** Locale-invariant display label, e.g. `130%`. */
    val label: String get() = "${(factor * 100).roundToInt()}%"

    companion object {
        /**
         * Nearest tier to a raw (possibly corrupt/out-of-range) stored factor;
         * equidistant raws resolve toward the smaller factor. Null = absent.
         */
        fun fromFactor(raw: Float?): AppFontScale =
            entries.minWithOrNull(compareBy({ abs(it.factor - (raw ?: M.factor)) }, { it.factor })) ?: M
    }
}

/** Bounds for the session preview limit (web input `min=1 max=99`). */
object SessionPreviewLimit {
    const val MIN: Int = 1
    const val MAX: Int = 99

    /** Stored/typed values outside the range snap back into it. */
    fun coerce(raw: Int): Int = raw.coerceIn(MIN, MAX)
}

/**
 * Per-field visibility for session metadata (web `hapi-session-header-metadata`
 * JSON blob: ten booleans, defaults below). Web gates its chat-header items
 * with these (the session-list rows consume nothing); on Android they gate
 * the chat header's subtitle segments — agent flavor label ← `agent`,
 * machine ← `machine`, worktree ← `worktree`. The remaining fields persist
 * here (web consumes them in header segments Android's origin/main header
 * does not render) and gain gates as their Android surfaces land.
 */
data class SessionHeaderMetadata(
    val showLabels: Boolean = true,
    val agent: Boolean = true,
    val machine: Boolean = true,
    val lastActive: Boolean = true,
    val model: Boolean = true,
    val reasoning: Boolean = true,
    val fastMode: Boolean = true,
    val createdAt: Boolean = false,
    val updatedAt: Boolean = false,
    val worktree: Boolean = true,
)

/**
 * Display settings (P2 web `/settings/display`, scoped to the roadmap slice:
 * session-list preferences, header metadata, font scale). Defaults mirror the
 * web hooks field-for-field.
 */
data class DisplaySettings(
    /** Sessions kept in the list preview (web `hapi-session-preview-limit`, default 8). */
    val sessionPreviewLimit: Int = DEFAULT_SESSION_PREVIEW_LIMIT,
    /** Hide finished sessions (web `hapi-show-active-sessions-only`, default false). */
    val showActiveSessionsOnly: Boolean = false,
    /** Keep running sessions on top (web `hapi-pin-in-progress-sessions`, default false). */
    val pinInProgressSessions: Boolean = false,
    /** Row status detail (web `hapi-session-list-status-mode`, default standard). */
    val sessionListStatusMode: SessionListStatusMode = SessionListStatusMode.STANDARD,
    /** Session metadata visibility gates. */
    val headerMetadata: SessionHeaderMetadata = SessionHeaderMetadata(),
    /** In-app text scale over the chat typography tiers (web `hapi-font-scale`, default 1). */
    val fontScale: AppFontScale = AppFontScale.M,
) {
    companion object {
        const val DEFAULT_SESSION_PREVIEW_LIMIT: Int = 8
    }
}

/**
 * Display-preferences persistence. Interface + DataStore implementation +
 * in-memory fake (NewSessionPrefs precedent); settings UI writes, the session
 * list / typography read.
 */
interface DisplayPrefs {
    /** Current settings; emits again on every change. */
    val settings: Flow<DisplaySettings>

    /** Applies [transform] to the current persisted settings atomically. */
    suspend fun update(transform: (DisplaySettings) -> DisplaySettings)
}

/** Pure-state fake for JVM tests and previews. */
class InMemoryDisplayPrefs(initial: DisplaySettings = DisplaySettings()) : DisplayPrefs {
    private val state = MutableStateFlow(initial)
    override val settings: StateFlow<DisplaySettings> = state.asStateFlow()
    override suspend fun update(transform: (DisplaySettings) -> DisplaySettings) {
        state.update(transform)
    }
}

/**
 * DataStore-backed implementation over the app-wide `hapi_prefs` store
 * (ThemePrefs precedent). Unlike the web's localStorage hooks there is no
 * "delete the key when the value equals the default" convention — keys
 * persist once written and reads always resolve through the default table.
 * Out-of-range/corrupt values degrade in-field (clamped preview limit, tier-
 * snapped font scale, unknown status mode → standard), never crash.
 */
class DataStoreDisplayPrefs(private val dataStore: DataStore<Preferences>) : DisplayPrefs {

    override val settings: Flow<DisplaySettings> = dataStore.data
        .catch { error -> if (error is IOException) emit(emptyPreferences()) else throw error }
        .map(::read)
        .distinctUntilChanged()

    override suspend fun update(transform: (DisplaySettings) -> DisplaySettings) {
        dataStore.edit { prefs ->
            write(prefs, transform(read(prefs)))
        }
    }

    private fun read(prefs: Preferences): DisplaySettings = DisplaySettings(
        sessionPreviewLimit = SessionPreviewLimit.coerce(
            prefs[SESSION_PREVIEW_LIMIT_KEY] ?: DisplaySettings.DEFAULT_SESSION_PREVIEW_LIMIT,
        ),
        showActiveSessionsOnly = prefs[SHOW_ACTIVE_ONLY_KEY] ?: false,
        pinInProgressSessions = prefs[PIN_IN_PROGRESS_KEY] ?: false,
        sessionListStatusMode = SessionListStatusMode.fromStorageKey(prefs[STATUS_MODE_KEY]),
        headerMetadata = SessionHeaderMetadata(
            showLabels = prefs[HEADER_SHOW_LABELS_KEY] ?: true,
            agent = prefs[HEADER_AGENT_KEY] ?: true,
            machine = prefs[HEADER_MACHINE_KEY] ?: true,
            lastActive = prefs[HEADER_LAST_ACTIVE_KEY] ?: true,
            model = prefs[HEADER_MODEL_KEY] ?: true,
            reasoning = prefs[HEADER_REASONING_KEY] ?: true,
            fastMode = prefs[HEADER_FAST_MODE_KEY] ?: true,
            createdAt = prefs[HEADER_CREATED_AT_KEY] ?: false,
            updatedAt = prefs[HEADER_UPDATED_AT_KEY] ?: false,
            worktree = prefs[HEADER_WORKTREE_KEY] ?: true,
        ),
        fontScale = AppFontScale.fromFactor(prefs[FONT_SCALE_KEY]),
    )

    private fun write(prefs: androidx.datastore.preferences.core.MutablePreferences, next: DisplaySettings) {
        prefs[SESSION_PREVIEW_LIMIT_KEY] = SessionPreviewLimit.coerce(next.sessionPreviewLimit)
        prefs[SHOW_ACTIVE_ONLY_KEY] = next.showActiveSessionsOnly
        prefs[PIN_IN_PROGRESS_KEY] = next.pinInProgressSessions
        prefs[STATUS_MODE_KEY] = next.sessionListStatusMode.storageKey
        prefs[HEADER_SHOW_LABELS_KEY] = next.headerMetadata.showLabels
        prefs[HEADER_AGENT_KEY] = next.headerMetadata.agent
        prefs[HEADER_MACHINE_KEY] = next.headerMetadata.machine
        prefs[HEADER_LAST_ACTIVE_KEY] = next.headerMetadata.lastActive
        prefs[HEADER_MODEL_KEY] = next.headerMetadata.model
        prefs[HEADER_REASONING_KEY] = next.headerMetadata.reasoning
        prefs[HEADER_FAST_MODE_KEY] = next.headerMetadata.fastMode
        prefs[HEADER_CREATED_AT_KEY] = next.headerMetadata.createdAt
        prefs[HEADER_UPDATED_AT_KEY] = next.headerMetadata.updatedAt
        prefs[HEADER_WORKTREE_KEY] = next.headerMetadata.worktree
        prefs[FONT_SCALE_KEY] = next.fontScale.factor
    }

    companion object {
        val SESSION_PREVIEW_LIMIT_KEY: Preferences.Key<Int> = intPreferencesKey("session_preview_limit")
        val SHOW_ACTIVE_ONLY_KEY: Preferences.Key<Boolean> = booleanPreferencesKey("show_active_sessions_only")
        val PIN_IN_PROGRESS_KEY: Preferences.Key<Boolean> = booleanPreferencesKey("pin_in_progress_sessions")
        val STATUS_MODE_KEY: Preferences.Key<String> = stringPreferencesKey("session_list_status_mode")
        val FONT_SCALE_KEY: Preferences.Key<Float> = floatPreferencesKey("font_scale")
        val HEADER_SHOW_LABELS_KEY: Preferences.Key<Boolean> = booleanPreferencesKey("session_header_metadata_show_labels")
        val HEADER_AGENT_KEY: Preferences.Key<Boolean> = booleanPreferencesKey("session_header_metadata_agent")
        val HEADER_MACHINE_KEY: Preferences.Key<Boolean> = booleanPreferencesKey("session_header_metadata_machine")
        val HEADER_LAST_ACTIVE_KEY: Preferences.Key<Boolean> = booleanPreferencesKey("session_header_metadata_last_active")
        val HEADER_MODEL_KEY: Preferences.Key<Boolean> = booleanPreferencesKey("session_header_metadata_model")
        val HEADER_REASONING_KEY: Preferences.Key<Boolean> = booleanPreferencesKey("session_header_metadata_reasoning")
        val HEADER_FAST_MODE_KEY: Preferences.Key<Boolean> = booleanPreferencesKey("session_header_metadata_fast_mode")
        val HEADER_CREATED_AT_KEY: Preferences.Key<Boolean> = booleanPreferencesKey("session_header_metadata_created_at")
        val HEADER_UPDATED_AT_KEY: Preferences.Key<Boolean> = booleanPreferencesKey("session_header_metadata_updated_at")
        val HEADER_WORKTREE_KEY: Preferences.Key<Boolean> = booleanPreferencesKey("session_header_metadata_worktree")
    }
}

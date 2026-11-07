package app.hapi.companion.feature.settings

import app.hapi.data.auth.JwtPeek
import app.hapi.protocol.wire.HubHealthResponse
import app.hapi.companion.ui.theme.ColorThemePreset
import app.hapi.protocol.wire.HubSettings
import app.hapi.protocol.wire.UpdateHubSettingsRequest
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/** Namespace whose JWT belongs to the hub owner (usage/storage visible). */
const val OWNER_NAMESPACE: String = "default"

/**
 * Owner gate for the usage/storage entries: peeks the (unverified) `ns` claim
 * — the web twin is `getNamespaceFromToken(token) === 'default'`
 * (`SettingsNav.tsx`). Fails closed: no JWT / undecodable / missing claim all
 * hide the owner-only rows; the endpoints' own 403 stays the real enforcement.
 */
fun isOwnerNamespace(jwt: String?): Boolean =
    jwt != null && JwtPeek.peek(jwt)?.ns == OWNER_NAMESPACE

/** About-section hub probe (`GET /health`). */
sealed interface HubInfoState {
    data object Loading : HubInfoState
    data class Loaded(val health: HubHealthResponse) : HubInfoState
    data class Failed(val message: String?) : HubInfoState
}

/**
 * Owner-only hub settings (`GET/PUT /api/hub-settings`, the web general
 * page's switches). Absent until the owner check resolves; Failed hides the
 * sections (web renders nothing when the query has no data).
 */
sealed interface HubSettingsState {
    data object Loading : HubSettingsState
    data class Loaded(val settings: HubSettings) : HubSettingsState
    data class Failed(val message: String?) : HubSettingsState
}

/**
 * Settings-home state: appearance + language prefs (DataStore-backed), the
 * owner gate, and the About hub probe. Plain constructor for JVM tests;
 * Navigation hosts it behind a per-hub lifecycle holder. The hub directory
 * passes [probeHealth] = false — it needs only the owner gate, so opening the
 * hub itself fires no `/health` request (the General subpage's holder does).
 */
class SettingsViewModel(
    private val themePrefs: ThemePrefs,
    private val languagePrefs: LanguagePrefs,
    /** Active hub origin, shown in About. */
    val hubUrl: String,
    /** Current JWT for the active hub (blocking-safe: called on a worker). */
    private val currentJwt: suspend () -> String?,
    private val fetchHealth: suspend () -> HubHealthResponse,
    /** Owner-only `GET /api/hub-settings`; fetched once the owner check passes. */
    private val fetchHubSettings: suspend () -> HubSettings,
    /** Owner-only `PUT /api/hub-settings`. */
    private val putHubSettings: suspend (UpdateHubSettingsRequest) -> HubSettings,
    private val scope: CoroutineScope,
    /** Kick off the About hub probe eagerly (default) or skip it. */
    probeHealth: Boolean = true,
) {

    val themeSettings: StateFlow<ThemeSettings> = themePrefs.settings
        .stateIn(scope, SharingStarted.Eagerly, ThemeSettings())

    val language: StateFlow<AppLanguage> = languagePrefs.language
        .stateIn(scope, SharingStarted.Eagerly, AppLanguage.SYSTEM)

    private val mutableIsOwner = MutableStateFlow(false)

    /** True when the active hub's JWT namespace is [OWNER_NAMESPACE]. */
    val isOwner: StateFlow<Boolean> = mutableIsOwner.asStateFlow()

    private val mutableHubInfo = MutableStateFlow<HubInfoState>(HubInfoState.Loading)

    val hubInfo: StateFlow<HubInfoState> = mutableHubInfo.asStateFlow()

    private val mutableHubSettings = MutableStateFlow<HubSettingsState?>(null)

    /** Null until the owner check resolves; sections render only when [HubSettingsState.Loaded]. */
    val hubSettings: StateFlow<HubSettingsState?> = mutableHubSettings.asStateFlow()

    /** Last save failure, for a snackbar; null clears on the next success. */
    val hubSettingsSaveError = MutableStateFlow<String?>(null)

    @Volatile private var hubSettingsMutationInFlight = false

    init {
        scope.launch { mutableIsOwner.value = isOwnerNamespace(runCatching { currentJwt() }.getOrNull()) }
        if (probeHealth) {
            scope.launch { loadHubInfo() }
        }
        scope.launch {
            if (isOwner.value) loadHubSettings() else mutableIsOwner.collect { owner ->
                if (owner && mutableHubSettings.value == null) loadHubSettings()
            }
        }
    }

    fun setThemeMode(mode: ThemeMode) {
        scope.launch { themePrefs.setMode(mode) }
    }

    fun setDynamicColor(enabled: Boolean) {
        scope.launch { themePrefs.setDynamicColor(enabled) }
    }

    fun setPreset(preset: ColorThemePreset) {
        scope.launch { themePrefs.setPreset(preset) }
    }

    fun setLanguage(language: AppLanguage) {
        scope.launch { languagePrefs.setLanguage(language) }
    }

    fun retryHubInfo() {
        mutableHubInfo.value = HubInfoState.Loading
        scope.launch { loadHubInfo() }
    }

    /**
     * PUT a patch (web: one mutation at a time — a second toggle while a
     * save is running is dropped, matching `if (isPending) return`).
     * Success updates the loaded state and clears the error; failure keeps
     * the last loaded values and surfaces the message.
     */
    fun updateHubSettings(patch: UpdateHubSettingsRequest) {
        if (hubSettingsMutationInFlight) return
        hubSettingsMutationInFlight = true
        scope.launch {
            try {
                val saved = putHubSettings(patch)
                mutableHubSettings.value = HubSettingsState.Loaded(saved)
                hubSettingsSaveError.value = null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                hubSettingsSaveError.value = e.message ?: e.javaClass.simpleName
            } finally {
                hubSettingsMutationInFlight = false
            }
        }
    }

    private suspend fun loadHubSettings() {
        mutableHubSettings.value = HubSettingsState.Loading
        mutableHubSettings.value = try {
            HubSettingsState.Loaded(fetchHubSettings())
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            HubSettingsState.Failed(e.message)
        }
    }

    private suspend fun loadHubInfo() {
        mutableHubInfo.value = try {
            HubInfoState.Loaded(fetchHealth())
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            HubInfoState.Failed(e.message)
        }
    }
}

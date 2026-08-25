package app.hapi.companion.feature.settings

import app.hapi.data.auth.JwtPeek
import app.hapi.protocol.wire.HubHealthResponse
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
 * Settings-home state: appearance + language prefs (DataStore-backed), the
 * owner gate, and the About hub probe. Plain constructor for JVM tests;
 * Navigation hosts it behind a per-hub lifecycle holder.
 */
class SettingsViewModel(
    private val themePrefs: ThemePrefs,
    private val languagePrefs: LanguagePrefs,
    /** Active hub origin, shown in About. */
    val hubUrl: String,
    /** Current JWT for the active hub (blocking-safe: called on a worker). */
    private val currentJwt: suspend () -> String?,
    private val fetchHealth: suspend () -> HubHealthResponse,
    private val scope: CoroutineScope,
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

    init {
        scope.launch { mutableIsOwner.value = isOwnerNamespace(runCatching { currentJwt() }.getOrNull()) }
        scope.launch { loadHubInfo() }
    }

    fun setThemeMode(mode: ThemeMode) {
        scope.launch { themePrefs.setMode(mode) }
    }

    fun setDynamicColor(enabled: Boolean) {
        scope.launch { themePrefs.setDynamicColor(enabled) }
    }

    fun setLanguage(language: AppLanguage) {
        scope.launch { languagePrefs.setLanguage(language) }
    }

    fun retryHubInfo() {
        mutableHubInfo.value = HubInfoState.Loading
        scope.launch { loadHubInfo() }
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

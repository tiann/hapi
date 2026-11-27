package app.hapi.companion.feature.settings

import app.hapi.data.api.ApiError
import app.hapi.data.auth.JwtPeek
import app.hapi.protocol.wire.HubHealthResponse
import app.hapi.companion.ui.theme.ColorThemePreset
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
 * Navigation hosts it behind a per-hub lifecycle holder. The hub directory
 * passes [probeHealth] = false — it needs only the owner gate, so opening the
 * hub itself fires no `/health` request (the General subpage's holder does).
 */
data class CursorRetrySetting(val enabled: Boolean? = null, val pending: Boolean = false, val error: String? = null)

class SettingsViewModel(
    private val themePrefs: ThemePrefs,
    private val languagePrefs: LanguagePrefs,
    /** Active hub origin, shown in About. */
    val hubUrl: String,
    /** Current JWT for the active hub (blocking-safe: called on a worker). */
    private val currentJwt: suspend () -> String?,
    private val fetchHealth: suspend () -> HubHealthResponse,
    private val scope: CoroutineScope,
    /** Kick off the About hub probe eagerly (default) or skip it. */
    probeHealth: Boolean = true,
    private val fetchCursorRetry: (suspend () -> Boolean?)? = null,
    private val updateCursorRetry: (suspend (Boolean) -> Boolean?)? = null,
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

    private val retrySetting = MutableStateFlow(CursorRetrySetting())
    val cursorRetry: StateFlow<CursorRetrySetting> = retrySetting.asStateFlow()

    init {
        scope.launch {
            mutableIsOwner.value = isOwnerNamespace(runCatching { currentJwt() }.getOrNull())
            if (probeHealth && mutableIsOwner.value) refreshCursorRetry()
        }
        if (probeHealth) {
            scope.launch { loadHubInfo() }
        }
    }

    fun refreshCursorRetry() {
        val fetch = fetchCursorRetry ?: return
        if (!mutableIsOwner.value) return
        val previous = retrySetting.value
        if (previous.pending || !retrySetting.compareAndSet(previous, previous.copy(pending = true))) return
        scope.launch { runRetryRequest { fetch() } }
    }

    fun setCursorRetry(enabled: Boolean) {
        val update = updateCursorRetry ?: return
        val previous = retrySetting.value
        if (!mutableIsOwner.value || previous.enabled == null || previous.enabled == enabled || previous.pending) return
        if (!retrySetting.compareAndSet(previous, previous.copy(pending = true))) return
        scope.launch { runRetryRequest(reconcileFailure = true) { update(enabled) } }
    }

    private suspend fun runRetryRequest(reconcileFailure: Boolean = false, request: suspend () -> Boolean?) {
        retrySetting.value = try {
            CursorRetrySetting(enabled = request())
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            if (error is ApiError && (error.status == 403 || error.status == 404)) CursorRetrySetting()
            else {
                val confirmed = if (reconcileFailure) {
                    try {
                        fetchCursorRetry?.invoke()
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Exception) {
                        null
                    }
                } else null
                CursorRetrySetting(enabled = confirmed, error = error.message.orEmpty())
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

package app.hapi.companion.feature.pairing

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.hapi.data.api.ApiError
import app.hapi.data.auth.CredentialStore
import app.hapi.data.auth.HubCredentials
import app.hapi.data.auth.HubRegistry
import app.hapi.data.auth.HubUrls
import app.hapi.protocol.pairing.BindLink
import app.hapi.protocol.wire.SUPPORTED_PROTOCOL_VERSION
import java.io.IOException
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Pairing progress; one attempt at a time. */
sealed interface PairingUiState {
    data object Idle : PairingUiState
    data object Validating : PairingUiState
    data class Error(val error: PairingError) : PairingUiState

    /** Credentials stored, hub registered + active — navigate home. */
    data class Success(val hubUrl: String) : PairingUiState
}

/**
 * Semantic pairing failures (B-M5a): the ViewModel stays string-free and JVM
 * tests assert these directly; the pairing screens localize them.
 */
sealed interface PairingError {
    data object InvalidUrl : PairingError
    data object EmptyToken : PairingError
    data object TokenRejected : PairingError

    /** Deep-link "switch hub" raced a sign-out — that hub left the roster. */
    data object HubGone : PairingError

    data class Unreachable(val hubUrl: String) : PairingError
    data class NotAHub(val hubUrl: String) : PairingError
    data class ProtocolMismatch(val hubVersion: Int, val supportedVersion: Int) : PairingError
    data class AuthFailed(val httpStatus: Int) : PairingError
}

/** A `hapicompanion://bind` deep link waiting for user confirmation. */
data class BindPrefill(
    /** Normalized hub origin. */
    val hubUrl: String,
    val accessToken: String,
    /** True when this hub is already in the roster (offer switch/re-pair). */
    val alreadyPaired: Boolean,
)

/**
 * Drives one pairing attempt (`docs/api/client-contract/auth.md#pairing`):
 * normalize the URL → `GET /health` reachability + protocol check →
 * `POST /api/auth` exchange → persist [HubCredentials] → register + activate
 * in the [HubRegistry] → [PairingUiState.Success].
 *
 * Shared by the landing / QR-scan / manual-entry destinations (scoped to the
 * pairing nav graph), so an attempt started from a scan result reports into
 * the same state the other screens render.
 */
class PairingViewModel(
    private val clientFactory: PairingClientFactory,
    private val credentialStore: CredentialStore,
    private val registry: HubRegistry,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
    private val nowMs: () -> Long = System::currentTimeMillis,
) : ViewModel() {

    private val mutableState = MutableStateFlow<PairingUiState>(PairingUiState.Idle)
    val state: StateFlow<PairingUiState> = mutableState.asStateFlow()

    private val mutablePrefill = MutableStateFlow<BindPrefill?>(null)
    val prefill: StateFlow<BindPrefill?> = mutablePrefill.asStateFlow()

    /** Loads a deep link into the confirm card (replacing any previous one). */
    fun prefillFromLink(link: BindLink) {
        val normalized = HubUrls.normalize(link.hubUrl)
        if (normalized == null) {
            mutableState.value = PairingUiState.Error(PairingError.InvalidUrl)
            return
        }
        mutablePrefill.value = BindPrefill(
            hubUrl = normalized,
            accessToken = link.accessToken,
            alreadyPaired = normalized in registry.state.value.hubs,
        )
    }

    fun dismissPrefill() {
        mutablePrefill.value = null
    }

    /** Confirm the deep link: full pairing (also the "re-pair" choice). */
    fun pairFromPrefill() {
        prefill.value?.let { pair(it.hubUrl, it.accessToken) }
    }

    /** "Already paired / switch hub" choice: keep credentials, just activate. */
    fun switchToPrefilledHub() {
        val target = prefill.value ?: return
        viewModelScope.launch {
            mutableState.value = if (registry.setActiveHub(target.hubUrl)) {
                PairingUiState.Success(target.hubUrl)
            } else {
                // Roster changed under us (sign-out race): fall back to pairing.
                PairingUiState.Error(PairingError.HubGone)
            }
        }
    }

    /** Starts a pairing attempt; no-op while one is already validating. */
    fun pair(hubUrl: String, accessToken: String) {
        if (mutableState.value == PairingUiState.Validating) return
        val normalized = HubUrls.normalize(hubUrl)
        if (normalized == null) {
            mutableState.value = PairingUiState.Error(PairingError.InvalidUrl)
            return
        }
        // Trim whitespace only; the token stays opaque otherwise (never split
        // client-side — the `:namespace` suffix belongs to the hub).
        val token = accessToken.trim()
        if (token.isEmpty()) {
            mutableState.value = PairingUiState.Error(PairingError.EmptyToken)
            return
        }
        mutableState.value = PairingUiState.Validating
        viewModelScope.launch {
            mutableState.value = runPairing(normalized, token)
        }
    }

    /** Error → Idle (retry affordance); other states are left alone. */
    fun dismissError() {
        if (mutableState.value is PairingUiState.Error) {
            mutableState.value = PairingUiState.Idle
        }
    }

    private suspend fun runPairing(hubUrl: String, accessToken: String): PairingUiState {
        val client = clientFactory.create(hubUrl)

        val health = try {
            client.health()
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: IOException) {
            return PairingUiState.Error(PairingError.Unreachable(hubUrl))
        } catch (_: Exception) {
            // Non-2xx or a body that is not the health schema: something
            // answered, but it does not look like a HAPI hub.
            return PairingUiState.Error(PairingError.NotAHub(hubUrl))
        }
        if (health.protocolVersion != SUPPORTED_PROTOCOL_VERSION) {
            return PairingUiState.Error(
                PairingError.ProtocolMismatch(health.protocolVersion, SUPPORTED_PROTOCOL_VERSION),
            )
        }

        val auth = try {
            client.authenticate(accessToken)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: ApiError) {
            return if (error.status == 401) {
                PairingUiState.Error(PairingError.TokenRejected)
            } else {
                PairingUiState.Error(PairingError.AuthFailed(error.status))
            }
        } catch (_: Exception) {
            return PairingUiState.Error(PairingError.Unreachable(hubUrl))
        }

        // Credentials first, then the roster: the active-hub observer builds a
        // HubGraph as soon as the registry flips, and it must find the secret.
        withContext(ioDispatcher) {
            credentialStore.set(
                HubCredentials(
                    hubUrl = hubUrl,
                    accessToken = accessToken,
                    jwt = auth.token,
                    jwtObtainedAtMs = nowMs(),
                )
            )
        }
        registry.addHub(hubUrl, makeActive = true)
        mutablePrefill.value = null
        return PairingUiState.Success(hubUrl)
    }

}

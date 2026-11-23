package app.hapi.companion.feature.settings

import app.hapi.companion.feature.passkey.PasskeyIssue
import app.hapi.companion.feature.passkey.PasskeyPlatform
import app.hapi.companion.feature.passkey.passkeyIssueOf
import app.hapi.protocol.wire.NativePasskeys
import app.hapi.protocol.wire.PasskeySummary
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/** Transport seam over the authed `HapiApi` passkey endpoints (JVM-testable). */
interface PasskeysGateway {
    val hubUrl: String

    /** `GET /api/passkeys`. */
    suspend fun list(): List<PasskeySummary>

    /** `POST /api/passkey/register/options` `{"client":"native"}` — raw options JSON. */
    suspend fun registerOptions(): String

    /** `POST /api/passkey/register/verify`. */
    suspend fun registerVerify(response: JsonObject, name: String?)

    /** `DELETE /api/passkeys/:id`. */
    suspend fun delete(id: String)
}

sealed interface PasskeysUiState {
    data object Loading : PasskeysUiState
    data class Error(val message: String?) : PasskeysUiState
    data class Data(val passkeys: List<PasskeySummary>) : PasskeysUiState
}

/** The single in-flight mutation (buttons disable while non-null). */
sealed interface PasskeysBusy {
    data object Adding : PasskeysBusy
    data class Deleting(val id: String) : PasskeysBusy
}

/** One-shot outcome banner for the last add/delete. */
sealed interface PasskeysNotice {
    data object Added : PasskeysNotice
    data object Deleted : PasskeysNotice
    data class Failed(val issue: PasskeyIssue) : PasskeysNotice
}

/** True for passkeys the app can sign in with (registered for the native RP ID). */
val PasskeySummary.isAppPasskey: Boolean get() = rpId == NativePasskeys.RP_ID

/**
 * Settings → Passkeys: list this namespace's passkeys, register one for the
 * shared Web/App RP ID (`auth.hapi.run`), and delete with the screen's confirmation.
 *
 * Register: options (`{"client":"native"}`) → refuse unless `rp.id` is the
 * compiled RP ID → platform ceremony → verify with the chosen name → reload.
 * A dismissed sheet is silent. Web and native registration create the same
 * kind of Hub-scoped credential.
 */
class PasskeysViewModel(
    private val gateway: PasskeysGateway,
    private val scope: CoroutineScope,
) {
    private val mutableState = MutableStateFlow<PasskeysUiState>(PasskeysUiState.Loading)
    val state: StateFlow<PasskeysUiState> = mutableState.asStateFlow()

    private val mutableBusy = MutableStateFlow<PasskeysBusy?>(null)
    val busy: StateFlow<PasskeysBusy?> = mutableBusy.asStateFlow()

    private val mutableNotice = MutableStateFlow<PasskeysNotice?>(null)
    val notice: StateFlow<PasskeysNotice?> = mutableNotice.asStateFlow()

    private var loadJob: Job? = null

    fun start() {
        if (loadJob == null) refresh()
    }

    fun refresh() {
        loadJob?.cancel()
        if (mutableState.value !is PasskeysUiState.Data) mutableState.value = PasskeysUiState.Loading
        loadJob = scope.launch { reload() }
    }

    fun dismissNotice() {
        mutableNotice.value = null
    }

    /** Registers a new app passkey named [name] (trimmed/clamped; blank → unnamed). */
    fun addPasskey(name: String, platform: PasskeyPlatform) {
        if (mutableBusy.value != null) return
        mutableBusy.value = PasskeysBusy.Adding
        mutableNotice.value = null
        scope.launch {
            try {
                val options = gateway.registerOptions()
                val checkedOptions = NativePasskeys.registrationOptions(options, gateway.hubUrl)
                val registration = platform.createPasskey(checkedOptions)
                gateway.registerVerify(
                    NativePasskeys.credentialResponse(registration),
                    NativePasskeys.normalizeName(name),
                )
                mutableNotice.value = PasskeysNotice.Added
                reload()
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                passkeyIssueOf(error)?.let { mutableNotice.value = PasskeysNotice.Failed(it) }
            } finally {
                mutableBusy.value = null
            }
        }
    }

    /** Deletes [id] (the screen confirms first); revokes its sessions hub-side. */
    fun deletePasskey(id: String) {
        if (mutableBusy.value != null) return
        mutableBusy.value = PasskeysBusy.Deleting(id)
        mutableNotice.value = null
        scope.launch {
            try {
                gateway.delete(id)
                mutableNotice.value = PasskeysNotice.Deleted
                reload()
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                passkeyIssueOf(error)?.let { mutableNotice.value = PasskeysNotice.Failed(it) }
            } finally {
                mutableBusy.value = null
            }
        }
    }

    private suspend fun reload() {
        mutableState.value = try {
            PasskeysUiState.Data(
                gateway.list().sortedWith(
                    compareByDescending<PasskeySummary> { it.isAppPasskey }.thenByDescending { it.createdAt },
                ),
            )
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Exception) {
            // A failed background reload keeps the last good list on screen.
            mutableState.value as? PasskeysUiState.Data ?: PasskeysUiState.Error(error.message)
        }
    }
}

package app.hapi.data.push

import app.hapi.data.api.ApiError
import app.hapi.data.auth.HubRegistry
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * Current FCM registration token, or **null when push is unavailable** —
 * Firebase not configured (no `google-services.json`), Play services absent,
 * or the token fetch failed. A null token turns every registrar entry point
 * into a clean no-op (the `PushBinding.isAvailable` gate, threaded through).
 */
fun interface PushTokenSource {
    suspend fun currentToken(): String?
}

/**
 * Stable install id for `POST /api/devices/register` (`deviceId`): the hub
 * upserts on `(namespace, deviceId, platform)`, so the id must survive
 * re-registrations of the same install. `:app` persists a UUID in DataStore.
 */
fun interface PushDeviceIdSource {
    suspend fun deviceId(): String
}

/**
 * Deferred-retry seam for transient registration failures. `:app` backs this
 * with a WorkManager unique work item per hub (network-constrained,
 * exponential backoff); tests record invocations.
 */
fun interface RegistrationRetryScheduler {
    fun scheduleRetry(hubUrl: String)
}

/**
 * Narrow device-endpoint gateway ([HapiApi] is final; this keeps registrar
 * tests hermetic). Production adapter: [ApiPushDeviceGateway].
 */
interface PushDeviceGateway {
    suspend fun register(hubUrl: String, token: String, deviceId: String)
    suspend fun unregister(hubUrl: String, token: String)
}

/** [PushDeviceGateway] over on-demand authed sessions ([PushHubAccess]). */
class ApiPushDeviceGateway(private val hubAccess: PushHubAccess) : PushDeviceGateway {

    override suspend fun register(hubUrl: String, token: String, deviceId: String) {
        hubAccess.withApi(hubUrl) { api ->
            api.registerDevice(token = token, deviceId = deviceId, platform = PLATFORM)
        }
    }

    override suspend fun unregister(hubUrl: String, token: String) {
        hubAccess.withApi(hubUrl) { api -> api.unregisterDevice(token) }
    }

    private companion object {
        /** This app is the phone companion (`'phone' | 'wear'` per contract). */
        const val PLATFORM = "phone"
    }
}

/**
 * Keeps every paired hub's device registration current
 * (`docs/api/native-companion-contract.md`): the FCM token is registered to
 * **all** hubs in the roster — each hub pushes independently for its own
 * namespace — and unregistered from a hub on sign-out.
 *
 * Triggers:
 *  - [start]: the first roster emission (the loaded persisted roster)
 *    re-registers every hub — cheap upsert, and it heals registrations lost
 *    to reinstalls or hub-side pruning. Later emissions register only newly
 *    added hubs (fresh pairings).
 *  - [onNewToken]: FCM rotated the token — re-register everywhere.
 *  - [unregisterHub]: best-effort `DELETE` on sign-out, while the hub's JWT
 *    still works (the caller wipes credentials right after).
 *
 * Transient failures schedule a per-hub retry through
 * [RegistrationRetryScheduler]; permanent rejections (4xx schema errors) do
 * not — retrying an invalid request forever helps no one.
 */
class DeviceRegistrar(
    private val registry: HubRegistry,
    private val gateway: PushDeviceGateway,
    private val tokenSource: PushTokenSource,
    private val deviceIds: PushDeviceIdSource,
    private val retryScheduler: RegistrationRetryScheduler,
    private val scope: CoroutineScope,
) {

    /**
     * Begins observing the hub roster. Call after `HubRegistry.load()` so the
     * first emission is the persisted roster, not the pre-load empty state.
     */
    fun start() {
        scope.launch {
            var known: Set<String>? = null
            registry.state.map { it.hubs }.distinctUntilChanged().collect { hubs ->
                val previous = known
                known = hubs.toSet()
                // First emission: (re-)register everything. After: additions only.
                val toRegister = if (previous == null) hubs else hubs.filter { it !in previous }
                if (toRegister.isNotEmpty()) registerHubs(toRegister)
            }
        }
    }

    /** FCM token rotation (`onNewToken`): push [token] to every paired hub. */
    fun onNewToken(token: String) {
        scope.launch { registerHubs(registry.state.value.hubs, token) }
    }

    /**
     * Re-registers [hubUrl] once, letting failures propagate — the worker
     * retry path owns backoff. No-op when push is unavailable.
     */
    suspend fun registerHubOnce(hubUrl: String) {
        val token = tokenSource.currentToken() ?: return
        val deviceId = deviceIds.deviceId()
        gateway.register(hubUrl, token, deviceId)
    }

    /**
     * Best-effort `DELETE /api/devices/register` for [hubUrl]. Errors are
     * swallowed: the caller is about to wipe this hub's credentials, so a
     * retry could never authenticate anyway. (A leaked registration is
     * self-healing server-side — the hub prunes tokens FCM reports dead.)
     */
    suspend fun unregisterHub(hubUrl: String) {
        val token = tokenSource.currentToken() ?: return
        try {
            gateway.unregister(hubUrl, token)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Exception) {
            // Best effort by design.
        }
    }

    private suspend fun registerHubs(hubs: List<String>, presetToken: String? = null) {
        val token = presetToken ?: tokenSource.currentToken() ?: return // push unavailable
        val deviceId = deviceIds.deviceId()
        for (hubUrl in hubs) {
            try {
                gateway.register(hubUrl, token, deviceId)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                if (isTransient(error)) retryScheduler.scheduleRetry(hubUrl)
            }
        }
    }

    private fun isTransient(error: Exception): Boolean = when (error) {
        is ApiError -> error.status >= 500
            || error.status == 401 // silent re-auth failed right now; may recover
            || error.status == 408
            || error.status == 429
        else -> true // I/O — offline hub, DNS, timeouts
    }
}

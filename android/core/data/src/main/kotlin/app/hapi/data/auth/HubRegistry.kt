package app.hapi.data.auth

import app.hapi.protocol.wire.HapiJson
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

/**
 * Persistence seam for [HubRegistry]. `:app` wires a DataStore-backed (or
 * plain-file) implementation later; [InMemoryHubRegistryStorage] serves tests
 * and previews. The stored value is an opaque serialized blob owned by the
 * registry.
 */
interface HubRegistryStorage {
    suspend fun read(): String?
    suspend fun write(value: String)
}

/** Hermetic in-memory [HubRegistryStorage]. */
class InMemoryHubRegistryStorage(initial: String? = null) : HubRegistryStorage {
    @Volatile
    var stored: String? = initial
        private set

    override suspend fun read(): String? = stored

    override suspend fun write(value: String) {
        stored = value
    }
}

/** Persisted registry snapshot: paired hubs in user order + the active one. */
@Serializable
data class HubRegistryState(
    /** Normalized hub origins, in pairing order. */
    val hubs: List<String> = emptyList(),
    /** Normalized origin of the active hub; always an element of [hubs] (or null when empty). */
    val activeHubUrl: String? = null,
)

/**
 * Ordered multi-hub roster + active-hub selection. A client may be paired
 * with several hubs (`docs/api/client-contract/auth.md`); this registry owns
 * *which* hubs exist and which one the UI is pointed at — credentials for each
 * live in the [CredentialStore], keyed by the same normalized origin.
 *
 * All URLs are normalized via [HubUrls.normalize] on the way in; mutations are
 * serialized by an internal mutex, mirrored to [state] first and then
 * persisted through [HubRegistryStorage].
 */
class HubRegistry(private val storage: HubRegistryStorage) {

    private val mutex = Mutex()
    private val mutableState = MutableStateFlow(HubRegistryState())

    /** Current roster; collect for reactive UI, read `.value` for one-shots. */
    val state: StateFlow<HubRegistryState> = mutableState.asStateFlow()

    val activeHubUrl: String? get() = mutableState.value.activeHubUrl

    /** Loads the persisted snapshot (call once at startup, before mutations). */
    suspend fun load() {
        mutex.withLock {
            val raw = storage.read() ?: return
            val loaded = try {
                HapiJson.decodeFromString<HubRegistryState>(raw)
            } catch (_: Exception) {
                return // corrupt snapshot: keep the empty default
            }
            mutableState.value = sanitize(loaded)
        }
    }

    /**
     * Adds [hubUrl] (normalized) to the roster — or just re-activates it when
     * already present and [makeActive]. Returns the normalized origin, or null
     * when [hubUrl] is not a valid HTTPS URL.
     */
    suspend fun addHub(hubUrl: String, makeActive: Boolean = true): String? {
        val normalized = HubUrls.normalize(hubUrl) ?: return null
        mutate { current ->
            val hubs = if (normalized in current.hubs) current.hubs else current.hubs + normalized
            val active = when {
                makeActive -> normalized
                else -> current.activeHubUrl ?: normalized
            }
            HubRegistryState(hubs = hubs, activeHubUrl = active)
        }
        return normalized
    }

    /**
     * Removes [hubUrl] from the roster. When it was active, the first
     * remaining hub becomes active. Returns true when something was removed.
     */
    suspend fun removeHub(hubUrl: String): Boolean {
        val normalized = HubUrls.normalize(hubUrl) ?: hubUrl
        var removed = false
        mutate { current ->
            if (normalized !in current.hubs) return@mutate current
            removed = true
            val hubs = current.hubs - normalized
            val active = if (current.activeHubUrl == normalized) hubs.firstOrNull() else current.activeHubUrl
            HubRegistryState(hubs = hubs, activeHubUrl = active)
        }
        return removed
    }

    /** Makes [hubUrl] active; false when it is not in the roster. */
    suspend fun setActiveHub(hubUrl: String): Boolean {
        val normalized = HubUrls.normalize(hubUrl) ?: hubUrl
        var applied = false
        mutate { current ->
            if (normalized !in current.hubs) return@mutate current
            applied = true
            current.copy(activeHubUrl = normalized)
        }
        return applied
    }

    private suspend fun mutate(transform: (HubRegistryState) -> HubRegistryState) {
        mutex.withLock {
            val next = sanitize(transform(mutableState.value))
            if (next == mutableState.value) return
            mutableState.value = next
            storage.write(HapiJson.encodeToString(next))
        }
    }

    /** Restores the invariant: HTTPS-only, normalized/deduped hubs; active ∈ hubs. */
    private fun sanitize(state: HubRegistryState): HubRegistryState {
        val hubs = state.hubs.mapNotNull(HubUrls::normalize).distinct()
        val active = state.activeHubUrl
            ?.let(HubUrls::normalize)
            ?.takeIf { it in hubs }
            ?: hubs.firstOrNull()
        return HubRegistryState(hubs = hubs, activeHubUrl = active)
    }
}

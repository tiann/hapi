package app.hapi.companion.feature.pairing

import app.hapi.protocol.wire.AuthResponse
import app.hapi.protocol.wire.HubHealthResponse

/**
 * The two unauthenticated endpoints pairing needs, as a seam so
 * [PairingViewModel] is unit-testable without OkHttp. Production adapts
 * `HapiApi` (see `AppGraph.pairingClientFactory`); both methods throw
 * `ApiError` on non-2xx and `IOException` when the hub is unreachable.
 */
interface PairingClient {
    /** `GET /health` — reachability + `protocolVersion` probe. */
    suspend fun health(): HubHealthResponse

    /** `POST /api/auth` — access-token → JWT exchange; 401 = token rejected. */
    suspend fun authenticate(accessToken: String): AuthResponse
}

/** Builds a [PairingClient] for one candidate hub (normalized origin). */
fun interface PairingClientFactory {
    fun create(hubUrl: String): PairingClient
}

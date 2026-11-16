package app.hapi.companion.feature.pairing

import app.hapi.protocol.wire.AuthResponse
import app.hapi.protocol.wire.HubHealthResponse
import app.hapi.protocol.wire.PasskeyLoginResponse
import kotlinx.serialization.json.JsonObject

/**
 * The unauthenticated endpoints pairing needs, as a seam so
 * [PairingViewModel] is unit-testable without OkHttp. Production adapts
 * `HapiApi` (see `AppGraph.pairingClientFactory`); both methods throw
 * `ApiError` on non-2xx and `IOException` when the hub is unreachable.
 */
interface PairingClient {
    /** `GET /health` — reachability + `protocolVersion` probe. */
    suspend fun health(): HubHealthResponse

    /** `POST /api/auth` — access-token → JWT exchange; 401 = token rejected. */
    suspend fun authenticate(accessToken: String): AuthResponse

    /** `POST /api/passkey/login/options` `{"client":"native"}` — raw options JSON; 404 `no_passkeys`. */
    suspend fun passkeyLoginOptions(): String

    /** `POST /api/passkey/login/verify` — JWT + passkey session; 401 on a bad assertion. */
    suspend fun passkeyLoginVerify(response: JsonObject): PasskeyLoginResponse
}

/** Builds a [PairingClient] for one candidate hub (normalized origin). */
fun interface PairingClientFactory {
    fun create(hubUrl: String): PairingClient
}

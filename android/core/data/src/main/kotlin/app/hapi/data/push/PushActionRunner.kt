package app.hapi.data.push

import app.hapi.data.api.ApiError
import app.hapi.data.api.HapiApi
import app.hapi.protocol.wire.ApprovePermissionRequest
import app.hapi.protocol.wire.SendMessageRequest
import java.io.IOException
import kotlin.coroutines.cancellation.CancellationException

/** Terminal state of one hub-resolving push action (see [PushActionRunner]). */
sealed interface PushActionOutcome {

    /** The call succeeded against [hubUrl]. */
    data class Success(val hubUrl: String) : PushActionOutcome

    /**
     * A hub recognized the session but the permission request is gone —
     * decided elsewhere (web, another device) or expired. 404 `Request not
     * found` from `hub/src/web/routes/permissions.ts`, which the session
     * guard has already passed, so the answer is authoritative.
     */
    data class AlreadyHandled(val hubUrl: String) : PushActionOutcome

    /** A hub recognized the session but it is inactive (409 `session_inactive`). */
    data class SessionInactive(val hubUrl: String) : PushActionOutcome

    /** No paired hub knows the session (or nothing is paired). Permanent. */
    data object SessionNotFound : PushActionOutcome

    /** A hub rejected the call outright (unexpected 4xx). Permanent. */
    data class Failed(val hubUrl: String, val status: Int) : PushActionOutcome

    /**
     * At least one hub failed transiently (offline, 5xx, auth hiccup) and
     * none succeeded — worth retrying with backoff.
     */
    data object Transient : PushActionOutcome
}

/**
 * Executes notification actions (approve / deny / reply) against the right
 * hub. The FCM data payload deliberately carries **no hub URL** (contract v1),
 * so with several paired hubs the sender is ambiguous. Resolution strategy —
 * simple and correct rather than clever:
 *
 *  1. Try the **active** hub first, then the other paired hubs in roster
 *     order. Single-hub users therefore never pay anything for this.
 *  2. A 404 `Session not found` (and a 403 access-denied) means "not this
 *     hub" — move on. Session ids are UUIDs, so a false positive on another
 *     hub is not a practical concern.
 *  3. Any hub that recognizes the session answers authoritatively
 *     (success / request-already-handled / session-inactive) and the search
 *     stops.
 *
 * Wire bodies per `docs/api/native-companion-contract.md`: approve/deny post
 * `{}` (no options from the notification surface), reply posts
 * `{text, localId}`.
 */
class PushActionRunner(private val hubAccess: PushHubAccess) {

    /** `POST /sessions/:id/permissions/:rid/approve` with an empty options body. */
    suspend fun approve(sessionId: String, requestId: String): PushActionOutcome =
        resolveAcrossHubs { api ->
            api.approvePermission(sessionId, requestId, ApprovePermissionRequest())
        }

    /** `POST /sessions/:id/permissions/:rid/deny` with an empty options body. */
    suspend fun deny(sessionId: String, requestId: String): PushActionOutcome =
        resolveAcrossHubs { api ->
            api.denyPermission(sessionId, requestId, decision = null)
        }

    /** `POST /sessions/:id/messages` `{text, localId}` (notification reply). */
    suspend fun sendMessage(sessionId: String, text: String, localId: String): PushActionOutcome =
        resolveAcrossHubs { api ->
            api.sendMessage(sessionId, SendMessageRequest(text = text, localId = localId))
        }

    private suspend fun resolveAcrossHubs(call: suspend (HapiApi) -> Unit): PushActionOutcome {
        val hubs = hubAccess.pairedHubsActiveFirst()
        if (hubs.isEmpty()) return PushActionOutcome.SessionNotFound

        var sawTransient = false
        for (hubUrl in hubs) {
            try {
                hubAccess.withApi(hubUrl, call)
                return PushActionOutcome.Success(hubUrl)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: ApiError) {
                when (classify(error)) {
                    HubVerdict.NOT_THIS_HUB -> Unit // try the next hub
                    HubVerdict.ALREADY_HANDLED -> return PushActionOutcome.AlreadyHandled(hubUrl)
                    HubVerdict.SESSION_INACTIVE -> return PushActionOutcome.SessionInactive(hubUrl)
                    HubVerdict.REJECTED -> return PushActionOutcome.Failed(hubUrl, error.status)
                    HubVerdict.TRANSIENT -> sawTransient = true
                }
            } catch (_: IOException) {
                sawTransient = true // hub unreachable right now
            }
        }
        return if (sawTransient) PushActionOutcome.Transient else PushActionOutcome.SessionNotFound
    }

    private enum class HubVerdict { NOT_THIS_HUB, ALREADY_HANDLED, SESSION_INACTIVE, REJECTED, TRANSIENT }

    /**
     * Maps one hub's [ApiError] to a verdict. The two 404 flavors are told
     * apart by the hub's error string (surfaced as [ApiError.code] pseudo-code
     * fallback, same as the web reference): `Session not found` comes from the
     * session guard (`guards.ts`) — wrong hub; `Request not found` comes from
     * `permissions.ts` *after* that guard passed — right hub, request gone.
     * An unrecognizable 404 body (proxy page, future hub wording) is treated
     * as "not this hub": the safe degradation is a final "session not found"
     * notice, never a false "already handled".
     */
    private fun classify(error: ApiError): HubVerdict = when {
        error.status == 404 && error.code == REQUEST_NOT_FOUND -> HubVerdict.ALREADY_HANDLED
        error.status == 404 -> HubVerdict.NOT_THIS_HUB
        error.status == 403 -> HubVerdict.NOT_THIS_HUB // session owned by another namespace there
        error.status == 409 && error.code == SESSION_INACTIVE_CODE -> HubVerdict.SESSION_INACTIVE
        // 401 surfacing here means the silent re-auth itself failed (offline
        // auth endpoint, rotating secret) — retryable, not a verdict on the
        // session. 5xx / 503 `Not connected` (CLI away from the hub): same.
        error.status == 401 || error.status == 408 || error.status == 429 -> HubVerdict.TRANSIENT
        error.status >= 500 -> HubVerdict.TRANSIENT
        else -> HubVerdict.REJECTED
    }

    private companion object {
        /** Literal error strings from `hub/src/web/routes/{guards,permissions}.ts`. */
        const val REQUEST_NOT_FOUND = "Request not found"
        const val SESSION_INACTIVE_CODE = "session_inactive"
    }
}

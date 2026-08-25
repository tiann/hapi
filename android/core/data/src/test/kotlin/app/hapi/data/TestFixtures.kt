package app.hapi.data

import app.hapi.data.auth.AuthEvents
import app.hapi.data.auth.AuthTerminalReason
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Builds an unsigned JWT with hub-shaped claims (`{uid, ns, exp}`) —
 * `JwtPeek` never verifies signatures, so a junk third segment is fine.
 */
fun fakeJwt(expSeconds: Long? = null, uid: Long = 1, ns: String = "default"): String {
    val header = base64Url("""{"alg":"HS256","typ":"JWT"}""")
    val expPart = expSeconds?.let { ""","exp":$it""" } ?: ""
    val payload = base64Url("""{"uid":$uid,"ns":"$ns"$expPart}""")
    return "$header.$payload.signature"
}

fun base64Url(text: String): String =
    Base64.getUrlEncoder().withoutPadding().encodeToString(text.toByteArray(Charsets.UTF_8))

/** Collects terminal auth events for assertions (thread-safe: OkHttp threads emit). */
class RecordingAuthEvents : AuthEvents {
    val events = CopyOnWriteArrayList<Pair<String, AuthTerminalReason>>()

    override fun onAuthTerminal(hubUrl: String, reason: AuthTerminalReason) {
        events += hubUrl to reason
    }

    val reasons: List<AuthTerminalReason> get() = events.map { it.second }
}

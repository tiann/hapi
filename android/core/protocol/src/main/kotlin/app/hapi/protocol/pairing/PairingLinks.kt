package app.hapi.protocol.pairing

import java.net.URI
import java.net.URISyntaxException

/**
 * Scanner-side pairing-link parsing, accepting **both** QR codes the hub
 * prints (`hub/src/startHub.ts`, `docs/api/client-contract/auth.md#pairing`):
 *
 * 1. the companion deeplink `hapicompanion://bind?hub=<url>&code=<accessToken>`
 *    (canonical for natives — [BindLink.parse]), and
 * 2. the web direct-access URL `https://app.hapi.run/?hub=<url>&token=<accessToken>`
 *    — same credentials under `token=` instead of `code=`. Users will
 *    inevitably point the in-app scanner at the wrong QR of the pair, so
 *    [parse] extracts it equivalently as a convenience.
 *
 * The intent-filter deep-link path stays [BindLink.parse]-only: the OS never
 * routes web URLs to the app.
 */
object PairingLinks {

    /** Parses [raw] as a companion deeplink, falling back to the web QR form. */
    fun parse(raw: String): BindLink? = BindLink.parse(raw) ?: parseWebUrl(raw)

    /**
     * Parses the web direct-access QR: any absolute HTTPS URL whose query
     * carries non-blank `hub` (itself an HTTPS URL) and `token` params. The
     * host is deliberately not pinned to `app.hapi.run` — self-hosters may
     * serve the web app from their own origin. Returns null otherwise.
     */
    fun parseWebUrl(raw: String): BindLink? {
        val uri = try {
            URI(raw.trim())
        } catch (_: URISyntaxException) {
            return null
        }
        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme != "https") return null
        if ((uri.host ?: uri.authority).isNullOrBlank()) return null

        val params = BindLink.parseFormQuery(uri.rawQuery ?: return null) ?: return null
        val hub = params["hub"]?.takeIf { it.isNotBlank() } ?: return null
        val token = params["token"]?.takeIf { it.isNotBlank() } ?: return null
        if (!BindLink.isHttpsUrl(hub)) return null
        return BindLink(hubUrl = hub, accessToken = token)
    }
}

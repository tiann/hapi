package app.hapi.data.auth

import java.net.URI
import java.net.URISyntaxException

/**
 * HTTPS hub base-URL normalization. Credentials, registries, and clients key hubs by
 * the normalized **origin** so `https://Hub.example/`, `https://hub.example`
 * and `https://hub.example:443/foo` all address the same account (web
 * reference: the `hapi_access_token::<baseUrl>` localStorage key scheme,
 * `docs/api/client-contract/auth.md#credential-storage-guidance`).
 */
object HubUrls {

    /**
     * Normalizes [raw] to its origin: lowercase `scheme://host`, explicit port
     * only when non-default, no path/query/fragment, no trailing slash.
     * Returns null for anything that is not a valid absolute HTTPS URL.
     */
    fun normalize(raw: String): String? {
        val uri = try {
            URI(raw.trim())
        } catch (_: URISyntaxException) {
            return null
        }
        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme != "https") return null
        // URI.host is null for malformed authorities; IPv6 literals keep their brackets.
        val host = uri.host?.lowercase()?.takeIf { it.isNotBlank() } ?: return null
        val hostForOrigin = if (host.contains(':') && !host.startsWith('[')) "[$host]" else host
        val defaultPort = 443
        val port = uri.port
        return if (port == -1 || port == defaultPort) {
            "$scheme://$hostForOrigin"
        } else {
            "$scheme://$hostForOrigin:$port"
        }
    }
}

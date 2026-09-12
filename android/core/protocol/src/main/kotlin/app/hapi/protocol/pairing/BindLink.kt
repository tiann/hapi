package app.hapi.protocol.pairing

import java.io.UnsupportedEncodingException
import java.net.URI
import java.net.URISyntaxException
import java.net.URLDecoder

/**
 * Parsed companion pairing deep link.
 *
 * The hub prints (and renders as a QR code) a link of the form
 * `hapicompanion://bind?hub=<url>&code=<accessToken>` -- see `hub/src/startHub.ts`.
 * The query is built with `URLSearchParams`, i.e. `application/x-www-form-urlencoded`:
 * `%xx` escapes plus `+` for space. `code` is the raw CLI access token, possibly
 * suffixed with `:namespace`, so it round-trips percent-encoded (`%3A`).
 *
 * Pure JVM on purpose (java.net.URI, no android.net.Uri) so it is unit-testable
 * in this module; the `:app` deep-link handler converts its Intent data via
 * `toString()` before calling [parse].
 */
data class BindLink(
    val hubUrl: String,
    val accessToken: String,
) {
    companion object {
        const val SCHEME: String = "hapicompanion"
        const val HOST: String = "bind"

        /**
         * Parses [raw] into a [BindLink].
         *
         * Returns null on any malformed input: unparseable URI, wrong scheme or
         * host, missing/blank `hub` or `code` parameter, invalid percent escapes,
         * or a `hub` value that is not an HTTPS URL.
         */
        fun parse(raw: String): BindLink? {
            val uri = try {
                URI(raw.trim())
            } catch (_: URISyntaxException) {
                return null
            }
            if (!SCHEME.equals(uri.scheme, ignoreCase = true)) return null
            val host = uri.host ?: uri.authority ?: return null
            if (!HOST.equals(host, ignoreCase = true)) return null

            val params = parseFormQuery(uri.rawQuery ?: return null) ?: return null
            val hub = params["hub"]?.takeIf { it.isNotBlank() } ?: return null
            val code = params["code"]?.takeIf { it.isNotBlank() } ?: return null
            if (!isHttpsUrl(hub)) return null
            return BindLink(hubUrl = hub, accessToken = code)
        }

        /**
         * Decodes an `application/x-www-form-urlencoded` query string.
         * First occurrence wins for duplicate keys. Returns null if any
         * component carries invalid escapes. Internal so [PairingLinks] can
         * decode the web direct-access QR with identical semantics.
         */
        internal fun parseFormQuery(rawQuery: String): Map<String, String>? {
            val result = LinkedHashMap<String, String>()
            for (pair in rawQuery.split('&')) {
                if (pair.isEmpty()) continue
                val separator = pair.indexOf('=')
                val rawKey = if (separator >= 0) pair.substring(0, separator) else pair
                val rawValue = if (separator >= 0) pair.substring(separator + 1) else ""
                val key = decodeFormComponent(rawKey) ?: return null
                val value = decodeFormComponent(rawValue) ?: return null
                if (key !in result) result[key] = value
            }
            return result
        }

        private fun decodeFormComponent(component: String): String? = try {
            // String-charset overload: the Charset overload is unavailable on
            // Android below API 33, and this module also runs inside :app.
            URLDecoder.decode(component, "UTF-8")
        } catch (_: IllegalArgumentException) {
            null
        } catch (_: UnsupportedEncodingException) {
            null // unreachable: UTF-8 is always supported
        }

        internal fun isHttpsUrl(value: String): Boolean {
            val uri = try {
                URI(value)
            } catch (_: URISyntaxException) {
                return false
            }
            val scheme = uri.scheme?.lowercase() ?: return false
            if (scheme != "https") return false
            return !(uri.host ?: uri.authority).isNullOrBlank()
        }
    }
}

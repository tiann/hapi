/**
 * Hub URL helpers shared by the hub and the CLI.
 *
 * `HAPI_PUBLIC_URL` (hub) and `HAPI_API_URL` (CLI) are operator supplied and
 * feed CORS origins, notification links and WebSocket URLs. A value without a
 * scheme used to parse as "not a URL", which silently produced an empty CORS
 * allowlist and broke the web terminal. These helpers repair the common
 * scheme-less form while still rejecting input that cannot be a hub URL.
 */

const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i

function stripBrackets(value: string): string {
    if (value.startsWith('[') && value.endsWith(']')) {
        return value.slice(1, -1)
    }
    return value
}

/**
 * Hosts that are reached over plain HTTP in practice: loopback, private and
 * link-local networks, plus single-label intranet names. Everything else gets
 * HTTPS because HAPI's public endpoints (native pairing, Telegram) require it.
 */
export function isLocalOrPrivateHostname(hostname: string): boolean {
    const host = stripBrackets(hostname.trim().toLowerCase()).replace(/\.$/, '')
    if (!host) {
        return false
    }
    if (host === 'localhost' || host.endsWith('.localhost')) {
        return true
    }
    if (host.includes(':')) {
        // IPv6: loopback (::1), unique local (fc00::/7) and link local (fe80::/10).
        if (host === '::1') {
            return true
        }
        if (/^f[cd][0-9a-f]{0,2}:/.test(host)) {
            return true
        }
        return /^fe[89ab][0-9a-f]{0,2}:/.test(host)
    }
    const octets = host.split('.')
    if (octets.length !== 4) {
        return false
    }
    const numbers = octets.map((octet) => (/^\d{1,3}$/.test(octet) ? Number(octet) : Number.NaN))
    if (numbers.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
        return false
    }
    const [first, second] = numbers
    return first === 127
        || first === 10
        || (first === 172 && second >= 16 && second <= 31)
        || (first === 192 && second === 168)
        || (first === 169 && second === 254)
}

function extractHostname(hostPart: string): string {
    const withoutUserInfo = hostPart.slice(hostPart.lastIndexOf('@') + 1)
    if (withoutUserInfo.startsWith('[')) {
        const end = withoutUserInfo.indexOf(']')
        return end === -1 ? withoutUserInfo : withoutUserInfo.slice(1, end)
    }
    const colon = withoutUserInfo.indexOf(':')
    return colon === -1 ? withoutUserInfo : withoutUserInfo.slice(0, colon)
}

function inferScheme(value: string): 'http' | 'https' {
    const hostPart = value.split(/[/?#]/, 1)[0] ?? ''
    const hostname = extractHostname(hostPart)
    if (!hostname) {
        return 'https'
    }
    if (isLocalOrPrivateHostname(hostname)) {
        return 'http'
    }
    // Single-label host names are intranet hosts; public names carry a dot.
    return hostname.includes('.') ? 'https' : 'http'
}

/** Whether the value already carries an explicit URL scheme. */
export function hasUrlScheme(value: string): boolean {
    return URL_SCHEME_PATTERN.test(value.trim())
}

/**
 * Parse a hub URL, repairing the "missing scheme" form. Returns null when the
 * value cannot be a hub URL so callers can fail loudly with their own message.
 */
export function parseHubUrl(raw: string): URL | null {
    const trimmed = raw.trim()
    if (!trimmed) {
        return null
    }
    const candidate = hasUrlScheme(trimmed)
        ? trimmed
        : `${inferScheme(trimmed)}://${trimmed.replace(/^\/+/, '')}`
    let parsed: URL
    try {
        parsed = new URL(candidate)
    } catch {
        return null
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return null
    }
    // `normalizeHubUrl` rebuilds the URL from `origin`, which never carries
    // credentials: silently dropping them would misconfigure the client.
    if (parsed.username || parsed.password) {
        return null
    }
    if (!parsed.hostname) {
        return null
    }
    return parsed
}

/**
 * Normalized string form of a hub URL: repaired scheme, no trailing slash and
 * no hash, with path and query preserved.
 */
export function normalizeHubUrl(raw: string): string | null {
    const parsed = parseHubUrl(raw)
    if (!parsed) {
        return null
    }
    parsed.hash = ''
    const path = parsed.pathname.replace(/\/+$/, '')
    return `${parsed.origin}${path}${parsed.search}`
}

/**
 * Origin policy for the Engine.IO handshake.
 *
 * Browsers always attach an `Origin` header to the Socket.IO CONNECT POST
 * (same-origin non-GET requests included) and to WebSocket handshakes, so an
 * allowlist that misses the origin clients actually use would reject the hub's
 * own web client while REST/SSE kept working. Requests whose origin matches
 * the request Host are therefore always allowed; only genuinely cross-origin
 * requests are matched against the allowlist.
 */

export type OriginPolicyInput = {
    origin: string | null
    host: string | null
    allowedOrigins: string[]
    allowAllOrigins: boolean
}

function splitHostPort(value: string): { hostname: string; port: string | null } | null {
    const host = value.trim().toLowerCase()
    if (!host) {
        return null
    }
    if (host.startsWith('[')) {
        const end = host.indexOf(']')
        if (end === -1) {
            return null
        }
        const rest = host.slice(end + 1)
        if (rest && !rest.startsWith(':')) {
            return null
        }
        return { hostname: host.slice(0, end + 1), port: rest ? rest.slice(1) : null }
    }
    const colon = host.lastIndexOf(':')
    if (colon === -1) {
        return { hostname: host, port: null }
    }
    return { hostname: host.slice(0, colon), port: host.slice(colon + 1) }
}

function stripTrailingDot(hostname: string): string {
    return hostname.endsWith('.') ? hostname.slice(0, -1) : hostname
}

function effectivePort(port: string | null, protocol: string): string | null {
    if (!port) {
        return null
    }
    const defaultPort = protocol === 'https:' ? '443' : '80'
    return port === defaultPort ? null : port
}

/**
 * Whether the request's `Origin` header points at the same host the client
 * used to reach the hub. The scheme is intentionally ignored: behind a reverse
 * proxy the hub cannot reliably tell which scheme the browser used, and the
 * host is what identifies the deployment to the browser.
 */
export function isSameOriginHost(origin: string, hostHeader: string | null): boolean {
    if (!hostHeader) {
        return false
    }
    let originUrl: URL
    try {
        originUrl = new URL(origin)
    } catch {
        return false
    }
    if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') {
        return false
    }
    const originParts = splitHostPort(originUrl.host)
    const requestParts = splitHostPort(hostHeader)
    if (!originParts || !requestParts) {
        return false
    }
    if (stripTrailingDot(originParts.hostname) !== stripTrailingDot(requestParts.hostname)) {
        return false
    }
    return effectivePort(originParts.port, originUrl.protocol)
        === effectivePort(requestParts.port, originUrl.protocol)
}

export function isOriginAllowed(input: OriginPolicyInput): boolean {
    const { origin, host, allowedOrigins, allowAllOrigins } = input
    if (!origin) {
        return true
    }
    if (allowAllOrigins || allowedOrigins.includes(origin)) {
        return true
    }
    return isSameOriginHost(origin, host)
}

/**
 * Engine.IO `allowRequest` gate. Kept here rather than inline in the socket
 * server so the wiring — which headers feed the policy, and what a rejection
 * throws — stays covered by tests.
 *
 * The thrown value is a plain string on purpose: @socket.io/bun-engine puts it
 * straight into the 403 JSON body, so an `Error` would serialize as `{}`.
 */
export function createOriginGate(options: {
    allowedOrigins: string[]
    allowAllOrigins: boolean
}): (req: Request) => Promise<void> {
    return async (req) => {
        const allowed = isOriginAllowed({
            origin: req.headers.get('origin'),
            host: req.headers.get('host'),
            allowedOrigins: options.allowedOrigins,
            allowAllOrigins: options.allowAllOrigins
        })
        if (!allowed) {
            throw 'Origin not allowed'
        }
    }
}

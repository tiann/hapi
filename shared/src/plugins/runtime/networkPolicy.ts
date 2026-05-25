import type { PluginDiagnostic } from '../types'
import type { PluginNetwork } from '../sdk'

export type PluginNetworkDiagnosticSink = (
    severity: PluginDiagnostic['severity'],
    code: string,
    message: string
) => void

export type PluginNetworkAccessCheckResult =
    | {
        allowed: true
        normalizedTarget: string
    }
    | {
        allowed: false
        normalizedTarget: string
        reason: string
    }

export type CreatePluginNetworkOptions = {
    pluginId: string
    declaredNetwork?: string[]
    fetchImpl?: typeof fetch
    onDiagnostic?: PluginNetworkDiagnosticSink
    maxRedirects?: number
}

type NetworkRule = {
    protocol: string
    hostname: string
    port: string
    pathPrefix?: string
    wildcardHostSuffix?: string
}

type ParsedTarget = {
    url: URL
    normalizedTarget: string
}

const DEFAULT_MAX_REDIRECTS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export function createPluginNetwork(options: CreatePluginNetworkOptions): PluginNetwork {
    const fetchImpl = options.fetchImpl ?? fetch
    const declaredNetwork = options.declaredNetwork ?? []
    const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS

    return {
        async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
            const initialRequest = requestFromInput(input, {
                ...(init ?? {}),
                redirect: 'manual'
            })
            return fetchWithPolicy({
                request: initialRequest,
                depth: 0,
                declaredNetwork,
                pluginId: options.pluginId,
                fetchImpl,
                maxRedirects,
                onDiagnostic: options.onDiagnostic
            })
        }
    }
}

function requestFromInput(input: string | URL | Request, init: RequestInit): Request {
    if (input instanceof Request) return new Request(input, init)
    return new Request(input instanceof URL ? input.href : input, init)
}

export function checkPluginNetworkAccess(args: {
    pluginId: string
    declaredNetwork?: string[]
    inputUrl: string | URL
}): PluginNetworkAccessCheckResult {
    const target = parseTargetUrl(args.inputUrl)
    if (!target.ok) {
        return {
            allowed: false,
            normalizedTarget: String(args.inputUrl),
            reason: target.reason
        }
    }

    const privateReason = privateTargetReason(target.value.url)
    if (privateReason) {
        return {
            allowed: false,
            normalizedTarget: target.value.normalizedTarget,
            reason: privateReason
        }
    }

    const rules = (args.declaredNetwork ?? [])
        .map(parseRule)
        .filter((rule): rule is NetworkRule => Boolean(rule))
    const matched = rules.some((rule) => networkRuleMatches(rule, target.value.url))
    if (!matched) {
        return {
            allowed: false,
            normalizedTarget: target.value.normalizedTarget,
            reason: 'not declared in permissions.network'
        }
    }

    return {
        allowed: true,
        normalizedTarget: target.value.normalizedTarget
    }
}

async function fetchWithPolicy(args: {
    request: Request
    depth: number
    declaredNetwork: string[]
    pluginId: string
    fetchImpl: typeof fetch
    maxRedirects: number
    onDiagnostic?: PluginNetworkDiagnosticSink
}): Promise<Response> {
    const check = checkPluginNetworkAccess({
        pluginId: args.pluginId,
        declaredNetwork: args.declaredNetwork,
        inputUrl: args.request.url
    })
    if (!check.allowed) {
        args.onDiagnostic?.('warning', 'plugin-network-blocked', `Blocked SDK network request to ${check.normalizedTarget}: ${check.reason}.`)
        throw new Error(`Plugin network request blocked for ${check.normalizedTarget}: ${check.reason}`)
    }

    args.onDiagnostic?.('info', 'plugin-network-request', `Allowed SDK network request to ${check.normalizedTarget}.`)
    const response = await args.fetchImpl(args.request)

    if (!REDIRECT_STATUSES.has(response.status)) {
        return response
    }

    const location = response.headers.get('location')
    if (!location) {
        return response
    }
    const redirectUrl = new URL(location, args.request.url)
    const redirectCheck = checkPluginNetworkAccess({
        pluginId: args.pluginId,
        declaredNetwork: args.declaredNetwork,
        inputUrl: redirectUrl
    })
    if (!redirectCheck.allowed) {
        args.onDiagnostic?.('warning', 'plugin-network-blocked', `Blocked SDK network redirect to ${redirectCheck.normalizedTarget}: ${redirectCheck.reason}.`)
        throw new Error(`Plugin network redirect blocked for ${redirectCheck.normalizedTarget}: ${redirectCheck.reason}`)
    }
    if (args.depth >= args.maxRedirects) {
        throw new Error(`Plugin network request exceeded ${args.maxRedirects} redirect(s).`)
    }

    const next = replayableRedirectRequest(args.request, redirectUrl, response.status)
    if (!next) {
        return response
    }
    return fetchWithPolicy({
        ...args,
        request: next,
        depth: args.depth + 1
    })
}

function replayableRedirectRequest(request: Request, url: URL, status: number): Request | null {
    const method = request.method.toUpperCase()
    if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
        return new Request(url.href, {
            method: 'GET',
            headers: redirectHeaders(request.headers, false),
            redirect: 'manual'
        })
    }
    if (method === 'GET' || method === 'HEAD') {
        return new Request(url.href, {
            method,
            headers: redirectHeaders(request.headers, true),
            redirect: 'manual'
        })
    }
    return null
}

function redirectHeaders(headers: Headers, keepContentHeaders: boolean): Headers {
    const next = new Headers()
    for (const [key, value] of headers.entries()) {
        if (!keepContentHeaders && key.toLowerCase().startsWith('content-')) continue
        next.set(key, value)
    }
    return next
}

function parseTargetUrl(inputUrl: string | URL): { ok: true; value: ParsedTarget } | { ok: false; reason: string } {
    let url: URL
    try {
        url = inputUrl instanceof URL ? inputUrl : new URL(String(inputUrl))
    } catch {
        return { ok: false, reason: 'invalid URL' }
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        return { ok: false, reason: 'only http and https URLs are allowed' }
    }
    if (url.username || url.password) {
        return { ok: false, reason: 'URL credentials are not allowed' }
    }
    return {
        ok: true,
        value: {
            url,
            normalizedTarget: normalizeTarget(url)
        }
    }
}

function parseRule(raw: string): NetworkRule | null {
    const trimmed = raw.trim()
    if (!trimmed) return null
    let url: URL
    try {
        url = new URL(trimmed)
    } catch {
        return null
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        return null
    }
    if (url.username || url.password) {
        return null
    }
    const hostname = url.hostname.toLowerCase()
    const wildcardHostSuffix = hostname.startsWith('*.') ? hostname.slice(1) : undefined
    const pathPrefix = normalizeRulePath(url.pathname)
    return {
        protocol: url.protocol,
        hostname,
        port: url.port,
        ...(pathPrefix ? { pathPrefix } : {}),
        ...(wildcardHostSuffix ? { wildcardHostSuffix } : {})
    }
}

function normalizeRulePath(pathname: string): string | undefined {
    if (!pathname || pathname === '/' || pathname === '/*') return undefined
    if (pathname.endsWith('/*')) return pathname.slice(0, -1)
    return pathname
}

function networkRuleMatches(rule: NetworkRule, url: URL): boolean {
    if (url.protocol !== rule.protocol) return false
    if (url.port !== rule.port) return false

    const hostname = url.hostname.toLowerCase()
    if (rule.wildcardHostSuffix) {
        if (!hostname.endsWith(rule.wildcardHostSuffix)) return false
        if (hostname === rule.wildcardHostSuffix.slice(1)) return false
    } else if (hostname !== rule.hostname) {
        return false
    }

    if (rule.pathPrefix && !url.pathname.startsWith(rule.pathPrefix)) return false
    return true
}

function normalizeTarget(url: URL): string {
    return url.origin
}

function privateTargetReason(url: URL): string | null {
    const hostname = url.hostname.toLowerCase()
    const plainHost = stripIpv6Brackets(hostname)
    if (plainHost === 'localhost' || plainHost.endsWith('.localhost')) {
        return 'localhost targets are not allowed'
    }

    const version = detectIpVersion(plainHost)
    if (version === 4 && isPrivateIpv4(plainHost)) {
        return 'private or local IP targets are not allowed'
    }
    if (version === 6 && isPrivateIpv6(plainHost)) {
        return 'private or local IP targets are not allowed'
    }
    return null
}

function stripIpv6Brackets(hostname: string): string {
    return hostname.startsWith('[') && hostname.endsWith(']')
        ? hostname.slice(1, -1)
        : hostname
}

function isPrivateIpv4(value: string): boolean {
    const parts = value.split('.').map((entry) => Number(entry))
    if (parts.length !== 4 || parts.some((entry) => !Number.isInteger(entry) || entry < 0 || entry > 255)) return true
    const [a, b] = parts as [number, number, number, number]
    return a === 0
        || a === 10
        || a === 127
        || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168)
        || (a === 100 && b >= 64 && b <= 127)
}

function detectIpVersion(value: string): 0 | 4 | 6 {
    const parts = value.split('.').map((entry) => Number(entry))
    if (parts.length === 4 && parts.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255)) return 4
    if (value.includes(':')) return 6
    return 0
}

function isPrivateIpv6(value: string): boolean {
    const lower = value.toLowerCase()
    const mappedIpv4 = ipv4FromMappedIpv6(lower)
    if (mappedIpv4 && isPrivateIpv4(mappedIpv4)) return true
    return lower === '::'
        || lower === '::1'
        || lower.startsWith('fc')
        || lower.startsWith('fd')
        || lower.startsWith('fe8')
        || lower.startsWith('fe9')
        || lower.startsWith('fea')
        || lower.startsWith('feb')
}

function ipv4FromMappedIpv6(value: string): string | null {
    if (!value.startsWith('::ffff:')) return null
    const tail = value.slice('::ffff:'.length)
    if (detectIpVersion(tail) === 4) return tail
    const groups = tail.split(':')
    if (groups.length !== 2) return null
    const high = Number.parseInt(groups[0] ?? '', 16)
    const low = Number.parseInt(groups[1] ?? '', 16)
    if (!Number.isInteger(high) || !Number.isInteger(low) || high < 0 || high > 0xffff || low < 0 || low > 0xffff) return null
    return [
        (high >> 8) & 0xff,
        high & 0xff,
        (low >> 8) & 0xff,
        low & 0xff
    ].join('.')
}

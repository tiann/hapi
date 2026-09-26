/**
 * Unified proxy (egress) resolution and transport adapters.
 *
 * hapi's outbound paths do not agree on proxy environment variables: axios
 * reads HTTP(S)_PROXY itself, while npm `ws` (used by socket.io) and Bun's
 * native WebSocket ignore them. This module is the single resolver so every
 * transport makes the same direct/proxy decision for a given target.
 *
 * Rules (aligned with curl/proxy-from-env, plus IPv6 and CIDR edge cases):
 * - ws:// uses http_proxy, wss:// uses https_proxy;
 * - lowercase variables win over uppercase, then all_proxy/ALL_PROXY;
 * - loopback is always direct;
 * - NO_PROXY supports `*`, domains (including subdomains), host:port,
 *   IPv4/IPv6 literals and CIDR;
 * - schemeless proxy values default to http://;
 * - unsupported proxy protocols (e.g. socks5) throw instead of silently
 *   connecting direct.
 */

import type { Agent } from 'node:http'
import { HttpProxyAgent } from 'http-proxy-agent'
import { HttpsProxyAgent } from 'https-proxy-agent'

export type EgressTarget = string | URL

const LOOPBACK_NO_PROXY_ENTRIES = ['localhost', '127.0.0.1', '::1', '[::1]']

const DEFAULT_PORTS: Record<string, number> = {
    'http:': 80,
    'https:': 443,
    'ws:': 80,
    'wss:': 443
}

export class InvalidProxyUrlError extends Error {
    /** Credential-free rendering of the rejected value; the raw URL is never kept. */
    readonly redactedValue: string

    constructor(value: string) {
        const redacted = redactProxyValue(value)
        super(`Invalid proxy URL: ${redacted}`)
        this.name = 'InvalidProxyUrlError'
        this.redactedValue = redacted
    }
}

export class UnsupportedProxyProtocolError extends Error {
    constructor(readonly protocol: string) {
        super(
            `Unsupported proxy protocol "${protocol}": only http:// and https:// proxies are supported. `
            + 'Set HTTP_PROXY/HTTPS_PROXY/ALL_PROXY to an http(s) proxy URL.'
        )
        this.name = 'UnsupportedProxyProtocolError'
    }
}

/**
 * Merge loopback hosts into NO_PROXY so child processes (claude, runner,
 * hook forwarder) and runtime fetch never send local traffic to a proxy.
 */
export function ensureLoopbackProxyBypass(env: NodeJS.ProcessEnv = process.env): void {
    // Keep the same precedence as the resolver: lowercase wins.
    const existing = env.no_proxy ?? env.NO_PROXY ?? ''
    const entries = existing
        .split(/[,\s]+/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)

    if (entries.some((entry) => entry === '*')) {
        return
    }

    const present = new Set(entries.map((entry) => entry.toLowerCase()))
    for (const host of LOOPBACK_NO_PROXY_ENTRIES) {
        if (!present.has(host)) {
            entries.push(host)
        }
    }

    const merged = entries.join(',')
    env.NO_PROXY = merged
    env.no_proxy = merged
}

/** Resolve the proxy to use for a target, or null for a direct connection. */
export function resolveProxyUrl(target: EgressTarget, env: NodeJS.ProcessEnv = process.env): URL | null {
    const url = toUrl(target)
    const scheme = proxyEnvScheme(url.protocol)
    if (!scheme) {
        return null
    }

    const host = normalizeHostname(url.hostname)
    if (isLoopbackHost(host)) {
        return null
    }
    if (isNoProxyMatch(host, effectivePort(url), readEnv(env, 'no_proxy'))) {
        return null
    }

    const raw = readEnv(env, `${scheme}_proxy`) || readEnv(env, 'all_proxy')
    if (!raw) {
        return null
    }
    return parseProxyUrl(raw)
}

const agentCache = new Map<string, Agent>()

/**
 * Create (and reuse) a proxy agent for a target, or undefined for a direct
 * connection. The returned agent works for both axios and npm `ws`.
 */
export function createProxyAgent(target: EgressTarget, env: NodeJS.ProcessEnv = process.env): Agent | undefined {
    const proxy = resolveProxyUrl(target, env)
    if (!proxy) {
        return undefined
    }

    const secure = isSecureTarget(toUrl(target))
    const key = `${secure ? 'tls' : 'tcp'}:${proxy.href}`
    const cached = agentCache.get(key)
    if (cached) {
        return cached
    }

    const agent = secure ? new HttpsProxyAgent(proxy) : new HttpProxyAgent(proxy)
    agentCache.set(key, agent)
    return agent
}

/** Test helper: clear the agent cache so different env objects do not leak. */
export function clearProxyAgentCache(): void {
    agentCache.clear()
}

/**
 * Proxy options for npm `ws` / socket.io. engine.io-client forwards `agent`
 * to `ws.WebSocket`.
 */
export function webSocketProxyOptions(target: EgressTarget, env: NodeJS.ProcessEnv = process.env): { agent?: Agent } {
    const agent = createProxyAgent(target, env)
    return agent ? { agent } : {}
}

/**
 * Proxy options for Bun's native WebSocket (`new WebSocket(url, { proxy })`).
 * Bun's WebSocket ignores environment variables, so the proxy must be explicit.
 */
export function bunWebSocketProxyOptions(target: EgressTarget, env: NodeJS.ProcessEnv = process.env): { proxy?: string } {
    const proxy = resolveProxyUrl(target, env)
    return proxy ? { proxy: normalizeProxyHref(proxy) } : {}
}

/**
 * Human-readable egress description for logs/doctor, with credentials
 * redacted. Never throws: diagnostics must keep working when the proxy
 * configuration itself is invalid.
 */
export function describeEgress(target: EgressTarget, env: NodeJS.ProcessEnv = process.env): string {
    let proxy: URL | null
    try {
        proxy = resolveProxyUrl(target, env)
    } catch (error) {
        return `proxy error: ${error instanceof Error ? error.message : String(error)}`
    }
    return proxy ? `proxy ${redactProxyUrl(proxy)}` : 'direct'
}

/** Redact credentials from a proxy URL; schemeless values default to http://. */
export function redactProxyUrl(proxy: URL | string): string {
    const url = typeof proxy === 'string' ? new URL(withDefaultScheme(proxy)) : proxy
    const auth = url.username || url.password ? '***:***@' : ''
    return `${url.protocol}//${auth}${url.host}`
}

const PROXY_USERINFO_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/|\/\/)?[^/?#@]*@/

/**
 * Credential-free rendering for diagnostics. `redactProxyUrl` needs a parseable
 * URL, so values that fail to parse are masked textually: doctor output and
 * error messages must never echo userinfo.
 */
export function redactProxyValue(value: string): string {
    const trimmed = value.trim()
    try {
        return redactProxyUrl(trimmed)
    } catch {
        return trimmed.replace(PROXY_USERINFO_PATTERN, (_match, scheme: string | undefined) => `${scheme ?? ''}***:***@`)
    }
}

function toUrl(target: EgressTarget): URL {
    return typeof target === 'string' ? new URL(target) : target
}

function isSecureTarget(url: URL): boolean {
    return url.protocol === 'https:' || url.protocol === 'wss:'
}

function proxyEnvScheme(protocol: string): 'http' | 'https' | null {
    if (protocol === 'http:' || protocol === 'ws:') {
        return 'http'
    }
    if (protocol === 'https:' || protocol === 'wss:') {
        return 'https'
    }
    return null
}

function readEnv(env: NodeJS.ProcessEnv, name: string): string {
    return env[name.toLowerCase()] || env[name.toUpperCase()] || ''
}

function parseProxyUrl(raw: string): URL {
    const value = raw.trim()
    let url: URL
    try {
        url = new URL(withDefaultScheme(value))
    } catch {
        throw new InvalidProxyUrlError(raw)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new UnsupportedProxyProtocolError(url.protocol.replace(/:$/, ''))
    }
    return url
}

function hasScheme(value: string): boolean {
    return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)
}

function withDefaultScheme(value: string): string {
    const trimmed = value.trim()
    return hasScheme(trimmed) ? trimmed : `http://${trimmed}`
}

function normalizeProxyHref(proxy: URL): string {
    if (proxy.pathname === '/' && !proxy.search && !proxy.hash) {
        return proxy.href.slice(0, -1)
    }
    return proxy.href
}

function effectivePort(url: URL): number {
    if (url.port) {
        return Number(url.port)
    }
    return DEFAULT_PORTS[url.protocol] ?? 0
}

function normalizeHostname(hostname: string): string {
    const lower = hostname.trim().toLowerCase()
    if (lower.startsWith('[') && lower.endsWith(']')) {
        return lower.slice(1, -1)
    }
    return lower
}

function isLoopbackHost(host: string): boolean {
    if (host === 'localhost' || host.endsWith('.localhost')) {
        return true
    }
    const ipv4 = parseIPv4(host)
    if (ipv4 !== null) {
        return (ipv4 >>> 24) === 127
    }
    return parseIPv6(host) === 1n
}

interface NoProxyEntry {
    host: string
    port?: number
    cidr?: { network: string; prefix: number }
}

function isNoProxyMatch(host: string, port: number, value: string): boolean {
    if (!value) {
        return false
    }

    for (const rawEntry of value.split(/[,\s]+/)) {
        const entry = rawEntry.trim()
        if (!entry) {
            continue
        }
        if (entry === '*') {
            return true
        }

        const parsed = parseNoProxyEntry(entry)
        if (!parsed) {
            continue
        }
        if (parsed.port !== undefined && parsed.port !== port) {
            continue
        }
        if (parsed.cidr) {
            if (ipInCidr(host, parsed.cidr.network, parsed.cidr.prefix)) {
                return true
            }
            continue
        }
        if (isIpLiteral(parsed.host)) {
            // URL parsing canonicalizes the target host, NO_PROXY entries keep the
            // spelling the user wrote, so compare addresses by value.
            if (ipLiteralEquals(host, parsed.host)) {
                return true
            }
            continue
        }
        // Match curl semantics: a bare domain covers itself and its subdomains.
        if (host === parsed.host || host.endsWith(`.${parsed.host}`)) {
            return true
        }
    }
    return false
}

function parseNoProxyEntry(rawEntry: string): NoProxyEntry | null {
    let entry = rawEntry.trim().toLowerCase()
    if (!entry || entry === '*') {
        return null
    }
    if (entry.startsWith('*.')) {
        entry = entry.slice(2)
    } else if (entry.startsWith('.')) {
        entry = entry.slice(1)
    }

    const slash = entry.indexOf('/')
    if (slash !== -1) {
        const network = normalizeHostname(entry.slice(0, slash))
        const prefix = Number(entry.slice(slash + 1))
        if (!Number.isInteger(prefix) || prefix < 0 || !isIpLiteral(network)) {
            return null
        }
        return { host: network, cidr: { network, prefix } }
    }

    const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry)
    if (bracketed) {
        return {
            host: normalizeHostname(bracketed[1]),
            port: bracketed[2] ? Number(bracketed[2]) : undefined
        }
    }

    if (countColons(entry) === 1) {
        const [host, port] = entry.split(':')
        if (host && /^\d+$/.test(port)) {
            return { host: normalizeHostname(host), port: Number(port) }
        }
    }

    return { host: normalizeHostname(entry) }
}

function countColons(value: string): number {
    let count = 0
    for (const char of value) {
        if (char === ':') {
            count += 1
        }
    }
    return count
}

function isIpLiteral(host: string): boolean {
    return parseIPv4(host) !== null || parseIPv6(host) !== null
}

function ipLiteralEquals(a: string, b: string): boolean {
    const aV4 = parseIPv4(a)
    const bV4 = parseIPv4(b)
    if (aV4 !== null && bV4 !== null) {
        return aV4 === bV4
    }
    const aV6 = parseIPv6(a)
    const bV6 = parseIPv6(b)
    return aV6 !== null && bV6 !== null && aV6 === bV6
}

function ipInCidr(host: string, network: string, prefix: number): boolean {
    const hostV4 = parseIPv4(host)
    const networkV4 = parseIPv4(network)
    if (hostV4 !== null && networkV4 !== null) {
        if (prefix > 32) {
            return false
        }
        const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
        return ((hostV4 & mask) >>> 0) === ((networkV4 & mask) >>> 0)
    }

    const hostV6 = parseIPv6(host)
    const networkV6 = parseIPv6(network)
    if (hostV6 !== null && networkV6 !== null) {
        if (prefix > 128) {
            return false
        }
        const shift = BigInt(128 - prefix)
        return (hostV6 >> shift) === (networkV6 >> shift)
    }

    return false
}

function parseIPv4(value: string): number | null {
    const parts = value.split('.')
    if (parts.length !== 4) {
        return null
    }
    let result = 0
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) {
            return null
        }
        const octet = Number(part)
        if (octet > 255) {
            return null
        }
        result = ((result << 8) | octet) >>> 0
    }
    return result
}

function parseIPv6(value: string): bigint | null {
    let text = value.trim().toLowerCase()
    const zone = text.indexOf('%')
    if (zone !== -1) {
        text = text.slice(0, zone)
    }
    if (!text) {
        return null
    }

    if (text.includes('.')) {
        const lastColon = text.lastIndexOf(':')
        const embeddedV4 = parseIPv4(text.slice(lastColon + 1))
        if (embeddedV4 === null) {
            return null
        }
        const high = (embeddedV4 >>> 16).toString(16)
        const low = (embeddedV4 & 0xffff).toString(16)
        text = `${text.slice(0, lastColon)}:${high}:${low}`
    }

    const doubleColon = text.indexOf('::')
    if (doubleColon !== -1) {
        if (text.indexOf('::', doubleColon + 2) !== -1) {
            return null
        }
        const head = text.slice(0, doubleColon).split(':').filter((group) => group.length > 0)
        const tail = text.slice(doubleColon + 2).split(':').filter((group) => group.length > 0)
        const missing = 8 - head.length - tail.length
        if (missing < 1) {
            return null
        }
        return groupsToBigInt([...head, ...Array<string>(missing).fill('0'), ...tail])
    }

    const groups = text.split(':')
    if (groups.length !== 8) {
        return null
    }
    return groupsToBigInt(groups)
}

function groupsToBigInt(groups: string[]): bigint | null {
    let result = 0n
    for (const group of groups) {
        if (!/^[0-9a-f]{1,4}$/.test(group)) {
            return null
        }
        result = (result << 16n) | BigInt(parseInt(group, 16))
    }
    return result
}

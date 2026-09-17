import { describe, expect, it } from 'bun:test'
import { HttpProxyAgent } from 'http-proxy-agent'
import { HttpsProxyAgent } from 'https-proxy-agent'
import {
    UnsupportedProxyProtocolError,
    bunWebSocketProxyOptions,
    clearProxyAgentCache,
    createProxyAgent,
    describeEgress,
    ensureLoopbackProxyBypass,
    redactProxyUrl,
    resolveProxyUrl,
    webSocketProxyOptions
} from './proxy'

const PROXY = 'http://user:pass@proxy.example:7890'

describe('ensureLoopbackProxyBypass', () => {
    it('adds loopback hosts when NO_PROXY is unset', () => {
        const env: NodeJS.ProcessEnv = {}
        ensureLoopbackProxyBypass(env)
        expect(env.NO_PROXY).toBe('localhost,127.0.0.1,::1,[::1]')
        expect(env.no_proxy).toBe('localhost,127.0.0.1,::1,[::1]')
    })

    it('merges with existing entries without duplicating', () => {
        const env: NodeJS.ProcessEnv = { NO_PROXY: 'npmjs.org,LOCALHOST, 127.0.0.1,::1' }
        ensureLoopbackProxyBypass(env)
        expect(env.NO_PROXY).toBe('npmjs.org,LOCALHOST,127.0.0.1,::1,[::1]')
    })

    it('reads lowercase no_proxy when NO_PROXY is unset', () => {
        const env: NodeJS.ProcessEnv = { no_proxy: 'example.com' }
        ensureLoopbackProxyBypass(env)
        expect(env.NO_PROXY).toBe('example.com,localhost,127.0.0.1,::1,[::1]')
    })

    it('prefers lowercase no_proxy when both are set', () => {
        const env: NodeJS.ProcessEnv = { NO_PROXY: 'upper.example', no_proxy: 'lower.example' }
        ensureLoopbackProxyBypass(env)
        expect(env.NO_PROXY).toBe('lower.example,localhost,127.0.0.1,::1,[::1]')
        expect(env.no_proxy).toBe('lower.example,localhost,127.0.0.1,::1,[::1]')
    })

    it('leaves a wildcard NO_PROXY untouched', () => {
        const env: NodeJS.ProcessEnv = { NO_PROXY: '*' }
        ensureLoopbackProxyBypass(env)
        expect(env.NO_PROXY).toBe('*')
        expect(env.no_proxy).toBeUndefined()
    })
})

describe('resolveProxyUrl', () => {
    it('uses https_proxy for https targets', () => {
        const env: NodeJS.ProcessEnv = { HTTPS_PROXY: PROXY }
        expect(resolveProxyUrl('https://hub.example.com/cli', env)?.href).toBe(`${PROXY}/`)
    })

    it('maps wss to https_proxy and ws to http_proxy', () => {
        const env: NodeJS.ProcessEnv = {
            HTTPS_PROXY: 'http://secure-proxy.example:8443',
            HTTP_PROXY: 'http://plain-proxy.example:8080'
        }
        expect(resolveProxyUrl('wss://hub.example.com/cli', env)?.host).toBe('secure-proxy.example:8443')
        expect(resolveProxyUrl('ws://hub.example.com/cli', env)?.host).toBe('plain-proxy.example:8080')
    })

    it('prefers lowercase env vars over uppercase ones', () => {
        const env: NodeJS.ProcessEnv = {
            HTTPS_PROXY: 'http://upper.example:1111',
            https_proxy: 'http://lower.example:2222'
        }
        expect(resolveProxyUrl('https://hub.example.com', env)?.host).toBe('lower.example:2222')
    })

    it('falls back to ALL_PROXY when no scheme-specific proxy is set', () => {
        const env: NodeJS.ProcessEnv = { ALL_PROXY: PROXY }
        expect(resolveProxyUrl('https://hub.example.com', env)?.host).toBe('proxy.example:7890')
        expect(resolveProxyUrl('wss://hub.example.com', env)?.host).toBe('proxy.example:7890')
    })

    it('prefixes schemeless proxy values with http://', () => {
        const env: NodeJS.ProcessEnv = { HTTPS_PROXY: 'proxy.example:7890' }
        expect(resolveProxyUrl('https://hub.example.com', env)?.href).toBe('http://proxy.example:7890/')
    })

    it('returns null when no proxy is configured', () => {
        expect(resolveProxyUrl('https://hub.example.com', {})).toBeNull()
    })

    it('throws for unsupported proxy protocols instead of silently connecting direct', () => {
        const env: NodeJS.ProcessEnv = { HTTPS_PROXY: 'socks5://proxy.example:1080' }
        expect(() => resolveProxyUrl('https://hub.example.com', env)).toThrow(UnsupportedProxyProtocolError)
        expect(() => resolveProxyUrl('https://hub.example.com', env)).toThrow(/socks5/)
    })

    it('keeps credentials for proxy authentication', () => {
        const env: NodeJS.ProcessEnv = { HTTPS_PROXY: PROXY }
        const proxy = resolveProxyUrl('https://hub.example.com', env)
        expect(proxy?.username).toBe('user')
        expect(proxy?.password).toBe('pass')
    })
})

describe('NO_PROXY matching', () => {
    const withNoProxy = (noProxy: string): NodeJS.ProcessEnv => ({
        HTTPS_PROXY: PROXY,
        NO_PROXY: noProxy
    })

    it('honors a wildcard', () => {
        expect(resolveProxyUrl('https://hub.example.com', withNoProxy('*'))).toBeNull()
    })

    it('matches exact hosts and subdomains for bare domains', () => {
        expect(resolveProxyUrl('https://hub.example.com', withNoProxy('example.com'))).toBeNull()
        expect(resolveProxyUrl('https://example.com', withNoProxy('example.com'))).toBeNull()
        expect(resolveProxyUrl('https://other.com', withNoProxy('example.com'))).not.toBeNull()
    })

    it('matches *.domain and .domain suffixes', () => {
        expect(resolveProxyUrl('https://a.example.com', withNoProxy('*.example.com'))).toBeNull()
        expect(resolveProxyUrl('https://a.example.com', withNoProxy('.example.com'))).toBeNull()
        expect(resolveProxyUrl('https://example.com', withNoProxy('*.example.com'))).toBeNull()
    })

    it('honors host:port entries', () => {
        expect(resolveProxyUrl('https://hub.example.com', withNoProxy('hub.example.com:443'))).toBeNull()
        expect(resolveProxyUrl('https://hub.example.com', withNoProxy('hub.example.com:8443'))).not.toBeNull()
    })

    it('matches IPv4 loopback and IPv6 loopback in both bracket styles', () => {
        expect(resolveProxyUrl('http://127.0.0.1:3006', withNoProxy(''))).toBeNull()
        expect(resolveProxyUrl('http://[::1]:3006', withNoProxy(''))).toBeNull()
        expect(resolveProxyUrl('ws://[::1]:3006', { HTTPS_PROXY: PROXY, HTTP_PROXY: PROXY })).toBeNull()
        expect(resolveProxyUrl('https://[2001:db8::5]', withNoProxy('[2001:db8::5]'))).toBeNull()
        expect(resolveProxyUrl('https://[2001:db8::5]', withNoProxy('[2001:db8::6]'))).not.toBeNull()
    })

    it('matches IPv4 CIDR entries', () => {
        expect(resolveProxyUrl('https://10.1.2.3', withNoProxy('10.0.0.0/8'))).toBeNull()
        expect(resolveProxyUrl('https://11.1.2.3', withNoProxy('10.0.0.0/8'))).not.toBeNull()
    })

    it('matches IPv6 CIDR entries', () => {
        expect(resolveProxyUrl('https://[2001:db8::5]', withNoProxy('2001:db8::/32'))).toBeNull()
        expect(resolveProxyUrl('https://[2001:db9::5]', withNoProxy('2001:db8::/32'))).not.toBeNull()
    })

    it('never proxies loopback even without NO_PROXY', () => {
        const env: NodeJS.ProcessEnv = { HTTPS_PROXY: PROXY, HTTP_PROXY: PROXY, ALL_PROXY: PROXY }
        expect(resolveProxyUrl('http://127.0.0.1:3006/health', env)).toBeNull()
        expect(resolveProxyUrl('http://localhost:3006/health', env)).toBeNull()
        expect(resolveProxyUrl('http://[::1]:3006/health', env)).toBeNull()
    })
})

describe('proxy agents', () => {
    it('creates an HttpsProxyAgent for https/wss targets', () => {
        clearProxyAgentCache()
        const env: NodeJS.ProcessEnv = { HTTPS_PROXY: PROXY }
        expect(createProxyAgent('https://hub.example.com', env)).toBeInstanceOf(HttpsProxyAgent)
        expect(createProxyAgent('wss://hub.example.com', env)).toBeInstanceOf(HttpsProxyAgent)
    })

    it('creates an HttpProxyAgent for http/ws targets', () => {
        clearProxyAgentCache()
        const env: NodeJS.ProcessEnv = { HTTP_PROXY: PROXY }
        expect(createProxyAgent('http://hub.example.com', env)).toBeInstanceOf(HttpProxyAgent)
        expect(createProxyAgent('ws://hub.example.com', env)).toBeInstanceOf(HttpProxyAgent)
    })

    it('returns undefined for direct targets and caches agents per proxy', () => {
        clearProxyAgentCache()
        const env: NodeJS.ProcessEnv = { HTTPS_PROXY: PROXY }
        expect(createProxyAgent('https://hub.example.com', {})).toBeUndefined()
        const first = createProxyAgent('https://hub.example.com', env)
        const second = createProxyAgent('https://other.example.com', env)
        expect(first).toBeDefined()
        expect(second).toBe(first)
    })

    it('returns ws options only when a proxy applies', () => {
        clearProxyAgentCache()
        const env: NodeJS.ProcessEnv = { HTTPS_PROXY: PROXY }
        expect(webSocketProxyOptions('wss://hub.example.com', env).agent).toBeInstanceOf(HttpsProxyAgent)
        expect(webSocketProxyOptions('wss://hub.example.com', {})).toEqual({})
    })

    it('returns Bun WebSocket proxy options with credentials', () => {
        const options = bunWebSocketProxyOptions('wss://hub.example.com', { HTTPS_PROXY: PROXY })
        expect(options.proxy).toBe('http://user:pass@proxy.example:7890')
        expect(bunWebSocketProxyOptions('wss://hub.example.com', {})).toEqual({})
    })
})

describe('diagnostics', () => {
    it('describes direct and proxied egress without leaking credentials', () => {
        expect(describeEgress('https://hub.example.com', {})).toBe('direct')
        expect(describeEgress('https://hub.example.com', { HTTPS_PROXY: PROXY })).toBe('proxy http://***:***@proxy.example:7890')
        expect(redactProxyUrl(PROXY)).toBe('http://***:***@proxy.example:7890')
    })

    it('redacts schemeless and non-http proxy values without dropping the port', () => {
        expect(redactProxyUrl('proxy.example:7890')).toBe('http://proxy.example:7890')
        expect(redactProxyUrl('user:pass@proxy.example:7890')).toBe('http://***:***@proxy.example:7890')
        expect(redactProxyUrl('socks5://user:pass@proxy.example:1080')).toBe('socks5://***:***@proxy.example:1080')
    })

    it('reports unsupported or invalid proxy configs instead of throwing', () => {
        const unsupported = describeEgress('https://hub.example.com', { HTTPS_PROXY: 'socks5://proxy.example:1080' })
        expect(unsupported).toContain('socks5')

        const invalid = describeEgress('https://hub.example.com', { HTTPS_PROXY: 'http://' })
        expect(invalid).toContain('Invalid proxy URL')
    })
})

import { describe, expect, it } from 'vitest'
import { hasUrlScheme, isLocalOrPrivateHostname, normalizeHubUrl, parseHubUrl } from './url'

describe('hasUrlScheme', () => {
    it('detects explicit schemes', () => {
        expect(hasUrlScheme('https://hapi.example.com')).toBe(true)
        expect(hasUrlScheme('  HTTP://hapi.example.com')).toBe(true)
        expect(hasUrlScheme('hapi.example.com')).toBe(false)
        expect(hasUrlScheme('hub-host:3006')).toBe(false)
    })
})

describe('parseHubUrl', () => {
    it('keeps absolute http(s) URLs', () => {
        expect(parseHubUrl('https://hapi.example.com')?.origin).toBe('https://hapi.example.com')
        expect(parseHubUrl('http://hapi.example.com:3006/base')?.origin).toBe('http://hapi.example.com:3006')
    })

    it('defaults scheme-less public host names to https', () => {
        expect(parseHubUrl('hapi.example.com')?.origin).toBe('https://hapi.example.com')
        expect(parseHubUrl('hapi.example.com:8443')?.origin).toBe('https://hapi.example.com:8443')
        expect(parseHubUrl('//hapi.example.com')?.origin).toBe('https://hapi.example.com')
    })

    it('defaults scheme-less loopback, private and single-label hosts to http', () => {
        expect(parseHubUrl('localhost:3006')?.origin).toBe('http://localhost:3006')
        expect(parseHubUrl('127.0.0.1:3006')?.origin).toBe('http://127.0.0.1:3006')
        expect(parseHubUrl('192.168.1.20:3006')?.origin).toBe('http://192.168.1.20:3006')
        expect(parseHubUrl('[::1]:3006')?.origin).toBe('http://[::1]:3006')
        expect(parseHubUrl('hub-host:3006')?.origin).toBe('http://hub-host:3006')
    })

    it('rejects non-http protocols and unparseable values', () => {
        expect(parseHubUrl('ftp://hapi.example.com')).toBeNull()
        expect(parseHubUrl('ws://hapi.example.com')).toBeNull()
        expect(parseHubUrl('not a url')).toBeNull()
        expect(parseHubUrl('http://')).toBeNull()
        expect(parseHubUrl('   ')).toBeNull()
    })

    it('rejects URLs with embedded credentials', () => {
        // Normalization rebuilds the URL from `origin`, which cannot carry
        // credentials, so these would silently become anonymous requests.
        expect(parseHubUrl('http://user:pass@hapi.example.com')).toBeNull()
        expect(parseHubUrl('https://user@hapi.example.com')).toBeNull()
    })
})

describe('normalizeHubUrl', () => {
    it('repairs the scheme and drops the trailing slash', () => {
        expect(normalizeHubUrl('hapi.example.com/')).toBe('https://hapi.example.com')
        expect(normalizeHubUrl('  https://hapi.example.com  ')).toBe('https://hapi.example.com')
    })

    it('keeps path and query while dropping the hash', () => {
        expect(normalizeHubUrl('hapi.example.com/base/?tenant=1#section'))
            .toBe('https://hapi.example.com/base?tenant=1')
    })

    it('returns null for values that cannot be hub URLs', () => {
        expect(normalizeHubUrl('not a url')).toBeNull()
        expect(normalizeHubUrl('ftp://hapi.example.com')).toBeNull()
        expect(normalizeHubUrl('http://user:pass@hapi.example.com')).toBeNull()
    })
})

describe('isLocalOrPrivateHostname', () => {
    it('detects loopback, private and link-local hosts', () => {
        for (const host of [
            'localhost',
            'hub.localhost',
            '127.0.0.1',
            '10.1.2.3',
            '172.16.0.1',
            '172.31.255.254',
            '192.168.0.10',
            '169.254.1.1',
            '::1',
            'fd00::1',
            'fe80::1'
        ]) {
            expect(isLocalOrPrivateHostname(host)).toBe(true)
        }
    })

    it('does not treat public hosts as local', () => {
        for (const host of ['hapi.example.com', '172.32.0.1', '192.169.0.1', 'fcbank.example.com', '8.8.8.8']) {
            expect(isLocalOrPrivateHostname(host)).toBe(false)
        }
    })
})

import { describe, expect, it } from 'bun:test'
import { createOriginGate, isOriginAllowed, isSameOriginHost } from './originPolicy'

describe('isOriginAllowed', () => {
    it('allows requests without an Origin header (non-browser clients)', () => {
        expect(isOriginAllowed({
            origin: null,
            host: 'hapi.example.com',
            allowedOrigins: [],
            allowAllOrigins: false
        })).toBe(true)
    })

    it('allows every origin when the allowlist is a wildcard', () => {
        expect(isOriginAllowed({
            origin: 'https://elsewhere.example',
            host: 'hapi.example.com',
            allowedOrigins: ['*'],
            allowAllOrigins: true
        })).toBe(true)
    })

    it('allows an origin that is listed explicitly', () => {
        expect(isOriginAllowed({
            origin: 'https://app.example.com',
            host: 'hapi.example.com',
            allowedOrigins: ['https://app.example.com'],
            allowAllOrigins: false
        })).toBe(true)
    })

    it('allows the hub own origin even when the allowlist is empty (regression)', () => {
        // A scheme-less publicUrl used to derive an empty allowlist, which
        // rejected the browser's own CONNECT POST and killed the terminal.
        expect(isOriginAllowed({
            origin: 'https://hapi.example.com',
            host: 'hapi.example.com',
            allowedOrigins: [],
            allowAllOrigins: false
        })).toBe(true)
    })

    it('allows same-host requests on a non-default port', () => {
        expect(isOriginAllowed({
            origin: 'http://192.168.1.20:3006',
            host: '192.168.1.20:3006',
            allowedOrigins: [],
            allowAllOrigins: false
        })).toBe(true)
    })

    it('still rejects cross-origin requests', () => {
        expect(isOriginAllowed({
            origin: 'https://evil.example',
            host: 'hapi.example.com',
            allowedOrigins: [],
            allowAllOrigins: false
        })).toBe(false)
        expect(isOriginAllowed({
            origin: 'https://hapi.example.com.evil.example',
            host: 'hapi.example.com',
            allowedOrigins: [],
            allowAllOrigins: false
        })).toBe(false)
        expect(isOriginAllowed({
            origin: 'https://hapi.example.com:8443',
            host: 'hapi.example.com',
            allowedOrigins: [],
            allowAllOrigins: false
        })).toBe(false)
    })

    it('rejects opaque and malformed origins without a usable host', () => {
        expect(isOriginAllowed({
            origin: 'null',
            host: 'hapi.example.com',
            allowedOrigins: [],
            allowAllOrigins: false
        })).toBe(false)
        expect(isOriginAllowed({
            origin: 'https://hapi.example.com',
            host: null,
            allowedOrigins: [],
            allowAllOrigins: false
        })).toBe(false)
        expect(isOriginAllowed({
            origin: 'not a url',
            host: 'not a url',
            allowedOrigins: [],
            allowAllOrigins: false
        })).toBe(false)
    })
})

describe('isSameOriginHost', () => {
    it('ignores case and a trailing dot', () => {
        expect(isSameOriginHost('https://HAPI.Example.com', 'hapi.example.com')).toBe(true)
        expect(isSameOriginHost('https://hapi.example.com', 'hapi.example.com.')).toBe(true)
    })

    it('treats default ports as equivalent to no port', () => {
        expect(isSameOriginHost('https://hapi.example.com', 'hapi.example.com:443')).toBe(true)
        expect(isSameOriginHost('http://hapi.example.com', 'hapi.example.com:80')).toBe(true)
        expect(isSameOriginHost('https://hapi.example.com', 'hapi.example.com:80')).toBe(false)
    })

    it('compares IPv6 hosts including the port', () => {
        expect(isSameOriginHost('http://[::1]:3006', '[::1]:3006')).toBe(true)
        expect(isSameOriginHost('http://[::1]:3006', '[::1]:3007')).toBe(false)
    })

    it('rejects non-http(s) origins', () => {
        expect(isSameOriginHost('ftp://hapi.example.com', 'hapi.example.com')).toBe(false)
    })
})

describe('createOriginGate', () => {
    function gateFor(allowedOrigins: string[], allowAllOrigins = false) {
        return createOriginGate({ allowedOrigins, allowAllOrigins })
    }

    function socketRequest(host: string, origin: string): Request {
        return new Request('https://hapi.example.com/socket.io/?EIO=4&transport=polling', {
            headers: { host, origin }
        })
    }

    it('allows the hub own origin and rejects cross-origin requests', async () => {
        const gate = gateFor([])

        await expect(gate(socketRequest('hapi.example.com', 'https://hapi.example.com')))
            .resolves.toBeUndefined()
        await expect(gate(socketRequest('hapi.example.com', 'https://evil.example')))
            .rejects.toBe('Origin not allowed')
    })

    it('allows every origin for a wildcard allowlist', async () => {
        const gate = gateFor(['*'], true)

        await expect(gate(socketRequest('hapi.example.com', 'https://elsewhere.example')))
            .resolves.toBeUndefined()
    })

    it('allows requests without an Origin header', async () => {
        const gate = gateFor([])
        const request = new Request('https://hapi.example.com/socket.io/?EIO=4', {
            headers: { host: 'hapi.example.com' }
        })

        await expect(gate(request)).resolves.toBeUndefined()
    })
})

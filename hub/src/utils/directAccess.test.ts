import { describe, expect, it } from 'bun:test'
import { buildRelayDirectAccessUrl, buildTokenizedUrl } from './directAccess'

describe('buildTokenizedUrl', () => {
    it('adds the token query parameter', () => {
        expect(buildTokenizedUrl('http://localhost:3006', 'secret-token'))
            .toBe('http://localhost:3006/?token=secret-token')
    })

    it('preserves existing query parameters', () => {
        expect(buildTokenizedUrl('https://example.com/app?foo=bar', 'secret-token'))
            .toBe('https://example.com/app?foo=bar&token=secret-token')
    })
})

describe('buildRelayDirectAccessUrl', () => {
    it('adds hub and token query parameters', () => {
        expect(buildRelayDirectAccessUrl('https://app.hapi.run', 'https://relay.example', 'secret-token'))
            .toBe('https://app.hapi.run/?hub=https%3A%2F%2Frelay.example&token=secret-token')
    })

    it('preserves existing query parameters', () => {
        expect(buildRelayDirectAccessUrl('https://app.hapi.run/?lang=zh-CN', 'https://relay.example', 'secret-token'))
            .toBe('https://app.hapi.run/?lang=zh-CN&hub=https%3A%2F%2Frelay.example&token=secret-token')
    })
})

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

import { RelayClient } from './relayClient'

describe('RelayClient', () => {
    let originalFetch: typeof globalThis.fetch
    beforeEach(() => {
        originalFetch = globalThis.fetch
    })
    afterEach(() => {
        globalThis.fetch = originalFetch
    })

    it('POSTs the spec-shaped body to {relayUrl}/v1/push and maps 200 to sent', async () => {
        let capturedUrl = ''
        let capturedInit: RequestInit | undefined
        globalThis.fetch = mock(async (url: unknown, init?: RequestInit) => {
            capturedUrl = String(url)
            capturedInit = init
            return new Response('{"ok":true}', { status: 200 })
        }) as unknown as typeof fetch

        const client = new RelayClient('https://push.hapi.run')
        const outcome = await client.send({
            token: 'a1b2c3',
            envelope: 'RU5DUllQVEVE',
            collapseId: 'ready-sess-1',
            priority: 10
        })

        expect(outcome).toBe('sent')
        expect(capturedUrl).toBe('https://push.hapi.run/v1/push')
        expect(capturedInit?.method).toBe('POST')
        expect((capturedInit?.headers as Record<string, string>)['content-type']).toBe('application/json')
        expect(JSON.parse(String(capturedInit?.body))).toEqual({
            platform: 'ios',
            token: 'a1b2c3',
            envelope: 'RU5DUllQVEVE',
            collapseId: 'ready-sess-1',
            priority: 10
        })
    })

    it('omits collapseId/priority from the body when not provided', async () => {
        let capturedBody = ''
        globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
            capturedBody = String(init?.body)
            return new Response('{"ok":true}', { status: 200 })
        }) as unknown as typeof fetch

        await new RelayClient('https://push.hapi.run').send({ token: 't', envelope: 'e' })
        expect(JSON.parse(capturedBody)).toEqual({ platform: 'ios', token: 't', envelope: 'e' })
    })

    it('normalizes a trailing slash on the relay URL', async () => {
        let capturedUrl = ''
        globalThis.fetch = mock(async (url: unknown) => {
            capturedUrl = String(url)
            return new Response('{"ok":true}', { status: 200 })
        }) as unknown as typeof fetch

        await new RelayClient('https://relay.example.com/').send({ token: 't', envelope: 'e' })
        expect(capturedUrl).toBe('https://relay.example.com/v1/push')
    })

    it('maps 410 unregistered to invalid (prune signal)', async () => {
        globalThis.fetch = mock(async () =>
            new Response('{"ok":false,"code":"unregistered"}', { status: 410 })
        ) as unknown as typeof fetch
        expect(await new RelayClient('https://r').send({ token: 't', envelope: 'e' })).toBe('invalid')
    })

    it('maps 413 payload-too-large to failed (transient, no prune)', async () => {
        globalThis.fetch = mock(async () =>
            new Response('{"ok":false,"code":"payload_too_large"}', { status: 413 })
        ) as unknown as typeof fetch
        expect(await new RelayClient('https://r').send({ token: 't', envelope: 'e' })).toBe('failed')
    })

    it('maps 429 rate-limit to failed (transient, no prune)', async () => {
        globalThis.fetch = mock(async () =>
            new Response('{"ok":false,"code":"rate_limited"}', { status: 429 })
        ) as unknown as typeof fetch
        expect(await new RelayClient('https://r').send({ token: 't', envelope: 'e' })).toBe('failed')
    })

    it('maps 5xx to failed', async () => {
        globalThis.fetch = mock(async () => new Response('oops', { status: 502 })) as unknown as typeof fetch
        expect(await new RelayClient('https://r').send({ token: 't', envelope: 'e' })).toBe('failed')
    })

    it('maps a network throw to failed', async () => {
        globalThis.fetch = mock(async () => {
            throw new Error('ECONNREFUSED')
        }) as unknown as typeof fetch
        expect(await new RelayClient('https://r').send({ token: 't', envelope: 'e' })).toBe('failed')
    })

    it('sets an abort timeout on the request', async () => {
        let signal: AbortSignal | null | undefined
        globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
            signal = init?.signal as AbortSignal | null | undefined
            return new Response('{"ok":true}', { status: 200 })
        }) as unknown as typeof fetch

        await new RelayClient('https://r').send({ token: 't', envelope: 'e' })
        expect(signal).toBeDefined()
        expect(signal).not.toBeNull()
    })
})

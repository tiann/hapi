import { describe, expect, it } from 'bun:test'
import { BarkDelivery, normalizeBarkServerUrl } from './barkDelivery'
import type { BarkFetch } from './barkDelivery'

describe('normalizeBarkServerUrl', () => {
    it('removes trailing slashes', () => {
        expect(normalizeBarkServerUrl('https://api.day.app///')).toBe('https://api.day.app')
    })
})

describe('BarkDelivery', () => {
    it('posts payload to {base}/push with injected device key', async () => {
        const calls: Array<{ url: string; body: string }> = []
        const fetchImpl: BarkFetch = async (input, init) => {
            calls.push({
                url: String(input),
                body: String(init?.body ?? '')
            })
            return new Response('', { status: 200 })
        }

        const delivery = new BarkDelivery({
            baseUrl: 'https://api.day.app/',
            deviceKey: 'device-key',
            fetchImpl
        })

        await delivery.send({
            title: 'Ready for input',
            body: 'Codex is waiting in demo',
            group: 'ready-session-1',
            url: 'https://example.com/sessions/session-1'
        })

        expect(calls).toHaveLength(1)
        expect(calls[0]?.url).toBe('https://api.day.app/push')
        expect(JSON.parse(calls[0]?.body ?? '')).toEqual({
            title: 'Ready for input',
            body: 'Codex is waiting in demo',
            device_key: 'device-key',
            group: 'ready-session-1',
            url: 'https://example.com/sessions/session-1'
        })
    })

    it('retries once on transient 5xx failure', async () => {
        let calls = 0
        const fetchImpl: BarkFetch = async () => {
            calls += 1
            if (calls === 1) {
                return new Response('', { status: 500 })
            }
            return new Response('', { status: 200 })
        }

        const delivery = new BarkDelivery({
            baseUrl: 'https://api.day.app',
            deviceKey: 'device-key',
            fetchImpl
        })

        await delivery.send({
            title: 'Permission Request',
            body: 'demo (Edit)',
            group: 'permission-session-1',
            url: 'https://example.com/sessions/session-1'
        })

        expect(calls).toBe(2)
    })

    it('does not retry on 4xx failure', async () => {
        let calls = 0
        const fetchImpl: BarkFetch = async () => {
            calls += 1
            return new Response('', { status: 400 })
        }

        const delivery = new BarkDelivery({
            baseUrl: 'https://api.day.app',
            deviceKey: 'device-key',
            fetchImpl
        })

        await expect(
            delivery.send({
                title: 'Permission Request',
                body: 'demo',
                group: 'permission-session-1',
                url: 'https://example.com/sessions/session-1'
            })
        ).rejects.toThrow()

        expect(calls).toBe(1)
    })

    it('retries once on network error', async () => {
        let calls = 0
        const fetchImpl: BarkFetch = async () => {
            calls += 1
            if (calls === 1) {
                throw new TypeError('network failed')
            }
            return new Response('', { status: 200 })
        }

        const delivery = new BarkDelivery({
            baseUrl: 'https://api.day.app',
            deviceKey: 'device-key',
            fetchImpl
        })

        await delivery.send({
            title: 'Ready for input',
            body: 'Agent is waiting in demo',
            group: 'ready-session-1',
            url: 'https://example.com/sessions/session-1'
        })

        expect(calls).toBe(2)
    })
})

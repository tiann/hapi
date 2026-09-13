import { describe, expect, test } from 'bun:test'
import { createRelayApp, hashedTokenPrefix } from './index'
import { TokenBucketLimiter } from './rateLimit'

const envelope = 'QUJDRA=='
function harness() {
    let now = 0
    const tokens: string[] = []
    const logs: string[] = []
    const app = createRelayApp({ version: 'test',
        apns: { async push() { return { kind: 'delivered' } }, async close() {} },
        fcm: { async push(request) { tokens.push(request.token); return { kind: 'delivered' } }, },
        tokenLimiter: new TokenBucketLimiter({ capacity: 1, refillPerMinute: 1, now: () => now }),
        ipLimiter: new TokenBucketLimiter({ capacity: 20, refillPerMinute: 20, now: () => now }),
        log: line => logs.push(line)
    })
    return { tokens, logs, advance() { now += 60_000 },
        push(body: unknown) { return app.handle(new Request('http://relay/v1/push', { method: 'POST', body: JSON.stringify(body) }), 'ip') }
    }
}

describe('Android relay validation and limits', () => {
    test.each([['empty', ''], ['oversized', 'a'.repeat(4097)], ['space', 'token with spaces'], ['newline', 'token\n'], ['number', 5], ['null', null]])('rejects %s token', async (_name, token) => {
        const h = harness()
        expect((await h.push({ platform: 'android', token, envelope })).status).toBe(400)
        expect(h.tokens).toHaveLength(0)
    })

    test('accepts opaque case-sensitive tokens and separates token buckets by platform', async () => {
        const h = harness()
        const token = 'AB'.repeat(32)
        expect((await h.push({ platform: 'android', token, envelope })).status).toBe(200)
        expect((await h.push({ platform: 'android', token, envelope })).status).toBe(429)
        expect((await h.push({ platform: 'android', token: token.toLowerCase(), envelope })).status).toBe(200)
        expect((await h.push({ platform: 'ios', token, envelope })).status).toBe(200)
        h.advance()
        expect((await h.push({ platform: 'android', token, envelope })).status).toBe(200)
        expect(h.tokens).toEqual([token, token.toLowerCase(), token])
        expect(hashedTokenPrefix(token, 'ios')).toBe(hashedTokenPrefix(token.toLowerCase(), 'ios'))
        expect(hashedTokenPrefix(token, 'android')).not.toBe(hashedTokenPrefix(token.toLowerCase(), 'android'))
        expect(hashedTokenPrefix(token, 'android')).not.toBe(hashedTokenPrefix(token, 'ios'))
    })

    test('enforces the shared IP budget across different device tokens', async () => {
        const h = harness()
        for (let i = 0; i < 20; i++) {
            expect((await h.push({ platform: 'android', token: `opaque:${i}`, envelope })).status).toBe(200)
        }
        expect((await h.push({ platform: 'android', token: 'another-token', envelope })).status).toBe(429)
        expect(h.tokens).toHaveLength(20)
    })
})

import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { jwtVerify } from 'jose'
import type { Store, StoredUser } from '../../store'
import { createAccessTokenBindingFingerprint } from '../../utils/accessToken'
import { createBindRoutes } from './bind'

const jwtSecret = new TextEncoder().encode('namespace-bind-test-secret-32-bytes')

function storedUser(namespace: string, credentialFingerprint: string): StoredUser {
    return {
        id: 1,
        platform: 'telegram',
        platformUserId: '424242',
        namespace,
        credentialFingerprint,
        createdAt: 1,
    }
}

describe('Telegram credential-bound namespace binding', () => {
    it('persists a keyed fingerprint and refreshes a same-namespace binding', async () => {
        const calls: unknown[][] = []
        const store = {
            users: {
                getUser: () => storedUser('alice', 'stale-fingerprint'),
                addUser: (...args: unknown[]) => {
                    calls.push(args)
                    return storedUser('alice', String(args[3]))
                },
            },
        } as unknown as Store
        const app = new Hono()
        app.route('/api', createBindRoutes(jwtSecret, store, {
            resolveAccessTokenNamespace: (token) => token === 'alice-independent-token' ? 'alice' : null,
            getOwnerId: async () => 42,
            telegramBotToken: '123456:test-bot-token',
            validateTelegramInitData: () => ({
                ok: true,
                user: { id: 424242, first_name: 'Telegram User' },
                authDate: 1,
                raw: {},
            }),
        }))

        const response = await app.request('/api/bind', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                initData: 'validated-by-test-double',
                accessToken: 'alice-independent-token',
            }),
        })

        const expectedFingerprint = createAccessTokenBindingFingerprint('alice-independent-token', jwtSecret)
        expect(response.status).toBe(200)
        expect(calls).toEqual([['telegram', '424242', 'alice', expectedFingerprint]])
        expect(expectedFingerprint).toMatch(/^[0-9a-f]{64}$/)
        expect(expectedFingerprint).not.toContain('alice-independent-token')
        const body = await response.json() as { token: string }
        const verified = await jwtVerify(body.token, jwtSecret, { algorithms: ['HS256'] })
        expect(verified.payload.ns).toBe('alice')
    })

    it('does not replace an existing binding in another namespace', async () => {
        let addCalls = 0
        const store = {
            users: {
                getUser: () => storedUser('bob', 'bob-fingerprint'),
                addUser: () => {
                    addCalls += 1
                    return storedUser('alice', 'unexpected')
                },
            },
        } as unknown as Store
        const app = new Hono()
        app.route('/api', createBindRoutes(jwtSecret, store, {
            resolveAccessTokenNamespace: () => 'alice',
            getOwnerId: async () => 42,
            telegramBotToken: '123456:test-bot-token',
            validateTelegramInitData: () => ({
                ok: true,
                user: { id: 424242 },
                authDate: 1,
                raw: {},
            }),
        }))

        const response = await app.request('/api/bind', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ initData: 'validated', accessToken: 'alice-independent-token' }),
        })

        expect(response.status).toBe(409)
        expect(addCalls).toBe(0)
    })
})

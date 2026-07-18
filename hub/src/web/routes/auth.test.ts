import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { jwtVerify } from 'jose'
import type { Store, StoredUser } from '../../store'
import {
    resolveAccessTokenNamespace,
    type AccessTokenBindingValidator,
} from '../../utils/accessToken'
import { createAuthRoutes } from './auth'

const jwtSecret = new TextEncoder().encode('namespace-auth-test-secret-32-bytes')
const credentials = {
    defaultToken: 'default-token-credential',
    namespaceTokens: {
        alice: 'alice-token-credential',
        bob: 'bob-token-credential',
    },
}

function createApp(): Hono {
    const app = new Hono()
    app.route('/api', createAuthRoutes(jwtSecret, {} as Store, {
        resolveAccessTokenNamespace: (token) => resolveAccessTokenNamespace(token, credentials),
        getOwnerId: async () => 42,
    }))
    return app
}

function createTelegramApp(
    storedUser: StoredUser | null,
    isTelegramBindingCurrent: AccessTokenBindingValidator,
): Hono {
    const store = {
        users: {
            getUser: () => storedUser,
        },
    } as unknown as Store
    const app = new Hono()
    app.route('/api', createAuthRoutes(jwtSecret, store, {
        getOwnerId: async () => 42,
        telegramBotToken: '123456:test-bot-token',
        validateTelegramInitData: () => ({
            ok: true,
            user: { id: 424242, first_name: 'Telegram User' },
            authDate: 1,
            raw: {},
        }),
        isTelegramBindingCurrent,
    }))
    return app
}

async function authenticate(app: Hono, accessToken: string): Promise<Response> {
    return await app.request('/api/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accessToken }),
    })
}

describe('access-token auth namespace boundary', () => {
    it('issues Alice a JWT for Alice and never for Bob', async () => {
        const response = await authenticate(createApp(), 'alice-token-credential')

        expect(response.status).toBe(200)
        const body = await response.json() as { token: string }
        const verified = await jwtVerify(body.token, jwtSecret, { algorithms: ['HS256'] })
        expect(verified.payload.ns).toBe('alice')
        expect(verified.payload.ns).not.toBe('bob')
    })

    it('rejects attempts to append Bob as a caller-selected suffix', async () => {
        const response = await authenticate(createApp(), 'alice-token-credential:bob')

        expect(response.status).toBe(401)
    })

    it('issues Bob a Bob JWT only when Bob presents Bob own credential', async () => {
        const response = await authenticate(createApp(), 'bob-token-credential')

        expect(response.status).toBe(200)
        const body = await response.json() as { token: string }
        const verified = await jwtVerify(body.token, jwtSecret, { algorithms: ['HS256'] })
        expect(verified.payload.ns).toBe('bob')
    })
})

describe('Telegram binding authorization', () => {
    const storedUser = {
        id: 1,
        platform: 'telegram',
        platformUserId: '424242',
        namespace: 'alice',
        credentialFingerprint: 'stored-fingerprint',
        createdAt: 1,
    } satisfies StoredUser

    it('rejects a migrated or rotated binding before issuing a fresh JWT', async () => {
        const response = await createTelegramApp(storedUser, () => false).request('/api/auth', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ initData: 'validated-by-test-double' }),
        })

        expect(response.status).toBe(401)
        expect(await response.json()).toEqual({ error: 'not_bound' })
    })

    it('issues a namespace JWT only for a currently credential-bound Telegram user', async () => {
        const response = await createTelegramApp(storedUser, () => true).request('/api/auth', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ initData: 'validated-by-test-double' }),
        })

        expect(response.status).toBe(200)
        const body = await response.json() as { token: string }
        const verified = await jwtVerify(body.token, jwtSecret, { algorithms: ['HS256'] })
        expect(verified.payload.ns).toBe('alice')
    })
})

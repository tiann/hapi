import { beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import { createConfiguration, getConfiguration } from '../../configuration'
import { createAuthMiddleware, type WebAppEnv } from '../middleware/auth'
import { Store } from '../../store'
import { signWebJwt } from '../authTokens'
import { createAuthRoutes } from './auth'
import {
    createPasskeyLoginRoutes,
    createPasskeyManagementRoutes,
    PasskeyChallengeStore,
    resolveRelyingParty
} from './passkey'

const JWT_SECRET = new Uint8Array(randomBytes(32))
const ORIGIN = 'https://hub.example.com'
const HOST = 'hub.example.com'

const b64url = (bytes: Uint8Array | Buffer) => Buffer.from(bytes).toString('base64url')
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest()

/** Minimal software authenticator: ES256, `none` attestation, UP+UV set. */
class SoftAuthenticator {
    readonly credentialId = randomBytes(16)
    private readonly privateKey: KeyObject
    private readonly publicJwk: { x: string; y: string }
    private counter = 0
    userHandle: string | null = null

    constructor(private readonly rpId: string, private readonly origin: string) {
        const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
        this.privateKey = privateKey
        this.publicJwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
    }

    private clientData(type: string, challenge: string): Buffer {
        return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }))
    }

    create(options: { challenge: string; user: { id: string } }) {
        this.userHandle = options.user.id
        const cose = new Map<number, number | Uint8Array>([
            [1, 2], [3, -7], [-1, 1],
            [-2, new Uint8Array(Buffer.from(this.publicJwk.x, 'base64url'))],
            [-3, new Uint8Array(Buffer.from(this.publicJwk.y, 'base64url'))]
        ])
        const idLength = Buffer.alloc(2)
        idLength.writeUInt16BE(this.credentialId.length)
        const authData = Buffer.concat([
            sha256(this.rpId), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16),
            idLength, this.credentialId, Buffer.from(isoCBOR.encode(cose))
        ])
        const attestationObject = isoCBOR.encode(new Map<string, unknown>([
            ['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(authData)]
        ]) as never)
        return {
            id: b64url(this.credentialId),
            rawId: b64url(this.credentialId),
            type: 'public-key',
            response: {
                clientDataJSON: b64url(this.clientData('webauthn.create', options.challenge)),
                attestationObject: b64url(attestationObject),
                transports: ['internal']
            },
            clientExtensionResults: {}
        }
    }

    get(options: { challenge: string }) {
        this.counter += 1
        const counter = Buffer.alloc(4)
        counter.writeUInt32BE(this.counter)
        const authData = Buffer.concat([sha256(this.rpId), Buffer.from([0x05]), counter])
        const clientData = this.clientData('webauthn.get', options.challenge)
        const signature = sign('sha256', Buffer.concat([authData, sha256(clientData)]), this.privateKey)
        return {
            id: b64url(this.credentialId),
            rawId: b64url(this.credentialId),
            type: 'public-key',
            response: {
                clientDataJSON: b64url(clientData),
                authenticatorData: b64url(authData),
                signature: b64url(signature),
                userHandle: this.userHandle ?? undefined
            },
            clientExtensionResults: {}
        }
    }
}

function createApp(store: Store) {
    const app = new Hono<WebAppEnv>()
    const deps = { jwtSecret: JWT_SECRET, store, corsOrigins: () => [], challenges: new PasskeyChallengeStore() }
    app.route('/api', createAuthRoutes(JWT_SECRET, store))
    app.route('/api', createPasskeyLoginRoutes(deps))
    app.use('/api/*', createAuthMiddleware(JWT_SECRET))
    app.route('/api', createPasskeyManagementRoutes(deps))
    return app
}

function post(app: Hono<WebAppEnv>, path: string, body: unknown, extra: Record<string, string> = {}) {
    return app.request(path, {
        method: 'POST',
        headers: { origin: ORIGIN, host: HOST, 'content-type': 'application/json', ...extra },
        body: JSON.stringify(body)
    })
}

async function bearer(namespace = 'default') {
    return { authorization: `Bearer ${await signWebJwt(JWT_SECRET, 1, namespace)}` }
}

async function register(app: Hono<WebAppEnv>, authenticator: SoftAuthenticator, namespace = 'default') {
    const auth = await bearer(namespace)
    const options = await (await post(app, '/api/passkey/register/options', {}, auth)).json() as { challenge: string; user: { id: string } }
    const res = await post(app, '/api/passkey/register/verify', { response: authenticator.create(options), name: 'Laptop' }, auth)
    expect(res.status).toBe(200)
}

async function login(app: Hono<WebAppEnv>, authenticator: SoftAuthenticator) {
    const options = await (await post(app, '/api/passkey/login/options', {})).json() as { challenge: string }
    const assertion = authenticator.get(options)
    return { res: await post(app, '/api/passkey/login/verify', { response: assertion }), assertion }
}

beforeAll(async () => {
    process.env.HAPI_HOME ??= mkdtempSync(join(tmpdir(), 'hapi-passkey-test-'))
    await createConfiguration()
})

beforeEach(() => {
    getConfiguration()._setCliApiToken('token-one', 'env', false)
})

describe('passkey routes', () => {
    it('registers, logs in, refreshes via passkey session, and rejects replay', async () => {
        const store = new Store(':memory:')
        const app = createApp(store)
        const authenticator = new SoftAuthenticator(HOST, ORIGIN)
        await register(app, authenticator, 'team')

        const { res, assertion } = await login(app, authenticator)
        expect(res.status).toBe(200)
        const body = await res.json() as { token: string; passkeySession: string }
        const list = await app.request('/api/passkeys', { headers: { authorization: `Bearer ${body.token}` } })
        const listed = await list.json() as { passkeys: Array<{ name: string; valid: boolean; lastUsedAt: number | null }> }
        expect(listed.passkeys).toHaveLength(1)
        expect(listed.passkeys[0]).toMatchObject({ name: 'Laptop', valid: true })
        expect(listed.passkeys[0]?.lastUsedAt).not.toBeNull()

        // The same signed assertion cannot be used twice.
        expect((await post(app, '/api/passkey/login/verify', { response: assertion })).status).toBe(401)

        // The long-lived session is exchangeable, but never usable as a bearer token.
        const refreshed = await post(app, '/api/auth', { passkeySession: body.passkeySession })
        expect(refreshed.status).toBe(200)
        expect((await app.request('/api/passkeys', {
            headers: { authorization: `Bearer ${body.passkeySession}` }
        })).status).toBe(401)
        store.close()
    })

    it('scopes the issued JWT to the registering namespace', async () => {
        const store = new Store(':memory:')
        const app = createApp(store)
        const authenticator = new SoftAuthenticator(HOST, ORIGIN)
        await register(app, authenticator, 'team')
        const { res } = await login(app, authenticator)
        const { token } = await res.json() as { token: string }
        const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as { ns: string }
        expect(payload.ns).toBe('team')

        const other = await (await app.request('/api/passkeys', { headers: await bearer('default') })).json() as { passkeys: unknown[] }
        expect(other.passkeys).toHaveLength(0)
        const id = b64url(authenticator.credentialId)
        expect((await app.request(`/api/passkeys/${id}`, { method: 'DELETE', headers: await bearer('default') })).status).toBe(404)
        expect((await app.request(`/api/passkeys/${id}`, { method: 'DELETE', headers: await bearer('team') })).status).toBe(200)
        expect((await login(app, authenticator)).res.status).toBe(401)
        store.close()
    })

    it('revokes passkeys and passkey sessions when the CLI token rotates', async () => {
        const store = new Store(':memory:')
        const app = createApp(store)
        const authenticator = new SoftAuthenticator(HOST, ORIGIN)
        await register(app, authenticator)
        const { passkeySession } = await (await login(app, authenticator)).res.json() as { passkeySession: string }

        getConfiguration()._setCliApiToken('token-two', 'env', false)
        const { res } = await login(app, authenticator)
        expect(res.status).toBe(401)
        expect(await res.json()).toEqual({ error: 'passkey_revoked' })
        expect((await post(app, '/api/auth', { passkeySession })).status).toBe(401)
        const listed = await (await app.request('/api/passkeys', { headers: await bearer() })).json() as { passkeys: Array<{ valid: boolean }> }
        expect(listed.passkeys[0]?.valid).toBe(false)
        store.close()
    })

    it('rejects untrusted origins and registration without a JWT', async () => {
        const store = new Store(':memory:')
        const app = createApp(store)
        expect((await post(app, '/api/passkey/login/options', {}, { origin: 'https://evil.example' })).status).toBe(400)
        expect((await post(app, '/api/passkey/register/options', {})).status).toBe(401)

        // An assertion produced for another origin fails even with a valid challenge.
        const authenticator = new SoftAuthenticator(HOST, ORIGIN)
        await register(app, authenticator)
        const phished = new SoftAuthenticator(HOST, 'https://evil.example')
        Object.assign(phished, { credentialId: authenticator.credentialId })
        expect((await login(app, phished)).res.status).toBe(401)
        store.close()
    })
})

describe('resolveRelyingParty', () => {
    it('requires a trusted, secure, domain-name origin', () => {
        expect(resolveRelyingParty('https://hub.example.com', 'hub.example.com', [])).toEqual({ origin: 'https://hub.example.com', rpId: 'hub.example.com' })
        expect(resolveRelyingParty('http://localhost:3006', 'localhost:3006', [])).toEqual({ origin: 'http://localhost:3006', rpId: 'localhost' })
        expect(resolveRelyingParty('https://app.hapi.run', 'abc.relay.hapi.run', ['https://app.hapi.run'])).toEqual({ origin: 'https://app.hapi.run', rpId: 'app.hapi.run' })
        expect(resolveRelyingParty('https://app.hapi.run', 'abc.relay.hapi.run', ['*'])).toHaveProperty('error')
        expect(resolveRelyingParty('http://hub.example.com', 'hub.example.com', [])).toHaveProperty('error')
        expect(resolveRelyingParty('http://192.168.1.2:3006', '192.168.1.2:3006', [])).toHaveProperty('error')
        expect(resolveRelyingParty(undefined, 'hub.example.com', [])).toHaveProperty('error')
    })
})

describe('PasskeyChallengeStore', () => {
    it('is one-time, expires, and evicts the oldest entry instead of refusing new ones', () => {
        let now = 0
        const store = new PasskeyChallengeStore(() => now)
        const entry = (expiresAt: number) => ({ kind: 'login' as const, rpId: 'r', origin: 'o', expiresAt })
        store.put('a', entry(100))
        expect(store.take('a')).not.toBeNull()
        expect(store.take('a')).toBeNull()

        store.put('b', entry(100))
        now = 100
        expect(store.take('b')).toBeNull()

        for (let i = 0; i < 300; i++) store.put(`c${i}`, entry(1000))
        expect(store.take('c0')).toBeNull()
        expect(store.take('c299')).not.toBeNull()
    })
})

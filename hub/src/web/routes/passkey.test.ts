import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PASSKEY_ORIGIN, PASSKEY_RP_ID, passkeyUserHandleHub, passkeyDiscoveryOptions, validatePasskeyUserHandle } from '@hapi/protocol/passkey'
import { Hono } from 'hono'
import { SoftAuthenticator } from '../testHelpers/passkeyAuthenticator'
import { createConfiguration, getConfiguration } from '../../configuration'
import { createAuthMiddleware, type WebAppEnv } from '../middleware/auth'
import { Store } from '../../store'
import { signWebJwt } from '../authTokens'
import { createAuthRoutes } from './auth'
import {
    createPasskeyLoginRoutes,
    createPasskeyManagementRoutes,
    nativePasskeyConfigFromEnv,
    PasskeyChallengeStore,
    OFFICIAL_ANDROID_PASSKEY_ORIGINS
} from './passkey'

const stores: Store[] = []
function newStore() { const store = new Store(':memory:'); stores.push(store); return store }
afterEach(() => { for (const store of stores.splice(0)) store.close() })

const JWT_SECRET = new Uint8Array(randomBytes(32))
const ORIGIN = 'https://hub.example.com'
const HOST = 'hub.example.com'
const ANDROID_ORIGIN = 'android:apk-key-hash:test-hash'

const b64url = (bytes: Uint8Array | Buffer) => Buffer.from(bytes).toString('base64url')
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest()

type Options = { challenge: string; rp: { id: string }; user: { id: string; name: string }; allowCredentials: Array<{ id: string }> }
type Session = { token: string; passkeySession: string; operation: string }
type Listed = { passkeys: Array<{ valid: boolean }> }

function createApp(store: Store, config: { now?: () => number; cors?: string[]; hub?: string } = {}) {
    const app = new Hono<WebAppEnv>()
    const deps = {
        jwtSecret: JWT_SECRET, store,
        hubUrl: () => config.hub ?? ORIGIN,
        corsOrigins: () => config.cors ?? [],
        challenges: new PasskeyChallengeStore(config.now),
        native: { rpId: PASSKEY_RP_ID, origins: [PASSKEY_ORIGIN, ANDROID_ORIGIN] }
    }
    app.route('/api', createAuthRoutes(JWT_SECRET, store))
    app.route('/api', createPasskeyLoginRoutes(deps))
    app.use('/api/*', createAuthMiddleware(JWT_SECRET))
    app.route('/api', createPasskeyManagementRoutes(deps))
    return { app, deps }
}

function post(app: Hono<WebAppEnv>, path: string, body: unknown, extra: Record<string, string> = {}) {
    return app.request(path, {
        method: 'POST', headers: { origin: ORIGIN, host: HOST, 'content-type': 'application/json', ...extra },
        body: JSON.stringify(body)
    })
}
async function bearer(namespace = 'default') {
    return { authorization: `Bearer ${await signWebJwt(JWT_SECRET, 1, namespace)}` }
}
async function nativeOptions(app: Hono<WebAppEnv>, kind: 'register' | 'login', namespace = 'default') {
    return post(app, `/api/passkey/${kind}/options`, { client: 'native' }, kind === 'register' ? await bearer(namespace) : {})
}
async function registerNative(app: Hono<WebAppEnv>, authenticator: SoftAuthenticator, namespace = 'default') {
    const res = await nativeOptions(app, 'register', namespace)
    expect(res.status).toBe(200)
    const options = await res.json() as Options
    expect(options.rp.id).toBe(PASSKEY_RP_ID)
    expect(passkeyUserHandleHub(Buffer.from(options.user.id, 'base64url'))).toBe(ORIGIN)
    expect(options.user.name).toBe(`${namespace === 'default' ? 'hapi' : `hapi:${namespace}`}@${HOST}`)
    const verify = await post(app, '/api/passkey/register/verify', { response: authenticator.create(options), name: 'Laptop' }, await bearer(namespace))
    expect([verify.status, await verify.clone().text()]).toEqual([200, expect.any(String)])
    return options
}
async function nativeLogin(app: Hono<WebAppEnv>, authenticator: SoftAuthenticator) {
    const options = await (await nativeOptions(app, 'login')).json() as Options
    const assertion = authenticator.get(options)
    const res = await post(app, '/api/passkey/login/verify', { response: assertion })
    return { res, assertion }
}
const verifier = randomBytes(32).toString('base64url')
const startBody = () => ({ state: randomBytes(32).toString('base64url'), codeChallenge: b64url(sha256(verifier)), callbackOrigin: ORIGIN })
async function browserStart(app: Hono<WebAppEnv>, operation: 'register' | 'login', namespace = 'default') {
    const input = startBody()
    const res = await post(app, `/api/passkey/browser/${operation}/start`, { ...input, name: 'Browser' }, operation === 'register' ? await bearer(namespace) : {})
    expect(res.status).toBe(200)
    const body = await res.json() as { url: string }
    const url = new URL(body.url)
    expect(url.origin).toBe(PASSKEY_ORIGIN)
    return { request: JSON.parse(decodeURIComponent(url.hash.slice(1))) as { options: Options }, input }
}
async function complete(app: Hono<WebAppEnv>, challenge: string, response?: unknown, origin = PASSKEY_ORIGIN) {
    return app.request('/api/passkey/browser/complete', {
        method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ challenge, ...(response ? { response: JSON.stringify(response) } : { error: 'cancelled' }) })
    })
}
async function exchange(app: Hono<WebAppEnv>, redirect: Response, proof = verifier) {
    expect(redirect.status).toBe(303)
    const target = new URL(redirect.headers.get('location')!)
    expect(target.origin).toBe(ORIGIN)
    expect(target.pathname).toBe('/passkey/callback')
    return post(app, '/api/passkey/browser/exchange', { code: new URLSearchParams(target.hash.slice(1)).get('code'), verifier: proof })
}

beforeAll(async () => {
    process.env.HAPI_HOME ??= mkdtempSync(join(tmpdir(), 'hapi-passkey-test-'))
    await createConfiguration()
})
beforeEach(() => { getConfiguration()._setCliApiToken('token-one', 'env', false) })

describe('unified passkeys', () => {
    it('encodes stable, namespace-isolated Hub locators and hash-binds long addresses', async () => {
        const { app } = createApp(newStore())
        const first = await (await nativeOptions(app, 'register')).json() as Options
        const repeat = await (await nativeOptions(app, 'register')).json() as Options
        const team = await (await nativeOptions(app, 'register', 'team')).json() as Options
        expect(first.user.id).toBe(repeat.user.id)
        expect(team.user.id).not.toBe(first.user.id)
        for (const options of [first, team]) {
            expect(passkeyUserHandleHub(Buffer.from(options.user.id, 'base64url'))).toBe(ORIGIN)
            await validatePasskeyUserHandle(options.user.id, ORIGIN)
        }
        const long = `https://${'a'.repeat(43)}.com`
        const other = createApp(newStore(), { hub: long }).app
        const opaque = await (await nativeOptions(other, 'register')).json() as Options
        expect(Buffer.from(opaque.user.id, 'base64url')).toHaveLength(50)
        expect(passkeyUserHandleHub(Buffer.from(opaque.user.id, 'base64url'))).toBeNull()
        await validatePasskeyUserHandle(opaque.user.id, long)
        await expect(validatePasskeyUserHandle(opaque.user.id, ORIGIN)).rejects.toThrow()
    })
    it('never accepts a locator-only discovery assertion as authentication', async () => {
        const { app } = createApp(newStore())
        const a = new SoftAuthenticator(PASSKEY_RP_ID, PASSKEY_ORIGIN)
        await registerNative(app, a)
        const discovery = passkeyDiscoveryOptions('native')
        expect((await post(app, '/api/passkey/login/verify', { response: a.get(discovery) })).status).toBe(401)
        expect((await complete(app, discovery.challenge, a.get(discovery))).status).toBe(401)
        expect((await nativeLogin(app, a)).res.status).toBe(200)
    })
    it('logs into web with an App-created passkey; the bridge never gets tokens', async () => {
        const store = newStore()
        const { app } = createApp(store)
        const a = new SoftAuthenticator(PASSKEY_RP_ID, ANDROID_ORIGIN)
        await registerNative(app, a, 'team')
        a.origin = PASSKEY_ORIGIN
        const { request, input } = await browserStart(app, 'login')
        expect(request.options.allowCredentials.map((c: { id: string }) => c.id)).toEqual([b64url(a.credentialId)])
        const response = a.get(request.options)
        const redirect = await complete(app, request.options.challenge, response)
        expect(redirect.headers.get('cache-control')).toBe('no-store')
        expect(redirect.headers.get('location')).not.toContain('token=')
        const callback = new URLSearchParams(new URL(redirect.headers.get('location')!).hash.slice(1))
        expect(callback.get('state')).toBe(input.state)
        const result = await exchange(app, redirect)
        expect(result.status).toBe(200)
        const body = await result.json() as Session
        expect(body.operation).toBe('login')
        expect(body.passkeySession).toBeString()
        expect(JSON.parse(Buffer.from(body.token.split('.')[1], 'base64url').toString()).ns).toBe('team')
        expect((await post(app, '/api/auth', { passkeySession: body.passkeySession })).status).toBe(200)
        expect((await complete(app, request.options.challenge, response)).status).toBe(401)
        expect((await exchange(app, redirect)).status).toBe(401)
    })
    it('logs into the App with a web-created passkey', async () => {
        const store = newStore()
        const { app } = createApp(store)
        const a = new SoftAuthenticator(PASSKEY_RP_ID, PASSKEY_ORIGIN)
        const { request } = await browserStart(app, 'register', 'team')
        const redirect = await complete(app, request.options.challenge, a.create(request.options))
        expect(await (await exchange(app, redirect)).json()).toEqual({ operation: 'register' })
        a.origin = ANDROID_ORIGIN
        const { res, assertion } = await nativeLogin(app, a)
        expect(res.status).toBe(200)
        const body = await res.json() as Session
        const list = await app.request('/api/passkeys', { headers: { authorization: `Bearer ${body.token}` } })
        expect((await list.json() as Listed).passkeys).toMatchObject([{ rpId: PASSKEY_RP_ID, valid: true, name: 'Browser' }])
        expect((await post(app, '/api/passkey/login/verify', { response: assertion })).status).toBe(401)
        expect((await app.request('/api/passkeys', { headers: { authorization: `Bearer ${body.passkeySession}` } })).status).toBe(401)
    })
    it('enforces PKCE without consuming a code on an incorrect verifier', async () => {
        const store = newStore()
        const { app } = createApp(store)
        const a = new SoftAuthenticator(PASSKEY_RP_ID, PASSKEY_ORIGIN)
        await registerNative(app, a)
        const { request } = await browserStart(app, 'login')
        const redirect = await complete(app, request.options.challenge, a.get(request.options))
        expect((await exchange(app, redirect, randomBytes(32).toString('base64url'))).status).toBe(401)
        expect((await exchange(app, redirect)).status).toBe(200)
    })
    it('expires authorization codes', async () => {
        const store = newStore()
        let now = Date.now()
        const { app } = createApp(store, { now: () => now })
        const a = new SoftAuthenticator(PASSKEY_RP_ID, PASSKEY_ORIGIN)
        await registerNative(app, a)
        const { request } = await browserStart(app, 'login')
        const redirect = await complete(app, request.options.challenge, a.get(request.options))
        now += 61000
        expect((await exchange(app, redirect)).status).toBe(401)
    })
    it('requires an existing JWT to begin registration', async () => {
        const store = newStore()
        const { app } = createApp(store)
        expect((await post(app, '/api/passkey/browser/register/start', startBody())).status).toBe(401)
        expect((await post(app, '/api/passkey/register/options', { client: 'native' })).status).toBe(401)
    })
    it('rejects wildcard/untrusted callbacks and caller-selected redirect paths', async () => {
        const store = newStore()
        const { app } = createApp(store, { cors: ['*'] })
        for (const callbackOrigin of ['https://evil.example', `${ORIGIN}/evil`, `${ORIGIN}/`, 'javascript:alert(1)']) {
            const res = await post(app, '/api/passkey/browser/login/start', { ...startBody(), callbackOrigin }, { origin: callbackOrigin })
            expect(res.status).toBe(400)
        }
        expect((await post(app, '/api/passkey/browser/login/start', { ...startBody(), returnUrl: 'https://evil.example' })).status).toBe(400)
        expect((await post(app, '/api/passkey/browser/login/start', startBody(), { origin: 'https://evil.example' })).status).toBe(400)
    })
    it('allows an explicitly trusted separately hosted web app with a fixed callback', async () => {
        const store = newStore()
        const origin = 'https://app.hapi.run'
        const { app } = createApp(store, { cors: [origin] })
        const a = new SoftAuthenticator(PASSKEY_RP_ID, PASSKEY_ORIGIN)
        await registerNative(app, a)
        const start = await post(app, '/api/passkey/browser/login/start', { ...startBody(), callbackOrigin: origin }, { origin })
        expect(start.status).toBe(200)
        const request = JSON.parse(decodeURIComponent(new URL((await start.json() as { url: string }).url).hash.slice(1)))
        const result = await complete(app, request.options.challenge, a.get(request.options))
        expect(new URL(result.headers.get('location')!).origin).toBe(origin)
    })
    it('does not trust a proxy Host header as the Hub identity', async () => {
        const store = newStore()
        const { app } = createApp(store)
        const res = await post(app, '/api/passkey/register/options', { client: 'native' }, { ...await bearer(), host: '127.0.0.1:3006' })
        expect((await res.json() as Options).user.name).toBe(`hapi@${HOST}`)
        const invalid = createApp(store, { hub: 'http://localhost:3006' }).app
        expect((await nativeOptions(invalid, 'register')).status).toBe(400)
    })
    it('isolates namespaces, validates origins, and rejects cross-channel exchanges', async () => {
        const store = newStore()
        const { app } = createApp(store)
        const a = new SoftAuthenticator(PASSKEY_RP_ID, PASSKEY_ORIGIN)
        await registerNative(app, a, 'team')
        const id = b64url(a.credentialId)
        expect((await app.request(`/api/passkeys/${id}`, { method: 'DELETE', headers: await bearer() })).status).toBe(404)
        const { request } = await browserStart(app, 'login')
        expect((await complete(app, request.options.challenge, a.get(request.options), 'https://evil.example')).status).toBe(400)
        // Wrong origin did not consume the challenge.
        expect((await exchange(app, await complete(app, request.options.challenge, a.get(request.options)))).status).toBe(200)
        const native = await (await nativeOptions(app, 'login')).json() as Options
        expect((await complete(app, native.challenge, a.get(native))).status).toBe(401)
        const browser = await browserStart(app, 'login')
        expect((await post(app, '/api/passkey/login/verify', { response: a.get(browser.request.options) })).status).toBe(401)
        a.origin = 'https://evil.auth.hapi.run'
        expect((await nativeLogin(app, a)).res.status).toBe(401)
    })
    it('rejects wrong namespace and token rotation during registration', async () => {
        const store = newStore()
        const { app } = createApp(store)
        const a = new SoftAuthenticator(PASSKEY_RP_ID, PASSKEY_ORIGIN)
        const options = await (await nativeOptions(app, 'register', 'team')).json() as Options
        expect((await post(app, '/api/passkey/register/verify', { response: a.create(options) }, await bearer())).status).toBe(400)
        const { request } = await browserStart(app, 'register')
        getConfiguration()._setCliApiToken('token-two', 'env', false)
        const redirect = await complete(app, request.options.challenge, a.create(request.options))
        expect(redirect.headers.get('location')).toContain('error=passkey_revoked')
        expect(store.passkeys.listByNamespace('default')).toHaveLength(0)
    })
    it('revokes pending authorizations and refresh sessions on deletion/rotation', async () => {
        const store = newStore()
        const { app } = createApp(store)
        const a = new SoftAuthenticator(PASSKEY_RP_ID, PASSKEY_ORIGIN)
        await registerNative(app, a)
        const login = await (await nativeLogin(app, a)).res.json() as Session
        const { request } = await browserStart(app, 'login')
        const redirect = await complete(app, request.options.challenge, a.get(request.options))
        getConfiguration()._setCliApiToken('token-two', 'env', false)
        expect((await exchange(app, redirect)).status).toBe(401)
        expect((await post(app, '/api/auth', { passkeySession: login.passkeySession })).status).toBe(401)
        expect((await nativeOptions(app, 'login')).status).toBe(404)
        expect((await post(app, '/api/passkey/login/options', {})).status).toBe(400)
        const listed = await (await app.request('/api/passkeys', { headers: await bearer() })).json() as Listed
        expect(listed.passkeys[0].valid).toBe(false)
    })
    it('rejects deletion between authentication and code exchange', async () => {
        const store = newStore()
        const { app } = createApp(store)
        const a = new SoftAuthenticator(PASSKEY_RP_ID, PASSKEY_ORIGIN)
        await registerNative(app, a)
        const { request } = await browserStart(app, 'login')
        const redirect = await complete(app, request.options.challenge, a.get(request.options))
        store.passkeys.remove(b64url(a.credentialId), 'default')
        expect((await exchange(app, redirect)).status).toBe(401)
    })
    it('returns cancellation to the initiating window without an authorization code', async () => {
        const store = newStore()
        const { app } = createApp(store)
        const { request, input } = await browserStart(app, 'register')
        const redirect = await complete(app, request.options.challenge)
        const params = new URLSearchParams(new URL(redirect.headers.get('location')!).hash.slice(1))
        expect(params.get('state')).toBe(input.state)
        expect(params.get('error')).toBe('cancelled')
        expect(params.has('code')).toBe(false)
    })
    it('limits ceremony request bodies', async () => {
        const store = newStore()
        const { app } = createApp(store)
        expect((await post(app, '/api/passkey/login/options', { padding: 'x'.repeat(128 * 1024) })).status).toBe(413)
    })
})

describe('bounded one-time state', () => {
    it('expires and evicts the oldest pending ceremony', () => {
        let now = 0
        const state = new PasskeyChallengeStore(() => now)
        const entry = { kind: 'login' as const, channel: 'native' as const, hub: ORIGIN, fingerprint: 'f', rpId: PASSKEY_RP_ID, origins: [PASSKEY_ORIGIN], expiresAt: 100 }
        state.put('a', entry)
        expect(state.take('a')).not.toBeNull()
        expect(state.take('a')).toBeNull()
        state.put('b', entry)
        now = 100
        expect(state.take('b')).toBeNull()
        for (let i = 0; i < 300; i++) state.put(`c${i}`, { ...entry, expiresAt: 1000 })
        expect(state.take('c0')).toBeNull()
        expect(state.take('c299')).not.toBeNull()
    })
})

describe('native origins', () => {
    it('pins the shared RP and accepts only explicitly trusted Android extras', () => {
        expect(nativePasskeyConfigFromEnv({})).toEqual({ rpId: PASSKEY_RP_ID, origins: [PASSKEY_ORIGIN, ...OFFICIAL_ANDROID_PASSKEY_ORIGINS] })
        expect(nativePasskeyConfigFromEnv({ HAPI_PASSKEY_NATIVE_ORIGINS: 'android:apk-key-hash:debug' }).origins).toContain('android:apk-key-hash:debug')
        expect(() => nativePasskeyConfigFromEnv({ HAPI_PASSKEY_NATIVE_ORIGINS: 'https://evil.example' })).toThrow()
    })
})

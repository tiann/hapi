/** Real Chromium WebAuthn + production Hub/bridge, entirely intercepted locally.
 * No DNS, requests to production, signed app, or central account service needed. */
import { chromium, type Page, type CDPSession } from '@playwright/test'
import { createHash, createPrivateKey, randomBytes, sign } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { FOLLOW_SESSION_REDIRECTS_HEADER } from '@hapi/protocol'
import { PASSKEY_ORIGIN, PASSKEY_RP_ID, passkeyUserHandleHub } from '@hapi/protocol/passkey'
import { createConfiguration } from '../src/configuration'
import { Store } from '../src/store'
import { signWebJwt } from '../src/web/authTokens'
import { createAuthMiddleware, type WebAppEnv } from '../src/web/middleware/auth'
import { createPasskeyLoginRoutes, createPasskeyManagementRoutes, PasskeyChallengeStore } from '../src/web/routes/passkey'
import { SoftAuthenticator } from '../src/web/testHelpers/passkeyAuthenticator'

const hub = 'https://hub.test'
const webOrigin = 'https://app.test'
const androidOrigin = 'android:apk-key-hash:browser-integration-test'
const secret = randomBytes(32)
const home = await mkdtemp(join(tmpdir(), 'hapi-passkey-browser-'))
const previousHome = process.env.HAPI_HOME
process.env.HAPI_HOME = home
await createConfiguration()
const store = new Store(':memory:')
const deps = {
    jwtSecret: secret, store, hubUrl: () => hub, corsOrigins: () => [webOrigin],
    challenges: new PasskeyChallengeStore(), native: { rpId: PASSKEY_RP_ID, origins: [PASSKEY_ORIGIN, androidOrigin] }
}
const app = new Hono<WebAppEnv>()
app.use('/api/*', cors({ origin: [webOrigin], allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['authorization', 'content-type', FOLLOW_SESSION_REDIRECTS_HEADER] }))
app.route('/api', createPasskeyLoginRoutes(deps))
app.use('/api/*', createAuthMiddleware(secret))
app.route('/api', createPasskeyManagementRoutes(deps))
const token = await signWebJwt(secret, 1, 'team')
const bundle = await Bun.build({ entrypoints: [resolve(import.meta.dir, '../../web/scripts/passkey-e2e-entry.ts')], target: 'browser', minify: false })
if (!bundle.success) throw new AggregateError(bundle.logs)
const bundleJS = await bundle.outputs[0].text()
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
const requests: string[] = []
let cdp: CDPSession | undefined
try {
    browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL, args: ['--no-sandbox'] })
    const context = await browser.newContext()
    context.setDefaultTimeout(15000)
    context.on('page', (p) => {
        p.on('pageerror', (error) => console.error('Browser error:', error.message))
    })
    // Block everything except in-memory Hub requests and built local auth files.
    await context.route('**/*', async (route) => {
        const request = route.request()
        const url = new URL(request.url())
        if (url.origin === hub && url.pathname.startsWith('/api/')) {
            requests.push(`${request.method()} ${url.pathname} (${request.headers().origin ?? "no-origin"})`)
            const response = await app.request(request.url(), {
                method: request.method(), headers: request.headers(), body: request.postDataBuffer() ?? undefined
            })
            const location = response.headers.get('location')
            requests.push(`→ ${response.status}${location ? ` ${location}` : ''}`)
            // Playwright route.fulfill drops Location fragments on 3xx navigations, so the
            // passkey callback never sees #state/#code and the opener hangs. Apply the
            // fragment client-side the way a real document navigation would.
            if (response.status >= 300 && response.status < 400 && location?.includes('#')) {
                await route.fulfill({
                    status: 200,
                    contentType: 'text/html',
                    body: `<!doctype html><script>location.replace(${JSON.stringify(location)})</script>`
                })
            } else {
                await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) })
            }
        } else if (url.origin === webOrigin && url.pathname === '/fixture.js') {
            await route.fulfill({ contentType: 'text/javascript', body: bundleJS })
        } else if (url.origin === webOrigin && url.pathname === '/passkey/callback') {
            await route.fulfill({ contentType: 'text/html', body: `<script type="module">import { completePasskeyCallback } from '/callback.js'; completePasskeyCallback()</script>` })
        } else if (url.origin === webOrigin && url.pathname === '/callback.js') {
            // Exported production callback handler, without mounting the app/router.
            await route.fulfill({ contentType: 'text/javascript', body: callbackJS })
        } else if (url.origin === webOrigin && url.pathname === '/') {
            await route.fulfill({ contentType: 'text/html', body: `<body data-token="${token}" data-hub="${hub}"><button id="register">Register</button><button id="login">Login</button><p id="result"></p><script type="module" src="/fixture.js"></script></body>` })
        } else if (url.origin === PASSKEY_ORIGIN && ['/', '/main.js', '/style.css'].includes(url.pathname)) {
            const file = resolve(import.meta.dir, '../../website/dist/auth', url.pathname === '/' ? 'index.html' : url.pathname.slice(1))
            await route.fulfill({
                contentType: url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : 'text/html',
                headers: { 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; form-action https:; frame-ancestors 'none'; base-uri 'none'", 'referrer-policy': 'strict-origin' },
                body: await readFile(file)
            })
        } else { await route.abort() }
    })
    const callbackBuild = await Bun.build({ entrypoints: [resolve(import.meta.dir, '../../web/src/lib/passkey.ts')], target: 'browser' })
    if (!callbackBuild.success) throw new AggregateError(callbackBuild.logs)
    const callbackJS = await callbackBuild.outputs[0].text()
    const page = await context.newPage()
    await page.goto(webOrigin)

    type Credential = { credentialId: string; privateKey: string; userHandle?: string; signCount: number; rpId: string; isResidentCredential: boolean }
    async function virtualPopup(button: string, credential?: Credential): Promise<{ popup: Page; id: string }> {
        const popupEvent = page.waitForEvent('popup')
        await page.click(button)
        const popup = await popupEvent
        await popup.waitForURL(`${PASSKEY_ORIGIN}/**`)
        cdp = await context.newCDPSession(popup)
        await cdp.send('WebAuthn.enable')
        const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
            options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true }
        })
        if (credential) await cdp.send('WebAuthn.addCredential', { authenticatorId, credential })
        return { popup, id: authenticatorId }
    }
    const first = await virtualPopup('#register')
    const created = new Promise<Credential>((resolve) => cdp!.once('WebAuthn.credentialAdded', (event) => resolve(event.credential)))
    await first.popup.click('#continue')
    let timer: ReturnType<typeof setTimeout> | undefined
    const credential = await Promise.race([
        created,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Virtual authenticator did not create a credential')), 15000) })
    ]).finally(() => clearTimeout(timer))
    await page.waitForFunction(() => Boolean(document.querySelector('#result')?.textContent))
    if (await page.locator('#result').textContent() !== 'registered') throw new Error(await page.locator('#result').textContent() ?? 'Registration failed')
    if (!credential.userHandle || passkeyUserHandleHub(Buffer.from(credential.userHandle, 'base64')) !== hub) throw new Error('Browser-created passkey did not store its Hub')
    if (store.passkeys.listByNamespace('team').length !== 1) throw new Error('Browser registration did not reach Hub')

    // A synced browser-created key signs an Android-origin assertion to the real Hub.
    const optionsResponse = await app.request('/api/passkey/login/options', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"client":"native"}' })
    const options = await optionsResponse.json() as { challenge: string }
    const hash = (value: string | Buffer) => createHash('sha256').update(value).digest()
    const data = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: androidOrigin, crossOrigin: false }))
    const counter = Buffer.alloc(4); counter.writeUInt32BE(credential.signCount + 1)
    const authData = Buffer.concat([hash(PASSKEY_RP_ID), Buffer.from([0x05]), counter])
    const signature = sign('sha256', Buffer.concat([authData, hash(data)]), createPrivateKey({ key: Buffer.from(credential.privateKey, 'base64'), type: 'pkcs8', format: 'der' }))
    const id = Buffer.from(credential.credentialId, 'base64').toString('base64url')
    const native = await app.request('/api/passkey/login/verify', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ response: { id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: data.toString('base64url'), authenticatorData: authData.toString('base64url'), signature: signature.toString('base64url') } } })
    })
    if (native.status !== 200) throw new Error(`Browser → App failed: ${await native.text()}`)
    console.log('PASS: browser-created Passkey signs into native endpoint')

    // Register through native endpoints, then import the synced key into Chromium.
    const soft = new SoftAuthenticator(PASSKEY_RP_ID, androidOrigin)
    const registration = await app.request('/api/passkey/register/options', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{"client":"native"}'
    })
    const creation = await registration.json() as { challenge: string; user: { id: string } }
    const registered = await app.request('/api/passkey/register/verify', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ response: soft.create(creation) })
    })
    if (registered.status !== 200) throw new Error(await registered.text())
    const second = await virtualPopup('#login', soft.virtualCredential())
    const beforeDiscovery = requests.length
    await second.popup.click('#continue')
    await second.popup.getByRole('button', { name: 'Use this Hub' }).waitFor()
    if (requests.length !== beforeDiscovery) throw new Error('Discovery contacted a Hub before confirmation')
    if (await second.popup.locator('#hub').textContent() !== hub) throw new Error('Discovery recovered the wrong Hub')
    await second.popup.getByRole('button', { name: 'Use this Hub' }).click()
    await second.popup.getByRole('heading', { name: 'Sign in to HAPI', exact: true }).waitFor()
    await second.popup.click('#continue')
    await page.waitForFunction(() => document.querySelector('#result')?.textContent?.startsWith('session:'))
    console.log('PASS: native-created Passkey discovers its Hub without input, then signs into web with a fresh challenge, callback, and PKCE')
} catch (error) {
    console.error(requests.join("\n"))
    throw error
} finally {
    await browser?.close()
    store.close()
    if (previousHome === undefined) delete process.env.HAPI_HOME
    else process.env.HAPI_HOME = previousHome
    await rm(home, { recursive: true, force: true })
}

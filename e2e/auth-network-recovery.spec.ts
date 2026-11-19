import { expect, test } from '@playwright/test'
import { createServer, type Server, type ServerResponse } from 'node:http'

// Exercise the real App, auth hook, router, SSE and message cache. No agent or model calls.
let hub: Server
let origin: string
let mode: 'ok' | 'unavailable' | 'rejected' | 'telegram-disabled' | 'auth-unavailable' | 'auth-body-stall' = 'ok'
const streams = new Set<ServerResponse>()
const stalledAuth = new Set<ServerResponse>()
let authAttempts = 0
let closeGlobalOnce = false
const now = Date.now()
const sessions = ['A', 'B'].map(letter => ({
    id: 'network-chat-' + letter, namespace: 'fixture', seq: 1, createdAt: now, updatedAt: now,
    active: false, activeAt: now, thinking: false, thinkingAt: 0,
    hasConversationContent: true, contentRevision: 1,
    metadata: { name: 'Offline fixture ' + letter, path: '/fixture', host: 'fixture', flavor: 'claude' },
    metadataVersion: 1, agentState: null, agentStateVersion: 1,
    pendingRequests: [], pendingRequestKinds: [], pendingRequestsCount: 0, todoProgress: null,
}))
function disconnect() { for (const stream of streams) stream.end(); streams.clear() }

test.beforeAll(async () => {
    hub = createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*')
        res.setHeader('Access-Control-Allow-Credentials', 'true')
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] ?? '*')
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
        const path = new URL(req.url ?? '/', 'http://fixture').pathname
        const json = (body: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
        if (path === '/api/auth') authAttempts++
        if (path === '/api/auth' && mode === 'auth-body-stall') {
            res.writeHead(401, { 'Content-Type': 'application/json' }); res.flushHeaders()
            stalledAuth.add(res); res.on('close', () => stalledAuth.delete(res)); return
        }
        if (path === '/api/auth' && mode === 'auth-unavailable') { json({ error: 'auth unavailable' }, 503); return }
        if (mode !== 'ok' && mode !== 'auth-unavailable' && mode !== 'auth-body-stall') { json({ error: mode === 'telegram-disabled' ? 'Telegram authentication is disabled. Configure TELEGRAM_BOT_TOKEN.' : mode }, mode === 'rejected' ? 401 : 503); return }
        if (path === '/api/auth') {
            const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')
            json({ token: 'fixture.' + payload + '.signature', user: { id: 'fixture' } }); return
        }
        if (path === '/api/events') {
            if (closeGlobalOnce && new URL(req.url ?? '/', 'http://fixture').searchParams.get('all') === 'true') {
                closeGlobalOnce = false; res.writeHead(204); res.end(); return
            }
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
            res.write('data: ' + JSON.stringify({ type: 'connection-changed', data: { subscriptionId: 'fixture', resume: 'ok' } }) + '\n\n')
            streams.add(res)
            const timer = setInterval(() => res.write('data: {"type":"heartbeat"}\n\n'), 1000)
            res.on('close', () => { clearInterval(timer); streams.delete(res) }); return
        }
        if (path === '/api/sessions') { json({ sessions }); return }
        if (path === '/api/features') { json({ githubPrAwareness: { enabled: false, source: 'default' } }); return }
        if (path === '/api/machines') { json({ machines: [] }); return }
        const session = sessions.find(s => path.startsWith('/api/sessions/' + s.id))
        if (session && path.endsWith('/messages')) {
            const text = 'Cached message ' + session.id.slice(-1)
            json({ messages: [{ id: session.id + '-message', seq: 1, createdAt: now, invokedAt: now,
                content: { role: 'user', content: { type: 'text', text } } }], page: {
                direction: 'latest', limit: 20, epoch: 1, reset: false, hasMore: false,
                nextBeforeSeq: null, nextBeforeAt: null, nextAfterSeq: null, nextAfterAt: null,
                snapshotHeadSeq: 1, snapshotHeadAt: now, readThroughRevision: 1,
            } }); return
        }
        if (session && path === '/api/sessions/' + session.id) { json({ session }); return }
        json({ success: true, sessionIds: [], providers: [], models: [], entries: [], messages: [],
            settings: {}, peerSpawnDefaults: { agent: 'claude', models: {}, permissionModes: {}, yolo: false } })
    })
    await new Promise<void>(resolve => hub.listen(0, '127.0.0.1', resolve))
    origin = 'http://127.0.0.1:' + (hub.address() as { port: number }).port
})
test.afterAll(async () => { disconnect(); hub.closeAllConnections(); await new Promise<void>(resolve => hub.close(() => resolve())) })
test.beforeEach(async ({ page }) => {
    mode = 'ok'; disconnect()
    for (const response of stalledAuth) response.destroy()
    stalledAuth.clear(); authAttempts = 0; closeGlobalOnce = false
    await page.addInitScript(server => {
        localStorage.setItem('hapi_hub_url', server)
        localStorage.setItem('hapi_access_token::' + server, 'fixture-credential')
    }, origin)
})

test('phone navigation remains reachable below wrapped auth and outage warnings', async ({ page }) => {
    test.setTimeout(60_000)
    await page.clock.install()
    await page.setViewportSize({ width: 390, height: 844 })
    const back = page.locator('button').filter({ has: page.locator('polyline[points="15 18 9 12 15 6"]') }).first()
    await page.goto('/sessions/network-chat-A')
    await expect(page.getByText('Cached message A', { exact: true })).toBeVisible()
    await back.click()
    await page.getByText('Offline fixture B', { exact: true }).first().click()
    await expect(page.getByText('Cached message B', { exact: true })).toBeVisible()
    await back.click()
    await page.getByText('Offline fixture A', { exact: true }).first().click()
    await page.clock.fastForward(16_000)
    mode = 'auth-unavailable'; closeGlobalOnce = true; disconnect()
    const refresh = page.getByText(/^Sign-in refresh failed\. Live updates are connected; retrying automatically\./)
    await expect(refresh).toBeVisible()
    await expect.poll(async () => (await back.boundingBox())!.y - (await refresh.boundingBox())!.y - (await refresh.boundingBox())!.height).toBeGreaterThanOrEqual(0)
    await back.click()
    await page.getByText('Offline fixture B', { exact: true }).first().click()
    await expect(page.getByText('Cached message B', { exact: true })).toBeVisible()
    mode = 'unavailable'; disconnect(); await page.clock.fastForward(16_000)
    const outage = page.getByText(/hub or its gateway is temporarily unavailable/)
    await expect(outage).toBeVisible({ timeout: 15_000 })
    await expect.poll(async () => (await back.boundingBox())!.y - (await outage.boundingBox())!.y - (await outage.boundingBox())!.height).toBeGreaterThanOrEqual(0)
    await back.click()
    await page.getByText('Offline fixture A', { exact: true }).first().click()
    await expect(page.getByText('Cached message A', { exact: true })).toBeVisible()
    await expect(page.locator('input[type=password]')).toHaveCount(0)
})

test('reports a sign-in refresh failure without a hub outage while REST and live updates work', async ({ page }) => {
    await page.clock.install()
    await page.goto('/sessions/network-chat-A')
    await expect(page.getByText('Cached message A', { exact: true })).toBeVisible()
    await expect.poll(() => streams.size).toBeGreaterThanOrEqual(2)
    await page.clock.fastForward(16_000)
    mode = 'auth-unavailable'; closeGlobalOnce = true; disconnect()
    await expect.poll(() => authAttempts).toBeGreaterThan(1)
    await expect(page.getByText(/^Sign-in refresh failed\. Live updates are connected; retrying automatically\./)).toBeVisible()
    await expect(page.getByText(/hub or its gateway is temporarily unavailable/)).toHaveCount(0)
    await expect.poll(() => streams.size).toBeGreaterThanOrEqual(2)
    await page.getByText('Offline fixture B', { exact: true }).first().click()
    await expect(page.getByText('Cached message B', { exact: true })).toBeVisible()
    mode = 'ok'; await page.clock.fastForward(6_000)
    await expect(page.getByText(/^Sign-in refresh failed\. Live updates are connected; retrying automatically\./)).toHaveCount(0)
})

test('keeps the active chat after 401 headers when the response body stalls until the auth deadline', async ({ page }) => {
    await page.clock.install()
    await page.goto('/sessions/network-chat-A')
    await expect(page.getByText('Cached message A', { exact: true })).toBeVisible()
    await page.clock.fastForward(16_000)
    mode = 'auth-body-stall'; closeGlobalOnce = true; disconnect()
    await expect.poll(() => stalledAuth.size).toBeGreaterThan(0)
    await page.clock.fastForward(15_000)
    await expect(page.getByText('Cached message A', { exact: true })).toBeVisible()
    await expect(page.locator('input[type=password]')).toHaveCount(0)
    await expect(page.getByText('Sign-in refresh failed. Live updates are connected; retrying automatically.', { exact: true })).toBeVisible()
    mode = 'ok'; await page.clock.fastForward(6_000)
    await expect(page.getByText('Sign-in refresh failed. Live updates are connected; retrying automatically.', { exact: true })).toHaveCount(0)
})

test('restored sign-in shows connection recovery, identifies offline, and reconnects without a token prompt', async ({ page, context }) => {
    mode = 'unavailable'
    await page.goto('/sessions')
    await expect(page.getByText('Reconnecting to hub', { exact: true })).toBeVisible()
    await expect(page.getByRole('status')).toContainText('HTTP 503')
    await expect(page.locator('input[type=password]')).toHaveCount(0)
    await context.setOffline(true)
    await expect(page.getByRole('status')).toContainText('Your device is offline')
    mode = 'ok'
    await context.setOffline(false)
    await expect(page.getByText('Offline fixture A', { exact: true })).toBeVisible()
    await expect(page.getByText('Reconnecting to hub', { exact: true })).toHaveCount(0)
})

test('cached chats remain navigable during a server outage and recover without reload', async ({ page, context }) => {
    test.setTimeout(60_000)
    await page.clock.install()
    await page.setViewportSize({ width: 1200, height: 850 })
    await page.goto('/sessions/network-chat-A')
    await expect(page.getByText('Cached message A', { exact: true })).toBeVisible()
    await page.getByText('Offline fixture B', { exact: true }).first().click()
    await expect(page.getByText('Cached message B', { exact: true })).toBeVisible()
    await page.getByText('Offline fixture A', { exact: true }).first().click()
    await expect(page.getByText('Cached message A', { exact: true })).toBeVisible()
    await context.setOffline(true); disconnect()
    await expect(page.getByText(/Your device is offline/)).toBeVisible({ timeout: 10000 })
    await expect(page.getByText('Cached message A', { exact: true })).toBeVisible()
    await page.getByText('Offline fixture B', { exact: true }).first().click()
    await expect(page.getByText('Cached message B', { exact: true })).toBeVisible()
    await page.getByText('Offline fixture A', { exact: true }).first().click()
    await expect(page.getByText('Cached message A', { exact: true })).toBeVisible()
    await context.setOffline(false)
    await page.clock.fastForward(16_000)
    mode = 'unavailable'; disconnect()
    await expect(page.getByText(/hub or its gateway is temporarily unavailable/)).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('input[type=password]')).toHaveCount(0)
    await page.getByText('Offline fixture B', { exact: true }).first().click()
    await expect(page.getByText('Cached message B', { exact: true })).toBeVisible()
    mode = 'ok'
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await expect(page.getByText(/hub or its gateway is temporarily unavailable/)).toHaveCount(0)
    await expect.poll(() => streams.size).toBeGreaterThan(0)
    await expect(page.getByText('Cached message B', { exact: true })).toBeVisible()
})

test('a confirmed 401 still requires authentication', async ({ page }) => {
    mode = 'rejected'
    await page.goto('/sessions')
    await expect(page.locator('input[type=password]')).toBeVisible()
    await expect(page.getByText('Reconnecting to hub', { exact: true })).toHaveCount(0)
})

test('preserves the actionable Telegram-disabled diagnostic', async ({ page }) => {
    mode = 'telegram-disabled'
    await page.goto('/sessions?initData=fixture-telegram')
    await expect(page.getByRole('status')).toHaveText('Telegram authentication is disabled. Configure TELEGRAM_BOT_TOKEN.')
    await expect(page.getByText(/temporarily unavailable/)).toHaveCount(0)
})

import { expect, test } from '@playwright/test'
import { createServer, type Server, type ServerResponse } from 'node:http'

// Exercise the real App, auth hook, router, SSE and message cache. No agent or model calls.
let hub: Server
let origin: string
let mode: 'ok' | 'unavailable' | 'rejected' = 'ok'
const streams = new Set<ServerResponse>()
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
        if (mode !== 'ok') { json({ error: mode }, mode === 'rejected' ? 401 : 503); return }
        if (path === '/api/auth') {
            const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')
            json({ token: 'fixture.' + payload + '.signature', user: { id: 'fixture' } }); return
        }
        if (path === '/api/events') {
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
test.beforeEach(() => { mode = 'ok'; disconnect() })

test('restored sign-in shows connection recovery, identifies offline, and reconnects without a token prompt', async ({ page, context }) => {
    mode = 'unavailable'
    await page.goto('/sessions?hub=' + encodeURIComponent(origin) + '&token=fixture-credential')
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
    await page.goto('/sessions/network-chat-A?hub=' + encodeURIComponent(origin) + '&token=fixture-credential')
    await expect(page.getByText('Cached message A', { exact: true })).toBeVisible()
    await page.getByText('Offline fixture B', { exact: true }).first().click()
    await expect(page.getByText('Cached message B', { exact: true })).toBeVisible()
    await page.getByText('Offline fixture A', { exact: true }).first().click()
    await expect(page.getByText('Cached message A', { exact: true })).toBeVisible()
    await context.setOffline(true); disconnect()
    await expect(page.getByText(/Your device is offline/)).toBeVisible({ timeout: 10000 })
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
    await page.goto('/sessions?hub=' + encodeURIComponent(origin) + '&token=fixture-credential')
    await expect(page.locator('input[type=password]')).toBeVisible()
    await expect(page.getByText('Reconnecting to hub', { exact: true })).toHaveCount(0)
})

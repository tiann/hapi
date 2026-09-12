/**
 * In-process end-to-end test for the preview feature:
 * real hub (startHub on a test port) + real CLI-side PreviewRuntime connected
 * over socket.io + real static/proxy terminators + external fetch/WS clients.
 *
 * Run from cli/:  bun scripts/preview-e2e.ts
 * Exits 0 when every assertion passes.
 *
 * NOTE: env must be set before hub modules load their configuration.
 */

process.env.HAPI_HOME = '/tmp/hapi-preview-e2e-home'
process.env.DB_PATH = '/tmp/hapi-preview-e2e-home/hapi.db'
process.env.CLI_API_TOKEN = 'e2e-preview-token'
process.env.HAPI_LISTEN_HOST = '127.0.0.1'
process.env.HAPI_LISTEN_PORT = '3907'
process.env.HAPI_PUBLIC_URL = 'http://127.0.0.1:3907'

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { io } from 'socket.io-client'
import { WebSocket } from 'ws'

import { createPreviewRuntime } from '@/preview/runtime'
import type { PreviewFrame, PreviewMountDescriptor, PreviewRegisterAck, PreviewUnregisterRequest } from '@hapi/protocol/preview'

const HUB_PORT = 3907
const UPSTREAM_PORT = 5199

const results: { name: string; ok: boolean; detail?: string }[] = []
function check(name: string, ok: boolean, detail?: string): void {
    results.push({ name, ok, detail })
    console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
}

// --- test fixtures ---------------------------------------------------------

const siteDir = mkdtempSync(join(tmpdir(), 'hapi-e2e-site-'))
writeFileSync(join(siteDir, 'index.html'), '<html><body><h1>hello from static mount</h1></body></html>')
mkdirSync(join(siteDir, 'sub'), { recursive: true })
writeFileSync(join(siteDir, 'sub', 'data.json'), '{"answer":42}')
writeFileSync(join(siteDir, '.secret'), 'nope')

const upstream = Bun.serve({
    port: UPSTREAM_PORT,
    fetch(req, server) {
        const url = new URL(req.url)
        if (url.pathname === '/ws') {
            return server.upgrade(req) ? undefined : new Response('upgrade failed', { status: 500 })
        }
        if (url.pathname === '/main.html') {
            return new Response(
                '<html><head><title>dev</title></head><body><img src="/logo.png"><a href="/page">p</a></body></html>',
                { headers: { 'content-type': 'text/html; charset=utf-8' } }
            )
        }
        if (url.pathname === '/logo.png') {
            return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
                headers: { 'content-type': 'image/png' }
            })
        }
        return new Response('upstream 404', { status: 404 })
    },
    websocket: {
        message(ws, message) {
            ws.send(typeof message === 'string' ? `echo:${message}` : 'echo:binary')
        }
    }
})

// --- hub boot --------------------------------------------------------------

console.log('booting hub (in-process)…')
const { startHub } = await import('../../hub/src/startHub.ts')
const hub = await startHub()
console.log('hub ready')

// --- CLI-side runtime over a real socket -----------------------------------

const socket = io(`http://127.0.0.1:${HUB_PORT}/cli`, {
    auth: { token: process.env.CLI_API_TOKEN, clientType: 'session-scoped', sessionId: 'e2e-preview-session' },
    path: '/socket.io/',
    transports: ['websocket'],
    reconnection: true
})

await new Promise<void>((resolve, reject) => {
    socket.on('connect', () => resolve())
    socket.on('connect_error', (error) => reject(new Error(`socket connect failed: ${error}`)))
    setTimeout(() => reject(new Error('socket connect timeout')), 10_000)
})
console.log('CLI socket connected')

const runtime = createPreviewRuntime({
    connected: () => socket.connected,
    emitFrame: (frame: PreviewFrame) => {
        if (!socket.connected) return false
        socket.emit('preview:frame', frame)
        return true
    },
    register: (descriptor: PreviewMountDescriptor) =>
        new Promise<PreviewRegisterAck | null>((resolve) => {
            socket.timeout(10_000).emit('preview:register', descriptor, (err: Error | null, ack: PreviewRegisterAck) =>
                resolve(err ? null : ack)
            )
        }),
    unregister: (request: PreviewUnregisterRequest) =>
        new Promise<{ ok: boolean } | null>((resolve) => {
            socket.timeout(10_000).emit('preview:unregister', request, (err: Error | null, ack: { ok: boolean }) =>
                resolve(err ? null : ack)
            )
        })
})
socket.on('preview:frame', (frame: PreviewFrame) => runtime.handleFrame(frame))

// --- assertions ------------------------------------------------------------

console.log('\n[static mount]')
const staticMount = await runtime.mounts.mountStatic({ path: siteDir, name: 'site' })
console.log(`  URL: ${staticMount.publicUrl}`)

{
    const res = await fetch(staticMount.publicUrl)
    const body = await res.text()
    check('GET / → 200 index.html', res.status === 200 && body.includes('hello from static mount'), `status=${res.status}`)
    check('content-type is html', (res.headers.get('content-type') ?? '').includes('text/html'))
    check('ETag present', Boolean(res.headers.get('etag')))

    const etag = res.headers.get('etag') ?? ''
    const cached = await fetch(staticMount.publicUrl, { headers: { 'if-none-match': etag } })
    check('If-None-Match → 304', cached.status === 304, `status=${cached.status}`)
}

{
    const res = await fetch(`${staticMount.publicUrl}sub/data.json`)
    const body = await res.text()
    check('GET /sub/data.json → 200 json', res.status === 200 && body.includes('"answer"'), `status=${res.status}`)
}

{
    const res = await fetch(`${staticMount.publicUrl}missing.html`)
    check('GET missing → 404', res.status === 404, `status=${res.status}`)
}

{
    // %2F stays encoded through URL parsing, so the CLI decodes '..' segments.
    const res = await fetch(`${staticMount.publicUrl}..%2F..%2Fetc%2Fpasswd`)
    check('traversal (%2e%2e) → 404', res.status === 404, `status=${res.status}`)
}

{
    const res = await fetch(`${staticMount.publicUrl}.secret`)
    check('dotfile → 404', res.status === 404, `status=${res.status}`)
}

console.log('\n[proxy mount]')
const proxyMount = await runtime.mounts.mountProxy({ port: UPSTREAM_PORT, name: 'dev' })
console.log(`  URL: ${proxyMount.publicUrl}`)

{
    const res = await fetch(`${proxyMount.publicUrl}main.html`)
    const body = await res.text()
    check('GET dev server html → 200', res.status === 200, `status=${res.status}`)
    check('HTML attribute rewritten to mount prefix', body.includes(`src="/preview/${proxyMount.mountId}/logo.png"`), body.slice(0, 160))
    check('<base> injected', body.includes(`<base href="/preview/${proxyMount.mountId}/">`))
}

{
    const res = await fetch(`${proxyMount.publicUrl}logo.png`)
    const body = new Uint8Array(await res.arrayBuffer())
    check('binary asset round-trips (png magic)', res.status === 200 && body[0] === 0x89 && body[7] === 0x0a, `status=${res.status}`)
}

{
    const res = await fetch(`${proxyMount.publicUrl}nope`)
    check('upstream 404 passes through', res.status === 404, `status=${res.status}`)
}

console.log('\n[websocket pass-through (HMR-style)]')
{
    const echo = await new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${HUB_PORT}/preview/${proxyMount.mountId}/ws`)
        const fail = (error: Error) => reject(error)
        ws.on('error', fail)
        ws.on('open', () => {
            // Send immediately on open — exercises the CONNECTING-buffer path.
            ws.send('ping')
        })
        ws.on('message', (data: Buffer) => {
            resolve(data.toString('utf8'))
            ws.close()
        })
        setTimeout(() => reject(new Error('ws echo timeout')), 10_000)
    })
    check('ws round-trip through tunnel', echo === 'echo:ping', `received=${echo}`)
}

console.log('\n[reconnect re-registration]')
{
    // socket.io emits 'disconnect' synchronously on disconnect() — register
    // the listener first or the await below never resolves.
    const disconnected = new Promise<void>((resolve) => socket.once('disconnect', resolve))
    socket.disconnect()
    await disconnected
    const reconnected = new Promise<void>((resolve) => socket.once('connect', resolve))
    socket.connect()
    await reconnected
    await runtime.mounts.reregisterAll()

    const res = await fetch(staticMount.publicUrl)
    check('same URL works after reconnect + re-register', res.status === 200, `status=${res.status}`)
}

console.log('\n[unmount]')
{
    await runtime.mounts.stop({ all: true })
    const staticRes = await fetch(staticMount.publicUrl)
    const proxyRes = await fetch(`${proxyMount.publicUrl}main.html`)
    check('stopped static URL → 410 Gone', staticRes.status === 410, `status=${staticRes.status}`)
    check('stopped proxy URL → 410 Gone', proxyRes.status === 410, `status=${proxyRes.status}`)
}

// --- teardown --------------------------------------------------------------

socket.disconnect()
upstream.stop(true)
await hub.stop()
rmSync(siteDir, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
    process.exit(1)
}
process.exit(0)

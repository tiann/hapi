import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DshRuntimeStartErrorImpl, startDshHost } from './DshRuntime'

const FAKE_READY = `
const { createServer } = require('node:http')
const args = process.argv
const port = Number(args[args.indexOf('--port') + 1])
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    let rpcId = 'x'
    try { rpcId = JSON.parse(body).rpcId ?? 'x' } catch {}
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      type: 'server-response',
      rpcId,
      result: { ok: true, value: { version: '0.1.0-rc.6', cwd: process.cwd(), attachedSessions: 0, canOpenPath: false } }
    }))
  })
})
server.listen(port, '127.0.0.1')
process.on('SIGTERM', () => { server.close(() => process.exit(0)) })
`

const FAKE_CRASH = `process.exit(3)`

const FAKE_SILENT = `setInterval(() => {}, 1000)`

let cleanupDirs: string[] = []

afterEach(() => {
    for (const dir of cleanupDirs) {
        rmSync(dir, { recursive: true, force: true })
    }
    cleanupDirs = []
})

function fakeBin(source: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-dsh-test-'))
    cleanupDirs.push(dir)
    const file = join(dir, 'fake-dsh.js')
    writeFileSync(file, source)
    return file
}

describe('DshRuntime (fake runtime binaries)', () => {
    it('spawns, waits for readiness, and stops gracefully on SIGTERM', async () => {
        const bin = fakeBin(FAKE_READY)
        const handle = await startDshHost({
            cwd: tmpdir(),
            runtimeBin: bin,
            readyTimeoutMs: 10_000
        })

        expect(handle.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
        expect(handle.info.version).toBe('0.1.0-rc.6')
        expect(handle.info.cwd).toBe(tmpdir())
        expect(handle.process.pid).toBeGreaterThan(0)

        const exited = new Promise<number | null>((resolve) => {
            handle.process.once('exit', (code) => resolve(code))
        })
        await handle.stop({ timeoutMs: 3_000 })
        expect(await exited).toBe(0)
    })

    it('reports an exit-before-readiness failure with the stderr tail', async () => {
        const bin = fakeBin(FAKE_CRASH)
        const error = await startDshHost({
            cwd: tmpdir(),
            runtimeBin: bin,
            readyTimeoutMs: 5_000
        }).catch((e: unknown) => e)

        expect(error).toBeInstanceOf(DshRuntimeStartErrorImpl)
        expect((error as DshRuntimeStartErrorImpl).kind).toBe('exit')
        expect((error as DshRuntimeStartErrorImpl).message).toContain('code=3')
    })

    it('times out when the runtime never becomes ready', async () => {
        const bin = fakeBin(FAKE_SILENT)
        const error = await startDshHost({
            cwd: tmpdir(),
            runtimeBin: bin,
            readyTimeoutMs: 1_500
        }).catch((e: unknown) => e)

        expect(error).toBeInstanceOf(DshRuntimeStartErrorImpl)
        expect((error as DshRuntimeStartErrorImpl).kind).toBe('timeout')
    })

    it('fails with kind install when the runtime is missing and auto-install is disabled', async () => {
        const previous = process.env.HAPI_DSH_NO_INSTALL
        process.env.HAPI_DSH_NO_INSTALL = '1'
        try {
            const error = await startDshHost({
                cwd: tmpdir(),
                runtimeBin: join(tmpdir(), 'does-not-exist-xyz.js'),
                readyTimeoutMs: 1_000
            }).catch((e: unknown) => e)
            expect(error).toBeInstanceOf(DshRuntimeStartErrorImpl)
            expect((error as DshRuntimeStartErrorImpl).kind).toBe('install')
        } finally {
            if (previous === undefined) {
                delete process.env.HAPI_DSH_NO_INSTALL
            } else {
                process.env.HAPI_DSH_NO_INSTALL = previous
            }
        }
    })
})

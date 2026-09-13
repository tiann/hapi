import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import { spawn, execSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { reapTestOwnedProcesses } from './auditTestProcesses'
import { TEST_OWNED_MARKER_KEY } from './integrationEnv'

// Workers can't inherit process.env from globalSetup, so we write config to a file
// and let setupFile.ts read it in each worker.
export const TEST_CONFIG_FILE = join(tmpdir(), 'hapi-test-config.json')

async function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer()
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as net.AddressInfo
            server.close(() => resolve(addr.port))
        })
        server.on('error', reject)
    })
}

async function waitForHub(baseUrl: string, timeoutMs = 15_000): Promise<void> {
    const healthUrl = `${baseUrl}/health`
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(healthUrl, { signal: AbortSignal.timeout(1000) })
            if (res.ok) return
        } catch {
            // not ready yet — connection refused or timeout
        }
        await new Promise(resolve => setTimeout(resolve, 200))
    }
    throw new Error(`Hub did not become ready within ${timeoutMs}ms`)
}

function findBunExec(): string {
    const cmd = process.platform === 'win32' ? 'where bun' : 'command -v bun'
    const p = execSync(cmd, { encoding: 'utf8' })
        .split(/\r?\n/)
        .map(line => line.trim())
        .find(Boolean)
    if (!p) throw new Error('[globalSetup] bun executable not found')
    return p
}

let hubProcess: ChildProcess | null = null
let tmpHome: string | null = null

export async function setup() {
    const port = await getFreePort()
    tmpHome = mkdtempSync(join(tmpdir(), 'hapi-test-'))
    const token = randomBytes(20).toString('base64url')
    const bunExec = findBunExec()

    // The runner integration suite spawns sessions whose agent-availability
    // preflight requires an installable Claude CLI. CI runners have none, so
    // provide a stub binary and point workers at it (see setup.ts). POSIX
    // only: the shebang stub is meaningless on Windows, and the integration
    // suite is not part of any Windows path anyway.
    let stubClaudePath: string | undefined
    if (process.platform !== 'win32') {
        const stubBin = join(tmpHome, 'bin')
        mkdirSync(stubBin, { recursive: true })
        stubClaudePath = join(stubBin, 'claude')
        writeFileSync(stubClaudePath, '#!/bin/sh\nexec sleep 300\n', { mode: 0o755 })
    }

    // Use a minimal env whitelist to prevent shell credentials (DB_PATH,
    // TELEGRAM_BOT_TOKEN, ELEVENLABS_API_KEY, etc.) from leaking into the
    // test hub and triggering real notifications or opening a production DB.
    const hubEnv: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
        ...(process.env.BUN_INSTALL ? { BUN_INSTALL: process.env.BUN_INSTALL } : {}),
        HAPI_HOME: tmpHome,
        DB_PATH: join(tmpHome, 'hapi.db'),
        HAPI_LISTEN_PORT: String(port),
        HAPI_LISTEN_HOST: '127.0.0.1',
        HAPI_PUBLIC_URL: `http://127.0.0.1:${port}`,
        CLI_API_TOKEN: token,
        TELEGRAM_NOTIFICATION: 'false',
        SERVERCHAN_NOTIFICATION: 'false',
    }

    // Write config so setupFile.ts can inject env vars into each test worker
    writeFileSync(TEST_CONFIG_FILE, JSON.stringify({ port, token, tmpHome, bunExec, stubClaudePath }))

    const hubEntry = join(
        dirname(fileURLToPath(import.meta.url)),
        '../../../hub/src/index.ts'
    )

    hubProcess = spawn(bunExec, ['run', hubEntry], {
        env: hubEnv,
        stdio: 'ignore',
    })

    hubProcess.on('error', (err) => {
        throw new Error(`[globalSetup] Failed to spawn hub: ${err.message}`)
    })

    await waitForHub(`http://127.0.0.1:${port}`)
}

async function stopHubProcess(): Promise<void> {
    if (!hubProcess || hubProcess.exitCode !== null) return

    await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 5_000)
        hubProcess!.once('exit', () => {
            clearTimeout(timeout)
            resolve()
        })
        hubProcess!.kill()
    })
}

export async function teardown() {
    await stopHubProcess()
    try { rmSync(TEST_CONFIG_FILE) } catch {}

    // Final audit: test children carry `HAPI_TEST_MARKER=<tmpHome>` in their
    // environment (see integrationEnv.ts). Anything still alive after the
    // suites ran is a test-owned leak — reap it, then fail the run with
    // PID/command diagnostics if something could not be reaped. The temp home
    // is always removed so a leak cannot also accumulate DB rows on disk.
    let auditError: Error | null = null
    if (tmpHome && process.platform !== 'win32') {
        try {
            const leftovers = await reapTestOwnedProcesses(`${TEST_OWNED_MARKER_KEY}=${tmpHome}`)
            if (leftovers.length > 0) {
                const detail = leftovers
                    .map((p) => `  pid=${p.pid} ppid=${p.ppid} rss=${p.rssKb}KB ${p.command}`)
                    .join('\n')
                auditError = new Error(
                    `[globalSetup] ${leftovers.length} test-owned process(es) survived teardown:\n${detail}`
                )
            }
        } catch (error) {
            // A failed process-table scan must fail the run, never pass as a
            // "clean" audit.
            auditError = error instanceof Error ? error : new Error(String(error))
        }
    }
    if (tmpHome) {
        rmSync(tmpHome, { recursive: true, force: true })
    }
    if (auditError) {
        throw auditError
    }
}

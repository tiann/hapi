import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import crossSpawn from 'cross-spawn'
import { logger } from '@/ui/logger'
import { configuration } from '@/configuration'
import { DshNodeTransport } from './DshNodeTransport'
import { DSH_HOST_ONLY_OVERLAY, DSH_RUNTIME_PACKAGE } from './overlay'
import {
    DSH_RUNTIME_DIR_NAME,
    DSH_RUNTIME_NO_INSTALL_ENV,
    DSH_RUNTIME_PATH_ENV,
    DSH_RUNTIME_VERSION,
    type DshHostHandle,
    type DshRuntimeOptions,
    type DshRuntimeStartError
} from './types'

const READY_POLL_INITIAL_MS = 300
const READY_POLL_MAX_MS = 2_000
const STOP_TIMEOUT_MS = 10_000
const OUTPUT_TAIL_CHARS = 4_000

/** Error carrying the structured start-failure kind (spawn/timeout/exit/install). */
export class DshRuntimeStartErrorImpl extends Error implements DshRuntimeStartError {
    readonly kind: DshRuntimeStartError['kind']
    readonly stderrTail?: string

    constructor(kind: DshRuntimeStartError['kind'], message: string, stderrTail?: string) {
        super(message)
        this.kind = kind
        this.stderrTail = stderrTail
    }
}

/**
 * Default runtime binary: the official dsh CLI entry under the HAPI-managed
 * install directory. Resolved relative to HAPI_HOME so single-executable
 * builds never bundle DSH packages.
 */
export function defaultDshRuntimeBin(): string {
    return join(configuration.happyHomeDir, DSH_RUNTIME_DIR_NAME, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

/** Probe one free loopback port (bind 0 → note → close). */
export function probeFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer()
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
            const address = server.address()
            const port = typeof address === 'object' && address !== null ? address.port : 0
            server.close(() => resolve(port))
        })
    })
}

/** Whether the pinned DSH runtime binary is already installed. */
export function isDshRuntimeInstalled(): boolean {
    return existsSync(defaultDshRuntimeBin())
}

/**
 * Install the pinned DSH runtime under HAPI_HOME/dsh-runtime. Prefers bun
 * (fast), falls back to npm (universally present where node exists).
 * @returns the installed bin.js path.
 */
export async function installDshRuntime(options?: { onProgress?: (line: string) => void }): Promise<string> {
    const dir = join(configuration.happyHomeDir, DSH_RUNTIME_DIR_NAME)
    mkdirSync(dir, { recursive: true })
    const pkgJson = join(dir, 'package.json')
    if (!existsSync(pkgJson)) {
        writeFileSync(pkgJson, JSON.stringify({ name: 'hapi-dsh-runtime', private: true }, null, 2))
    }
    const report = (line: string) => {
        logger.debug(`[dsh] install: ${line}`)
        options?.onProgress?.(line)
    }

    const run = (command: string, args: string[]): Promise<void> =>
        new Promise((resolve, reject) => {
            report(`${command} ${args.join(' ')}`)
            const child = crossSpawn(command, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
            let stderr = ''
            child.stderr?.on('data', (chunk) => {
                stderr += chunk.toString()
            })
            child.once('error', reject)
            child.once('exit', (code) => {
                if (code === 0) {
                    resolve()
                } else {
                    reject(new Error(`${command} exited ${code}: ${stderr.slice(-1_000)}`))
                }
            })
        })

    const binPath = defaultDshRuntimeBin()
    const nodeAvailable = await new Promise<boolean>((resolve) => {
        const child = crossSpawn('node', ['--version'], { stdio: 'ignore' })
        child.once('error', () => resolve(false))
        child.once('exit', (code) => resolve(code === 0))
    })
    if (!nodeAvailable) {
        throw new Error(
            'The DeepSeek Harness runtime requires Node.js to execute (the DSH host ' +
            'loads NAPI modules that are incompatible with Bun). Install Node.js and retry, ' +
            `or set ${DSH_RUNTIME_PATH_ENV} to an existing dsh bin.`
        )
    }
    const bunAvailable = await new Promise<boolean>((resolve) => {
        const child = crossSpawn('bun', ['--version'], { stdio: 'ignore' })
        child.once('error', () => resolve(false))
        child.once('exit', (code) => resolve(code === 0))
    })

    try {
        if (bunAvailable) {
            await run('bun', ['add', '--cwd', dir, DSH_RUNTIME_PACKAGE])
        } else {
            await run('npm', ['install', '--prefix', dir, '--no-audit', '--no-fund', DSH_RUNTIME_PACKAGE])
        }
    } catch (error) {
        throw new Error(
            `Failed to install the DeepSeek Harness runtime (${DSH_RUNTIME_PACKAGE}) under ${dir}. ` +
            `Install it manually or set ${DSH_RUNTIME_PATH_ENV} to an existing dsh bin.`,
            { cause: error }
        )
    }
    if (!existsSync(binPath)) {
        throw new Error(`DSH runtime installed but binary missing at ${binPath}`)
    }
    return binPath
}

/**
 * Spawn a host-only DeepSeek Harness runtime and wait for its API readiness
 * handshake (host.describe). The host binds loopback only; the frontend is
 * stripped via the official --patch overlay (GET / → 404).
 *
 * The returned handle's `process` emits 'exit' on host crash; callers observe
 * it to detect an unexpected host death (code !== 0 while not stopping).
 */
export async function startDshHost(options: DshRuntimeOptions): Promise<DshHostHandle> {
    const logTag = options.logTag ?? 'dsh'
    const binPath = options.runtimeBin ?? (() => {
        if (process.env[DSH_RUNTIME_PATH_ENV]) {
            return process.env[DSH_RUNTIME_PATH_ENV]!
        }
        return defaultDshRuntimeBin()
    })()

    const runtimeMissing = !existsSync(binPath)
    const runtimeOutdated = !runtimeMissing && (() => {
        try {
            const manifest = JSON.parse(readFileSync(
                join(binPath, '..', '..', '..', '..', '..', 'package.json'),
                'utf8'
            )) as { version?: string }
            return manifest.version !== DSH_RUNTIME_VERSION
        } catch {
            return false
        }
    })()
    if (runtimeMissing || runtimeOutdated) {
        const noInstall = process.env[DSH_RUNTIME_NO_INSTALL_ENV] === '1'
        if (noInstall) {
            throw new DshRuntimeStartErrorImpl(
                'install',
                `DSH runtime ${runtimeMissing ? 'not found' : 'version mismatch'} at ${binPath} (${DSH_RUNTIME_NO_INSTALL_ENV}=1)`
            )
        }
        logger.debug(`[${logTag}] DSH runtime ${runtimeMissing ? 'missing' : `outdated (wanted ${DSH_RUNTIME_VERSION})`}; installing ${DSH_RUNTIME_PACKAGE}...`)
        await installDshRuntime({ onProgress: (line) => logger.debug(`[${logTag}] ${line}`) })
    }

    const port = options.port ?? await probeFreePort()
    const baseUrl = `http://127.0.0.1:${port}`

    // The official --patch overlay must be a real file path.
    const overlayDir = mkdtempSync(join(tmpdir(), 'hapi-dsh-'))
    const overlayFile = join(overlayDir, 'host-only.yml')
    writeFileSync(overlayFile, `${DSH_HOST_ONLY_OVERLAY}\n`)

    const args = ['--profile', 'web', '--patch', overlayFile, '--port', String(port)]
    logger.debug(`[${logTag}] spawning DSH host: ${binPath} ${args.join(' ')} (cwd=${options.cwd})`)

    // bin.js is a Node script (#!/usr/bin/env node) and the DSH host loads
    // NAPI modules (node-pty) that crash under Bun's libuv shim, so it MUST be
    // run under node — never process.execPath (which is Bun when the HAPI CLI
    // itself runs under Bun). An explicit HAPI_DSH_RUNTIME_PATH may point at
    // any executable, which is spawned as-is.
    const isJsScript = binPath.endsWith('.js')
    const nodeBin = process.env.HAPI_DSH_NODE_PATH?.trim() || 'node'
    const child = spawn(
        isJsScript ? nodeBin : binPath,
        isJsScript ? [binPath, ...args] : args,
        {
            cwd: options.cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                ...(options.dshHome ? { DSH_HOME: options.dshHome } : {}),
                ...options.env
            }
        }
    )

    let outputTail = ''
    const capture = (chunk: Buffer | string) => {
        outputTail = (outputTail + chunk.toString()).slice(-OUTPUT_TAIL_CHARS)
    }
    child.once('error', (error) => {
        // ENOENT and friends must fail the start, not hang the readiness poll:
        // surface it through the same exit-state channel the loop watches.
        logger.debug(`[${logTag}] DSH host spawn error: ${error.message}`)
        exitState.exit = { code: null, signal: null }
        spawnFailure = error.message
    })
    child.stderr?.on('data', (chunk) => {
        capture(chunk)
        logger.debug(`[${logTag}] host stderr: ${chunk.toString().trimEnd()}`)
    })
    child.stdout?.on('data', (chunk) => {
        logger.debug(`[${logTag}] host stdout: ${chunk.toString().trimEnd()}`)
    })

    const killChild = (signal: NodeJS.Signals): void => {
        try {
            child.kill(signal)
        } catch {
            // Already gone.
        }
    }
    const exitPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    // Object property instead of a bare let: TS does not narrow object
    // properties across async callbacks, so exitState.exit stays nullable.
    const exitState: { exit: { code: number | null; signal: string | null } | null } = { exit: null }
    let spawnFailure: string | null = null
    exitPromise.then((result) => {
        exitState.exit = result
    }).catch(() => {})

    const transport = new DshNodeTransport(baseUrl)
    const readyTimeoutMs = options.readyTimeoutMs ?? 30_000
    const deadline = Date.now() + readyTimeoutMs
    let delay = READY_POLL_INITIAL_MS
    let info: DshHostHandle['info'] | null = null

    while (Date.now() < deadline) {
        if (exitState.exit !== null) {
            throw new DshRuntimeStartErrorImpl(
                spawnFailure !== null ? 'spawn' : 'exit',
                spawnFailure !== null
                    ? `Failed to spawn DSH host: ${spawnFailure}`
                    : `DSH host exited before readiness (code=${exitState.exit.code}, signal=${exitState.exit.signal})`,
                outputTail
            )
        }
        try {
            const response = await transport.host.describe({})
            if (!response.result.ok) {
                throw new Error(`host.describe failed: ${response.result.error.message}`)
            }
            info = response.result.value
            break
        } catch (error) {
            if (Date.now() >= deadline) {
                killChild('SIGTERM')
                throw new DshRuntimeStartErrorImpl(
                    'timeout',
                    `DSH host did not become ready within ${readyTimeoutMs}ms: ${error instanceof Error ? error.message : String(error)}`,
                    outputTail
                )
            }
            await new Promise((resolve) => setTimeout(resolve, delay))
            delay = Math.min(delay * 2, READY_POLL_MAX_MS)
        }
    }

    if (info === null) {
        killChild('SIGTERM')
        throw new DshRuntimeStartErrorImpl(
            'timeout',
            `DSH host did not become ready within ${readyTimeoutMs}ms`,
            outputTail
        )
    }

    logger.debug(`[${logTag}] DSH host ready: ${baseUrl} hostVersion=${info.version} pinned=${DSH_RUNTIME_VERSION} cwd=${info.cwd}`)
    rmSync(overlayDir, { recursive: true, force: true })

    return {
        process: child,
        baseUrl,
        port,
        info,
        stop: async (stopOptions?: { timeoutMs?: number }) => {
            const timeoutMs = stopOptions?.timeoutMs ?? STOP_TIMEOUT_MS
            await new Promise<void>((resolve) => {
                const settled = () => resolve()
                child.once('exit', settled)
                child.kill('SIGTERM')
                const killer = setTimeout(() => {
                    if (child.exitCode === null && child.signalCode === null) {
                        child.kill('SIGKILL')
                    }
                }, timeoutMs)
                killer.unref()
                // Also settle if the child was already gone.
                if (child.exitCode !== null || child.signalCode !== null) {
                    resolve()
                }
            })
        }
    }
}

export type { DshHostHandle, DshRuntimeOptions, DshRuntimeStartError }
export type { ChildProcess }

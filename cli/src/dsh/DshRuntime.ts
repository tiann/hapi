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
/** Read the dsh package manifest version. binPath points at
 *  node_modules/@deepseek-ai/dsh/lib/bin.js, so the package manifest is two
 *  parent traversals up — NOT the wrapper's manifest. */
export function readDshRuntimeVersion(binPath: string): string | null {
    try {
        const manifest = JSON.parse(
            readFileSync(join(binPath, '..', '..', 'package.json'), 'utf8')
        ) as { version?: string }
        return manifest.version ?? null
    } catch {
        return null
    }
}

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
            // Watchdog: a stalled registry/network must not hang startup forever.
            const watchdog = setTimeout(() => {
                child.kill('SIGKILL')
                reject(new Error(`${command} timed out after 5 minutes: ${stderr.slice(-1_000)}`))
            }, 5 * 60_000)
            watchdog.unref?.()
            child.once('error', (error) => {
                clearTimeout(watchdog)
                reject(error)
            })
            child.once('exit', (code) => {
                clearTimeout(watchdog)
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
    const runtimeOutdated = !runtimeMissing && readDshRuntimeVersion(binPath) !== DSH_RUNTIME_VERSION
    const managedRuntime = options.runtimeBin === undefined && !process.env[DSH_RUNTIME_PATH_ENV]
    if (managedRuntime && (runtimeMissing || runtimeOutdated)) {
        const noInstall = process.env[DSH_RUNTIME_NO_INSTALL_ENV] === '1'
        if (noInstall) {
            throw new DshRuntimeStartErrorImpl(
                'install',
                `DSH runtime ${runtimeMissing ? 'not found' : 'version mismatch'} at ${binPath} (${DSH_RUNTIME_NO_INSTALL_ENV}=1)`
            )
        }
        logger.debug(`[${logTag}] DSH runtime ${runtimeMissing ? 'missing' : `outdated (wanted ${DSH_RUNTIME_VERSION})`}; installing ${DSH_RUNTIME_PACKAGE}...`)
        try {
            await installDshRuntime({ onProgress: (line) => logger.debug(`[${logTag}] ${line}`) })
        } catch (installError) {
            throw new DshRuntimeStartErrorImpl(
                'install',
                `DSH runtime install failed: ${installError instanceof Error ? installError.message : String(installError)}`
            )
        }
    } else if (!managedRuntime && runtimeMissing) {
        // Explicit override (HAPI_DSH_RUNTIME_PATH / options.runtimeBin):
        // never install behind it; fail loud with the exact path.
        if (process.env[DSH_RUNTIME_NO_INSTALL_ENV] === '1') {
            throw new DshRuntimeStartErrorImpl(
                'install',
                `DSH runtime not found at ${binPath} (${DSH_RUNTIME_NO_INSTALL_ENV}=1)`
            )
        }
        throw new DshRuntimeStartErrorImpl(
            'spawn',
            `DSH runtime not found at ${binPath}`
        )
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
        capture(chunk)
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
            rmSync(overlayDir, { recursive: true, force: true })
            throw new DshRuntimeStartErrorImpl(
                spawnFailure !== null ? 'spawn' : 'exit',
                spawnFailure !== null
                    ? `Failed to spawn DSH host: ${spawnFailure}`
                    : `DSH host exited before readiness (code=${exitState.exit.code}, signal=${exitState.exit.signal})`,
                outputTail
            )
        }
        try {
            // A host that binds the port but never completes describe() must
            // not hang startup forever: enforce the deadline per request.
            const remainingMs = Math.max(1, deadline - Date.now())
            let timer: ReturnType<typeof setTimeout> | undefined
            const response = await Promise.race([
                transport.host.describe({}),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(
                        () => reject(new Error('DSH readiness request timed out')),
                        remainingMs
                    )
                    timer.unref?.()
                })
            ]).finally(() => {
                if (timer) clearTimeout(timer)
            })
            if (!response.result.ok) {
                throw new Error(`host.describe failed: ${response.result.error.message}`)
            }
            info = response.result.value
            break
        } catch (error) {
            if (Date.now() >= deadline) {
                killChild('SIGTERM')
                // A host ignoring SIGTERM must not keep the port forever.
                const killer = setTimeout(() => killChild('SIGKILL'), 5_000)
                killer.unref?.()
                rmSync(overlayDir, { recursive: true, force: true })
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
        rmSync(overlayDir, { recursive: true, force: true })
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
        runtimeVersion: readDshRuntimeVersion(binPath) ?? DSH_RUNTIME_VERSION,
        stop: async (stopOptions?: { timeoutMs?: number }) => {
            const timeoutMs = stopOptions?.timeoutMs ?? STOP_TIMEOUT_MS
            await new Promise<void>((resolve) => {
                let killer: ReturnType<typeof setTimeout> | undefined
                const settled = () => {
                    if (killer) clearTimeout(killer)
                    child.removeListener('exit', settled)
                    resolve()
                }
                child.once('exit', settled)
                child.kill('SIGTERM')
                killer = setTimeout(() => {
                    if (child.exitCode === null && child.signalCode === null) {
                        child.kill('SIGKILL')
                    }
                }, timeoutMs)
                killer.unref()
                // Also settle if the child was already gone.
                if (child.exitCode !== null || child.signalCode !== null) {
                    settled()
                }
            })
        }
    }
}

export type { DshHostHandle, DshRuntimeOptions, DshRuntimeStartError }
export type { ChildProcess }

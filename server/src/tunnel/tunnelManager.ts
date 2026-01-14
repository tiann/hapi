/**
 * Tunnel Manager - Manages tunwg subprocess lifecycle
 *
 * Responsibilities:
 * - Spawn tunwg with proper environment variables
 * - Parse stdout for tunnel URL
 * - Monitor and restart on failure
 * - Clean shutdown on process exit
 */

import { spawn, type Subprocess } from 'bun'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { platform, arch, homedir } from 'node:os'

function isBunCompiled(): boolean {
    return typeof process.execPath === 'string' && !process.execPath.includes('bun')
}

function getPlatformDir(): string {
    const platformName = platform()
    const archName = arch()

    if (platformName === 'darwin') {
        if (archName === 'arm64') return 'arm64-darwin'
        if (archName === 'x64') return 'x64-darwin'
    } else if (platformName === 'linux') {
        if (archName === 'arm64') return 'arm64-linux'
        if (archName === 'x64') return 'x64-linux'
    } else if (platformName === 'win32') {
        if (archName === 'x64') return 'x64-win32'
    }

    throw new Error(`Unsupported platform: ${archName}-${platformName}`)
}

function getTunwgPath(): string {
    const isWin = platform() === 'win32'
    const tunwgBinary = isWin ? 'tunwg.exe' : 'tunwg'

    if (isBunCompiled()) {
        const hapiHome = process.env.HAPI_HOME || join(homedir(), '.hapi')
        const packageJson = require('../../../cli/package.json')
        const runtimePath = join(hapiHome, 'runtime', packageJson.version)
        return join(runtimePath, 'tools', 'tunwg', tunwgBinary)
    }

    // Development mode: use downloaded binary from server/tools/tunwg
    const platformDir = getPlatformDir()
    const devBinaryName = isWin ? `tunwg-${platformDir}.exe` : `tunwg-${platformDir}`
    return join(__dirname, '..', '..', 'tools', 'tunwg', devBinaryName)
}

export interface TunnelConfig {
    localPort: number
    enabled: boolean
    apiDomain?: string | null  // TUNWG_API - default: relay.hapi.run (official relay)
    authKey?: string | null    // TUNWG_AUTH - default: hapi
    useRelay?: boolean         // TUNWG_RELAY
}

interface TunnelState {
    process: Subprocess | null
    tunnelUrl: string | null
    isConnected: boolean
    lastError: string | null
    retryCount: number
}

export class TunnelManager {
    private config: TunnelConfig
    private state: TunnelState
    private readonly maxRetries = 5
    private readonly retryDelayMs = 3000
    private retryTimeout: ReturnType<typeof setTimeout> | null = null
    private stopped = false

    constructor(config: TunnelConfig) {
        this.config = config
        this.state = {
            process: null,
            tunnelUrl: null,
            isConnected: false,
            lastError: null,
            retryCount: 0
        }
    }

    async start(): Promise<string | null> {
        if (!this.config.enabled) {
            return null
        }

        this.stopped = false
        return this.spawnTunwg()
    }

    private async spawnTunwg(): Promise<string | null> {
        const tunwgPath = getTunwgPath()

        if (!existsSync(tunwgPath)) {
            throw new Error(`tunwg binary not found at ${tunwgPath}`)
        }

        const forwardUrl = `http://localhost:${this.config.localPort}`

        const env: Record<string, string> = { ...process.env as Record<string, string> }

        if (this.config.apiDomain) {
            env.TUNWG_API = this.config.apiDomain
        }
        env.TUNWG_AUTH = this.config.authKey ?? 'hapi'
        if (this.config.useRelay) {
            env.TUNWG_RELAY = 'true'
        }

        return new Promise((resolve, reject) => {
            console.log(`[Tunnel] Starting tunnel to ${forwardUrl}...`)

            const proc = spawn({
                cmd: [tunwgPath, '--json', `--forward=${forwardUrl}`],
                env,
                stdout: 'pipe',
                stderr: 'pipe'
            })

            this.state.process = proc

            // Buffer for incomplete lines
            let stdoutBuffer = ''

            let resolved = false

            const readStdout = async (): Promise<void> => {
                const reader = proc.stdout.getReader()
                try {
                    while (true) {
                        const { done, value } = await reader.read()
                        if (done) break

                        const text = new TextDecoder().decode(value)
                        stdoutBuffer += text

                        const lines = stdoutBuffer.split('\n')
                        stdoutBuffer = lines.pop() || ''

                        for (const line of lines) {
                            const trimmed = line.trim()
                            if (!trimmed) {
                                continue
                            }

                            const parsed = this.parseTunwgEvent(trimmed)
                            if (parsed && parsed.event === 'ready' && typeof parsed.url === 'string') {
                                if (!resolved) {
                                    this.state.tunnelUrl = parsed.url
                                    this.state.isConnected = true
                                    this.state.retryCount = 0
                                    resolved = true
                                    resolve(parsed.url)
                                }
                                continue
                            }

                            console.log(`[Tunnel] ${trimmed}`)
                        }
                    }
                } catch (err) {
                    console.error('[Tunnel] stdout read error:', err)
                }
            }

            readStdout()

            // Handle stderr (logs and warnings)
            const readStderr = async (): Promise<void> => {
                const reader = proc.stderr.getReader()
                let stderrBuffer = ''
                try {
                    while (true) {
                        const { done, value } = await reader.read()
                        if (done) break
                        const text = new TextDecoder().decode(value)
                        stderrBuffer += text

                        const lines = stderrBuffer.split('\n')
                        stderrBuffer = lines.pop() || ''

                        for (const line of lines) {
                            const trimmed = line.trim()
                            if (trimmed) {
                                console.log(`[Tunnel] ${trimmed}`)
                            }
                        }
                    }
                } catch {
                    // Ignore stderr read errors
                }
            }

            readStderr()

            // Handle process exit
            proc.exited.then(exitCode => {
                this.state.isConnected = false
                this.state.process = null

                if (this.stopped) {
                    // Stopped intentionally - reject if still pending
                    if (!resolved) {
                        resolved = true
                        reject(new Error('Tunnel stopped'))
                    }
                    return
                }

                if (exitCode !== 0) {
                    this.state.lastError = `tunwg exited with code ${exitCode}`
                    console.error(`[Tunnel] ${this.state.lastError}`)

                    // Reject the promise immediately if we haven't got a URL yet
                    if (!resolved) {
                        resolved = true
                        reject(new Error(this.state.lastError))
                        return
                    }

                    // Auto-restart with exponential backoff (only if we had a successful connection before)
                    if (this.state.retryCount < this.maxRetries) {
                        this.state.retryCount++
                        const delay = this.retryDelayMs * Math.pow(2, this.state.retryCount - 1)
                        console.log(`[Tunnel] Restarting in ${delay}ms (attempt ${this.state.retryCount}/${this.maxRetries})`)
                        this.retryTimeout = setTimeout(() => {
                            this.spawnTunwg().catch(err => {
                                console.error('[Tunnel] Restart failed:', err)
                            })
                        }, delay)
                    } else {
                        console.error('[Tunnel] Max retries reached. Tunnel disabled.')
                    }
                } else if (!resolved) {
                    // Process exited cleanly but no URL - shouldn't happen, but handle gracefully
                    resolved = true
                    reject(new Error('tunwg exited without providing a URL'))
                }
            })

            // Timeout for initial URL capture
            setTimeout(() => {
                if (!resolved) {
                    resolved = true
                    reject(new Error('Timeout waiting for tunnel URL'))
                }
            }, 30000)
        })
    }

    private parseTunwgEvent(line: string): { event?: string; url?: string } | null {
        try {
            return JSON.parse(line) as { event?: string; url?: string }
        } catch {
            return null
        }
    }

    async stop(): Promise<void> {
        this.stopped = true

        if (this.retryTimeout) {
            clearTimeout(this.retryTimeout)
            this.retryTimeout = null
        }

        if (this.state.process) {
            this.state.process.kill()
            try {
                await this.state.process.exited
            } catch {
                // Ignore exit errors
            }
            this.state.process = null
        }
        this.state.isConnected = false
        this.state.tunnelUrl = null
    }

    getTunnelUrl(): string | null {
        return this.state.tunnelUrl
    }

    isConnected(): boolean {
        return this.state.isConnected
    }
}

import { logger } from '@/ui/logger'
import { getInvokedCwd } from '@/utils/invokedCwd'
import type {
    TerminalErrorPayload,
    TerminalExitPayload,
    TerminalOutputPayload,
    TerminalReadyPayload
} from '@hapi/protocol'
import type { TerminalSession } from './types'

type TerminalRuntime = TerminalSession & {
    proc: Bun.Subprocess
    terminal: Bun.Terminal
    idleTimer: ReturnType<typeof setTimeout> | null
    outputBuffer: string
}

type TerminalManagerOptions = {
    sessionId?: string
    machineId?: string
    getSessionPath: () => string | null
    onReady: (payload: TerminalReadyPayload) => void
    onOutput: (payload: TerminalOutputPayload) => void
    onExit: (payload: TerminalExitPayload) => void
    onError: (payload: TerminalErrorPayload) => void
    idleTimeoutMs?: number
    maxTerminals?: number
}

const DEFAULT_IDLE_TIMEOUT_MS = 0
const DEFAULT_MAX_TERMINALS = 4
const MAX_OUTPUT_BUFFER_CHARS = 200_000
const SENSITIVE_ENV_KEYS = new Set([
    'CLI_API_TOKEN',
    'HAPI_API_URL',
    'HAPI_HTTP_MCP_URL',
    'TELEGRAM_BOT_TOKEN',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY'
])

function resolveEnvNumber(name: string, fallback: number): number {
    const raw = process.env[name]
    if (!raw) {
        return fallback
    }
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function resolveShell(): string {
    if (process.env.SHELL) {
        return process.env.SHELL
    }
    if (process.platform === 'darwin') {
        return '/bin/zsh'
    }
    return '/bin/bash'
}

function buildFilteredEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(process.env)) {
        if (!value) {
            continue
        }
        if (SENSITIVE_ENV_KEYS.has(key)) {
            continue
        }
        env[key] = value
    }
    if (!env.TERM) {
        env.TERM = 'xterm-256color'
    }
    if (!env.COLORTERM) {
        env.COLORTERM = 'truecolor'
    }
    if (!env.LANG) {
        env.LANG = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8'
    }
    return env
}

export class TerminalManager {
    private readonly sessionId?: string
    private readonly machineId?: string
    private readonly getSessionPath: () => string | null
    private readonly onReady: (payload: TerminalReadyPayload) => void
    private readonly onOutput: (payload: TerminalOutputPayload) => void
    private readonly onExit: (payload: TerminalExitPayload) => void
    private readonly onError: (payload: TerminalErrorPayload) => void
    private readonly idleTimeoutMs: number
    private readonly maxTerminals: number
    private readonly terminals: Map<string, TerminalRuntime> = new Map()
    private readonly filteredEnv: NodeJS.ProcessEnv

    constructor(options: TerminalManagerOptions) {
        if (Boolean(options.sessionId) === Boolean(options.machineId)) {
            throw new Error('TerminalManager requires exactly one of sessionId or machineId')
        }
        this.sessionId = options.sessionId
        this.machineId = options.machineId
        this.getSessionPath = options.getSessionPath
        this.onReady = options.onReady
        this.onOutput = options.onOutput
        this.onExit = options.onExit
        this.onError = options.onError
        this.idleTimeoutMs = options.idleTimeoutMs ?? resolveEnvNumber('HAPI_TERMINAL_IDLE_TIMEOUT_MS', DEFAULT_IDLE_TIMEOUT_MS)
        this.maxTerminals = options.maxTerminals ?? resolveEnvNumber('HAPI_TERMINAL_MAX_TERMINALS', DEFAULT_MAX_TERMINALS)
        this.filteredEnv = buildFilteredEnv()
    }

    create(terminalId: string, cols: number, rows: number, cwd?: string, replay = false): void {
        if (process.platform === 'win32') {
            this.emitError(terminalId, 'Remote terminal is not supported on Windows yet.')
            return
        }

        const existing = this.terminals.get(terminalId)
        if (existing) {
            existing.cols = cols
            existing.rows = rows
            existing.terminal.resize(cols, rows)
            this.markActivity(existing)
            this.onReady({ ...this.scopePayload(), terminalId })
            if (replay && existing.outputBuffer) {
                this.onOutput({ ...this.scopePayload(), terminalId, data: existing.outputBuffer })
            }
            return
        }

        if (this.terminals.size >= this.maxTerminals) {
            this.emitError(terminalId, `Too many terminals open (max ${this.maxTerminals}).`)
            return
        }

        if (typeof Bun === 'undefined' || typeof Bun.spawn !== 'function') {
            this.emitError(terminalId, 'Terminal is unavailable in this runtime.')
            return
        }

        const sessionPath = cwd?.trim() || this.getSessionPath() || getInvokedCwd()
        const shell = resolveShell()
        const decoder = new TextDecoder()

        try {
            const proc = Bun.spawn([shell], {
                cwd: sessionPath,
                env: this.filteredEnv,
                terminal: {
                    cols,
                    rows,
                    data: (terminal, data) => {
                        const text = decoder.decode(data, { stream: true })
                        if (text) {
                            this.appendOutputBuffer(terminalId, text)
                            this.onOutput({ ...this.scopePayload(), terminalId, data: text })
                        }
                        const active = this.terminals.get(terminalId)
                        if (active) {
                            this.markActivity(active)
                        }
                    },
                    exit: (terminal, exitCode) => {
                        if (exitCode === 1) {
                            this.emitError(terminalId, 'Terminal stream closed unexpectedly.')
                        }
                    }
                },
                onExit: (subprocess, exitCode) => {
                    const signal = subprocess.signalCode ?? null
                    this.onExit({
                        ...this.scopePayload(),
                        terminalId,
                        code: exitCode ?? null,
                        signal
                    })
                    this.cleanup(terminalId)
                }
            })

            const terminal = proc.terminal
            if (!terminal) {
                try {
                    proc.kill()
                } catch (error) {
                    logger.debug('[TERMINAL] Failed to kill process after missing terminal', { error })
                }
                this.emitError(terminalId, 'Failed to attach terminal.')
                return
            }

            const runtime: TerminalRuntime = {
                terminalId,
                cols,
                rows,
                proc,
                terminal,
                idleTimer: null,
                outputBuffer: ''
            }

            this.terminals.set(terminalId, runtime)
            this.markActivity(runtime)
            this.onReady({ ...this.scopePayload(), terminalId })
        } catch (error) {
            logger.debug('[TERMINAL] Failed to spawn terminal', { error })
            this.emitError(terminalId, 'Failed to spawn terminal.')
        }
    }

    write(terminalId: string, data: string): void {
        const runtime = this.terminals.get(terminalId)
        if (!runtime) {
            this.emitError(terminalId, 'Terminal not found.')
            return
        }
        runtime.terminal.write(data)
        this.markActivity(runtime)
    }

    resize(terminalId: string, cols: number, rows: number): void {
        const runtime = this.terminals.get(terminalId)
        if (!runtime) {
            return
        }
        runtime.cols = cols
        runtime.rows = rows
        runtime.terminal.resize(cols, rows)
        this.markActivity(runtime)
    }

    close(terminalId: string): void {
        this.cleanup(terminalId)
    }

    private appendOutputBuffer(terminalId: string, text: string): void {
        const runtime = this.terminals.get(terminalId)
        if (!runtime) return
        runtime.outputBuffer += text
        if (runtime.outputBuffer.length > MAX_OUTPUT_BUFFER_CHARS) {
            runtime.outputBuffer = runtime.outputBuffer.slice(-MAX_OUTPUT_BUFFER_CHARS)
        }
    }

    closeAll(): void {
        for (const terminalId of this.terminals.keys()) {
            this.cleanup(terminalId)
        }
    }

    private markActivity(runtime: TerminalRuntime): void {
        this.scheduleIdleTimer(runtime)
    }

    private scheduleIdleTimer(runtime: TerminalRuntime): void {
        if (this.idleTimeoutMs <= 0) {
            return
        }

        if (runtime.idleTimer) {
            clearTimeout(runtime.idleTimer)
        }

        runtime.idleTimer = setTimeout(() => {
            this.emitError(runtime.terminalId, 'Terminal closed due to inactivity.')
            this.cleanup(runtime.terminalId)
        }, this.idleTimeoutMs)
    }

    private cleanup(terminalId: string): void {
        const runtime = this.terminals.get(terminalId)
        if (!runtime) {
            return
        }

        this.terminals.delete(terminalId)
        if (runtime.idleTimer) {
            clearTimeout(runtime.idleTimer)
        }

        if (!runtime.proc.killed && runtime.proc.exitCode === null) {
            try {
                runtime.proc.kill()
            } catch (error) {
                logger.debug('[TERMINAL] Failed to kill process', { error })
            }
        }

        try {
            runtime.terminal.close()
        } catch (error) {
            logger.debug('[TERMINAL] Failed to close terminal', { error })
        }
    }

    private emitError(terminalId: string, message: string): void {
        this.onError({ ...this.scopePayload(), terminalId, message })
    }

    private scopePayload(): { sessionId: string } | { machineId: string } {
        if (this.sessionId) {
            return { sessionId: this.sessionId }
        }
        if (this.machineId) {
            return { machineId: this.machineId }
        }
        throw new Error('TerminalManager scope is not configured')
    }
}

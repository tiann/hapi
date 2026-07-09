import { logger } from '@/ui/logger'
import { getInvokedCwd } from '@/utils/invokedCwd'
import type {
    TerminalErrorPayload,
    TerminalExitPayload,
    TerminalOutputPayload,
    TerminalReadyPayload
} from '@hapi/protocol'
import type { TerminalSession } from './types'
import { spawnNativeTerminal } from '@/native/terminal'

type TerminalRuntime = TerminalSession & {
    proc: {
        killed: boolean
        exitCode: number | null
        signalCode?: NodeJS.Signals | null
        kill: () => unknown
    }
    terminal: {
        write: (data: string) => void
        resize: (cols: number, rows: number) => void
        close: () => void
    }
    idleTimer: ReturnType<typeof setTimeout> | null
    killProcessOnCleanup: boolean
}

type TerminalManagerOptions = {
    sessionId: string
    getSessionPath: () => string | null
    onReady: (payload: TerminalReadyPayload) => void
    onOutput: (payload: TerminalOutputPayload) => void
    onExit: (payload: TerminalExitPayload) => void
    onError: (payload: TerminalErrorPayload) => void
    idleTimeoutMs?: number
    maxTerminals?: number
}

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000
const DEFAULT_MAX_TERMINALS = 4
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

function getOptionalBun(): typeof Bun | null {
    return typeof Bun === 'undefined' ? null : Bun
}

function resolveEnvNumber(name: string, fallback: number): number {
    const raw = process.env[name]
    if (!raw) {
        return fallback
    }
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function resolveWindowsShellCommand(): string[] {
    const configuredShell = process.env.HAPI_TERMINAL_SHELL?.trim()
    if (configuredShell) {
        return [configuredShell]
    }

    const bun = getOptionalBun()
    const candidates = ['pwsh.exe', 'powershell.exe']
    for (const candidate of candidates) {
        try {
            const resolved = bun?.which?.(candidate)
            if (resolved) {
                return [resolved, '-NoLogo']
            }
        } catch {
            // Ignore PATH lookup failures and try the next fallback.
        }
    }

    return [process.env.ComSpec || 'cmd.exe']
}

export function resolveShellCommand(): string[] {
    if (process.platform === 'win32') {
        return resolveWindowsShellCommand()
    }
    if (process.env.SHELL) {
        return [process.env.SHELL]
    }
    if (process.platform === 'darwin') {
        return ['/bin/zsh']
    }
    return ['/bin/bash']
}

export function normalizeTerminalInputForHost(data: string): string {
    if (process.platform !== 'win32') {
        return data
    }

    let normalized = ''
    for (let index = 0; index < data.length; index += 1) {
        const char = data[index]
        if (char === '\n' && data[index - 1] !== '\r') {
            normalized += '\r'
        } else {
            normalized += char
        }
    }
    return normalized
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
        env.LANG = process.platform === 'darwin' || process.platform === 'win32' ? 'en_US.UTF-8' : 'C.UTF-8'
    }
    return env
}

export class TerminalManager {
    private readonly sessionId: string
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
        this.sessionId = options.sessionId
        this.getSessionPath = options.getSessionPath
        this.onReady = options.onReady
        this.onOutput = options.onOutput
        this.onExit = options.onExit
        this.onError = options.onError
        this.idleTimeoutMs = options.idleTimeoutMs ?? resolveEnvNumber('HAPI_TERMINAL_IDLE_TIMEOUT_MS', DEFAULT_IDLE_TIMEOUT_MS)
        this.maxTerminals = options.maxTerminals ?? resolveEnvNumber('HAPI_TERMINAL_MAX_TERMINALS', DEFAULT_MAX_TERMINALS)
        this.filteredEnv = buildFilteredEnv()
    }

    create(terminalId: string, cols: number, rows: number): void {
        const existing = this.terminals.get(terminalId)
        if (existing) {
            existing.cols = cols
            existing.rows = rows
            existing.terminal.resize(cols, rows)
            this.markActivity(existing)
            this.onReady({ sessionId: this.sessionId, terminalId })
            return
        }

        if (this.terminals.size >= this.maxTerminals) {
            this.emitError(terminalId, `Too many terminals open (max ${this.maxTerminals}).`)
            return
        }

        const sessionPath = this.getSessionPath() ?? getInvokedCwd()
        const shellCommand = resolveShellCommand()
        const decoder = new TextDecoder()

        const nativeTerminal = spawnNativeTerminal({
            command: shellCommand[0],
            args: shellCommand.slice(1),
            cwd: sessionPath,
            cols,
            rows,
            env: this.filteredEnv,
            onReady: () => this.onReady({ sessionId: this.sessionId, terminalId }),
            onOutput: (data) => {
                this.onOutput({ sessionId: this.sessionId, terminalId, data })
                const active = this.terminals.get(terminalId)
                if (active) {
                    this.markActivity(active)
                }
            },
            onError: (message) => this.emitError(terminalId, message)
        })
        if (nativeTerminal) {
            const runtime: TerminalRuntime = {
                terminalId,
                cols,
                rows,
                proc: nativeTerminal.process,
                terminal: nativeTerminal.terminal,
                idleTimer: null,
                killProcessOnCleanup: false
            }
            this.terminals.set(terminalId, runtime)
            this.markActivity(runtime)
            nativeTerminal.process.on('exit', (code, signal) => {
                this.onExit({
                    sessionId: this.sessionId,
                    terminalId,
                    code: code ?? null,
                    signal
                })
                this.cleanup(terminalId)
            })
            return
        }

        const bun = getOptionalBun()
        if (!bun || typeof bun.spawn !== 'function') {
            this.emitError(terminalId, 'Terminal is unavailable in this runtime.')
            return
        }

        try {
            const proc = bun.spawn(shellCommand, {
                cwd: sessionPath,
                env: this.filteredEnv,
                terminal: {
                    cols,
                    rows,
                    data: (terminal, data) => {
                        const text = decoder.decode(data, { stream: true })
                        if (text) {
                            this.onOutput({ sessionId: this.sessionId, terminalId, data: text })
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
                        sessionId: this.sessionId,
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
                killProcessOnCleanup: true
            }

            this.terminals.set(terminalId, runtime)
            this.markActivity(runtime)
            this.onReady({ sessionId: this.sessionId, terminalId })
        } catch (error) {
            logger.debug('[TERMINAL] Failed to spawn terminal', { error })
            const message = process.platform === 'win32'
                && error instanceof Error
                && error.message.includes('terminal option is not supported')
                ? 'Remote terminal on Windows requires Bun 1.3.14 or newer.'
                : 'Failed to spawn terminal.'
            this.emitError(terminalId, message)
        }
    }

    write(terminalId: string, data: string): void {
        const runtime = this.terminals.get(terminalId)
        if (!runtime) {
            this.emitError(terminalId, 'Terminal not found.')
            return
        }
        runtime.terminal.write(normalizeTerminalInputForHost(data))
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

        if (runtime.killProcessOnCleanup && !runtime.proc.killed && runtime.proc.exitCode === null) {
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
        this.onError({ sessionId: this.sessionId, terminalId, message })
    }
}

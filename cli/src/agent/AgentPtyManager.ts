import { logger } from '@/ui/logger'

export type AgentPtyOptions = {
    command: string
    args?: string[]
    cwd?: string
    env?: Record<string, string>
    cols?: number
    rows?: number
    onData: (data: string) => void
    onExit?: (code: number | null, signal: string | null) => void
    onError?: (error: Error) => void
}

function getOptionalBun(): typeof Bun | null {
    return typeof Bun === 'undefined' ? null : Bun
}

export class AgentPtyManager {
    private proc: Bun.Subprocess | null = null
    private terminal: Bun.Terminal | null = null
    private _exitCode: number | null = null
    private _signalCode: string | null = null
    private _isRunning: boolean = false

    get exitCode(): number | null {
        return this._exitCode
    }

    get signalCode(): string | null {
        return this._signalCode
    }

    get isRunning(): boolean {
        return this._isRunning
    }

    spawn(opts: AgentPtyOptions): void {
        const bun = getOptionalBun()
        if (!bun || typeof bun.spawn !== 'function') {
            const err = new Error('Bun.spawn is unavailable in this runtime')
            opts.onError?.(err)
            return
        }

        const cmd = opts.command
        const args = opts.args ?? []
        const cwd = opts.cwd
        const decoder = new TextDecoder()

        try {
            this.proc = bun.spawn([cmd, ...args], {
                cwd,
                env: opts.env ?? process.env,
                terminal: {
                    cols: opts.cols ?? 80,
                    rows: opts.rows ?? 24,
                    data: (_terminal, data) => {
                        const text = decoder.decode(data, { stream: true })
                        if (text) {
                            opts.onData(text)
                        }
                    },
                },
                onExit: (subprocess, exitCode) => {
                    this._exitCode = exitCode
                    this._signalCode = subprocess.signalCode ?? null
                    this._isRunning = false
                    opts.onExit?.(this._exitCode, this._signalCode)
                },
            })

            this.terminal = this.proc.terminal ?? null
            if (!this.terminal) {
                try {
                    this.proc.kill()
                } catch (error) {
                    logger.debug('[AgentPtyManager] Failed to kill process after missing terminal', { error })
                }
                this.proc = null
                const err = new Error('Failed to attach terminal to spawned process')
                opts.onError?.(err)
                return
            }

            this._isRunning = true
        } catch (error) {
            logger.debug('[AgentPtyManager] Failed to spawn process', { error })
            this.proc = null
            this.terminal = null
            opts.onError?.(error instanceof Error ? error : new Error(String(error)))
        }
    }

    write(data: string): void {
        if (!this.terminal || !this._isRunning) {
            return
        }
        this.terminal.write(data)
    }

    resize(cols: number, rows: number): void {
        if (!this.terminal || !this._isRunning) {
            return
        }
        this.terminal.resize(cols, rows)
    }

    kill(): void {
        if (!this.proc || !this._isRunning) {
            return
        }

        if (!this.proc.killed && this.proc.exitCode === null) {
            try {
                this.proc.kill()
            } catch (error) {
                logger.debug('[AgentPtyManager] Failed to kill process', { error })
            }
        }

        if (this.terminal) {
            try {
                this.terminal.close()
            } catch (error) {
                logger.debug('[AgentPtyManager] Failed to close terminal', { error })
            }
        }

        this.terminal = null
        this._isRunning = false
    }
}

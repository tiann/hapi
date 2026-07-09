import { Buffer } from 'node:buffer'
import { spawn, type ChildProcess } from 'node:child_process'
import { nativeHelperPath } from './localHelper'
import { logger } from '@/ui/logger'

let loggedMissingHelper = false

export type NativeTerminal = {
    process: ChildProcess
    terminal: {
        write(data: string): void
        resize(cols: number, rows: number): void
        close(): void
    }
}

type NativeTerminalOptions = {
    command: string
    args: string[]
    cwd: string
    cols: number
    rows: number
    env: NodeJS.ProcessEnv
    onReady: () => void
    onOutput: (data: string) => void
    onError: (message: string) => void
}

function commandArgs(options: NativeTerminalOptions): string[] {
    return [
        'pty',
        'spawn',
        '--cwd',
        options.cwd,
        '--cols',
        String(options.cols),
        '--rows',
        String(options.rows),
        '--command',
        options.command,
        ...options.args.flatMap((arg) => ['--arg', arg])
    ]
}

function send(child: ChildProcess, line: string): void {
    if (!child.stdin || child.stdin.destroyed) return
    child.stdin.write(`${line}\n`)
}

function logMissingHelper(): void {
    if (loggedMissingHelper) return
    loggedMissingHelper = true
    logger.debug('[native] hapi-local not found; using TypeScript PTY fallback')
}

export function spawnNativeTerminal(options: NativeTerminalOptions): NativeTerminal | null {
    const helper = nativeHelperPath()
    if (!helper) {
        logMissingHelper()
        return null
    }

    const child = spawn(helper, commandArgs(options), {
        cwd: options.cwd,
        env: options.env,
        stdio: ['pipe', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''
    let ready = false

    const handleLine = (line: string) => {
        if (!line) return
        const [event, payload] = line.split('\t')
        if (event === 'ready') {
            ready = true
            options.onReady()
        } else if (event === 'data' && payload) {
            options.onOutput(Buffer.from(payload, 'base64').toString('utf8'))
        } else if (event === 'error' && payload) {
            options.onError(Buffer.from(payload, 'base64').toString('utf8'))
        }
    }

    child.stdout.on('data', (chunk) => {
        stdout += chunk.toString()
        let newline = stdout.indexOf('\n')
        while (newline !== -1) {
            handleLine(stdout.slice(0, newline).replace(/\r$/, ''))
            stdout = stdout.slice(newline + 1)
            newline = stdout.indexOf('\n')
        }
    })
    child.stderr.on('data', (chunk) => {
        stderr += chunk.toString()
    })
    child.once('error', (error) => {
        logger.debug('[native] hapi-local pty spawn failed', error.message)
        options.onError(error.message)
    })
    child.once('exit', () => {
        if (!ready) {
            const message = stderr.trim() || stdout.trim()
            if (message) {
                logger.debug('[native] hapi-local pty exited before ready', message)
                options.onError(message)
            }
        }
    })

    return {
        process: child,
        terminal: {
            write(data: string) {
                send(child, `write\t${Buffer.from(data).toString('base64')}`)
            },
            resize(cols: number, rows: number) {
                send(child, `resize\t${cols}\t${rows}`)
            },
            close() {
                send(child, 'close')
                child.stdin?.end()
            }
        }
    }
}

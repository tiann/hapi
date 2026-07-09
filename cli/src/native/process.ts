import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { nativeHelperPath } from './localHelper'
import { logger } from '@/ui/logger'

const execFileAsync = promisify(execFile)
let loggedMissingHelper = false

function errorOutput(error: unknown): string {
    const err = error as { stdout?: unknown; stderr?: unknown; message?: unknown }
    return [err.stderr, err.stdout, err.message]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .join('\n')
        .trim()
}

function spawnArgs(action: 'spawn-detached' | 'spawn-supervised', options: {
    command: string
    args: string[]
    cwd?: string
}): string[] {
    return [
        'process',
        action,
        ...(options.cwd ? ['--cwd', options.cwd] : []),
        '--command',
        options.command,
        ...options.args.flatMap((arg) => ['--arg', arg])
    ]
}

function logMissingHelper(): void {
    if (loggedMissingHelper) return
    loggedMissingHelper = true
    logger.debug('[native] hapi-local not found; using TypeScript process fallback')
}

export async function nativeSpawnDetached(options: {
    command: string
    args: string[]
    cwd?: string
    env?: NodeJS.ProcessEnv
}): Promise<number | null> {
    const helper = nativeHelperPath()
    if (!helper) {
        logMissingHelper()
        return null
    }

    try {
        const { stdout } = await execFileAsync(helper, spawnArgs('spawn-detached', options), {
            encoding: 'utf8',
            env: options.env
        })
        const parsed = JSON.parse(stdout) as { pid?: unknown }
        return typeof parsed.pid === 'number' && parsed.pid > 0 ? parsed.pid : null
    } catch (error) {
        const output = errorOutput(error)
        if (output.includes('unknown command') || output.includes('unknown process action')) {
            logger.debug('[native] hapi-local process spawn-detached unsupported; using TypeScript fallback', output)
            return null
        }
        throw new Error(output || 'Failed to spawn detached process')
    }
}

export async function nativeSpawnSupervised(options: {
    command: string
    args: string[]
    cwd?: string
    env?: NodeJS.ProcessEnv
}): Promise<{ pid: number; process: ChildProcess } | null> {
    const helper = nativeHelperPath()
    if (!helper) {
        logMissingHelper()
        return null
    }

    const child = spawn(helper, spawnArgs('spawn-supervised', options), {
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe']
    })

    return await new Promise((resolve, reject) => {
        let stdout = ''
        let stderr = ''
        let settled = false
        const finish = (value: { pid: number; process: ChildProcess } | null) => {
            if (settled) return
            settled = true
            resolve(value)
        }
        const fail = (error: Error) => {
            if (settled) return
            settled = true
            reject(error)
        }

        child.stdout?.on('data', (chunk) => {
            stdout += chunk.toString()
            const lineEnd = stdout.indexOf('\n')
            if (lineEnd === -1) return
            try {
                const parsed = JSON.parse(stdout.slice(0, lineEnd)) as { pid?: unknown }
                if (typeof parsed.pid === 'number' && parsed.pid > 0) {
                    finish({ pid: parsed.pid, process: child })
                } else {
                    fail(new Error('Native supervised spawn returned invalid pid'))
                }
            } catch (error) {
                fail(error instanceof Error ? error : new Error(String(error)))
            }
        })
        child.stderr?.on('data', (chunk) => {
            stderr += chunk.toString()
        })
        child.once('error', fail)
        child.once('exit', () => {
            if (settled) return
            const output = [stderr, stdout].filter(Boolean).join('\n')
            if (output.includes('unknown command') || output.includes('unknown process action')) {
                logger.debug('[native] hapi-local process spawn-supervised unsupported; using TypeScript fallback', output)
                finish(null)
                return
            }
            fail(new Error(output.trim() || 'Native supervised spawn exited before pid'))
        })
    })
}

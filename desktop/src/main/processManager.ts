import { app, shell } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ConsoleLogEntry, LauncherConfig, RuntimeState } from '../shared'
import { resolveCliApiToken } from './token'
import type { ConfigStore } from './configStore'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../..')

type MachineResponse = {
    machine?: {
        metadata?: {
            workspaceRoots?: string[]
        } | null
        runnerState?: {
            status?: string
        } | null
    }
}

type HapiCommand = {
    command: string
    argsPrefix: string[]
}

type ProcessManagerEvents = {
    state: [RuntimeState]
    log: [ConsoleLogEntry]
}

type TypedEventEmitter<TEvents extends Record<string, unknown[]>> = {
    on<TKey extends keyof TEvents>(event: TKey, listener: (...args: TEvents[TKey]) => void): EventEmitter
    off<TKey extends keyof TEvents>(event: TKey, listener: (...args: TEvents[TKey]) => void): EventEmitter
    emit<TKey extends keyof TEvents>(event: TKey, ...args: TEvents[TKey]): boolean
}

export class ProcessManager {
    private readonly emitter = new EventEmitter() as EventEmitter & TypedEventEmitter<ProcessManagerEvents>
    private hubProcess: ChildProcessWithoutNullStreams | null = null
    private lifecycleQueue: Promise<void> = Promise.resolve()
    private state: RuntimeState = {
        status: 'stopped',
        error: null,
        hubHealthy: false,
        runnerOnline: false,
        workspaceRootsSynced: false
    }
    private logSeq = 0

    constructor(private readonly configStore: ConfigStore) {}

    getState(): RuntimeState {
        return { ...this.state }
    }

    onState(listener: (state: RuntimeState) => void): () => void {
        this.emitter.on('state', listener)
        return () => this.emitter.off('state', listener)
    }

    onLog(listener: (entry: ConsoleLogEntry) => void): () => void {
        this.emitter.on('log', listener)
        return () => this.emitter.off('log', listener)
    }

    async start(): Promise<void> {
        await this.enqueueLifecycle(async () => {
            if (this.state.status === 'starting' || this.state.status === 'running' || this.state.status === 'stopping') {
                return
            }
            await this.startInternal()
        })
    }

    async stop(): Promise<void> {
        await this.enqueueLifecycle(async () => {
            if (this.state.status === 'stopped' || this.state.status === 'stopping') {
                return
            }
            await this.stopInternal()
        })
    }

    private async enqueueLifecycle(task: () => Promise<void>): Promise<void> {
        const run = this.lifecycleQueue.then(task, task)
        this.lifecycleQueue = run.catch(() => {})
        await run
    }

    private async startInternal(): Promise<void> {
        if (this.state.status === 'starting' || this.state.status === 'running') {
            return
        }

        this.setState({ status: 'starting', error: null, hubHealthy: false, runnerOnline: false, workspaceRootsSynced: false })
        const config = await this.configStore.read()
        const token = await resolveCliApiToken(this.configStore)
        const baseEnv = this.buildEnv(config, token)

        try {
            await this.stopManagedHub()
            if (await isHubHealthy(config.hubPort)) {
                throw new Error(`端口 ${config.hubPort} 已被占用`)
            }
            if (!await isPortAvailable(config.hubPort)) {
                throw new Error(`端口 ${config.hubPort} 已被占用`)
            }
            await this.runHapiCommand(['runner', 'start', ...workspaceRootArgs(config.workspaceRoots)], baseEnv, 'runner')
            this.startHubProcess(config, baseEnv)
            await this.waitForReady(config, token)
            this.setState({ status: 'running', error: null, hubHealthy: true, runnerOnline: true, workspaceRootsSynced: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : '启动失败'
            this.appendLog('system', `启动失败：${message}`)
            await this.cleanupAfterFailedStart(baseEnv)
            this.setState({ status: 'error', error: message, hubHealthy: false, runnerOnline: false, workspaceRootsSynced: false })
        }
    }

    private async stopInternal(): Promise<void> {
        if (this.state.status === 'stopped' || this.state.status === 'stopping') {
            return
        }
        this.setState({ status: 'stopping' })
        const config = await this.configStore.read()
        const token = await resolveCliApiToken(this.configStore)
        const env = this.buildEnv(config, token)
        await Promise.allSettled([
            this.stopManagedHub(),
            this.runHapiCommand(['runner', 'stop'], env, 'runner')
        ])
        this.setState({ status: 'stopped', error: null, hubHealthy: false, runnerOnline: false, workspaceRootsSynced: false })
    }

    async openWeb(): Promise<void> {
        const config = await this.configStore.read()
        const token = await resolveCliApiToken(this.configStore)
        const url = new URL(`http://127.0.0.1:${config.hubPort}`)
        url.searchParams.set('token', token)
        await shell.openExternal(url.toString())
    }

    clearLogs(): void {
        this.appendLog('system', '控制台已清空')
    }

    private setState(patch: Partial<RuntimeState>): void {
        this.state = { ...this.state, ...patch }
        this.emitter.emit('state', this.getState())
    }

    private appendLog(source: ConsoleLogEntry['source'], text: string): void {
        const entry: ConsoleLogEntry = {
            id: `${Date.now()}-${this.logSeq++}`,
            source,
            text,
            at: Date.now()
        }
        this.emitter.emit('log', entry)
    }

    private buildEnv(config: LauncherConfig, token: string): NodeJS.ProcessEnv {
        return {
            ...process.env,
            CLI_API_TOKEN: token,
            HAPI_API_URL: `http://127.0.0.1:${config.hubPort}`,
            HAPI_LISTEN_HOST: '127.0.0.1',
            HAPI_LISTEN_PORT: String(config.hubPort)
        }
    }

    private startHubProcess(config: LauncherConfig, env: NodeJS.ProcessEnv): void {
        const command = getHapiCommand()
        const args = [...command.argsPrefix, 'hub', '--host', '127.0.0.1', '--port', String(config.hubPort)]
        if (config.relayEnabled) {
            args.push('--relay')
        }

        this.appendLog('system', `$ hapi ${args.slice(command.argsPrefix.length).join(' ')}`)
        this.hubProcess = spawn(command.command, args, {
            env,
            windowsHide: true,
            stdio: 'pipe'
        })

        this.hubProcess.stdout.on('data', (chunk: Buffer) => this.appendProcessOutput('hub', chunk))
        this.hubProcess.stderr.on('data', (chunk: Buffer) => this.appendProcessOutput('hub', chunk))
        this.hubProcess.on('exit', (code, signal) => {
            this.appendLog('hub', `Hub exited: code=${code ?? 'null'} signal=${signal ?? 'null'}`)
            if (this.state.status === 'running') {
                this.setState({ status: 'error', error: 'Hub 已退出', hubHealthy: false })
            }
        })
        this.hubProcess.on('error', (error) => {
            this.appendLog('hub', `Hub process error: ${error.message}`)
        })
    }

    private async stopManagedHub(): Promise<void> {
        const proc = this.hubProcess
        if (!proc) {
            return
        }
        this.hubProcess = null
        await new Promise<void>((resolveStop) => {
            let resolved = false
            let exited = false
            const finish = () => {
                if (!resolved) {
                    resolved = true
                    resolveStop()
                }
            }
            proc.once('exit', () => {
                exited = true
                finish()
            })
            proc.kill('SIGTERM')
            setTimeout(() => {
                if (!exited) {
                    proc.kill('SIGKILL')
                }
                finish()
            }, 5000).unref()
        })
    }

    private async cleanupAfterFailedStart(env: NodeJS.ProcessEnv): Promise<void> {
        await Promise.allSettled([
            this.stopManagedHub(),
            this.runHapiCommand(['runner', 'stop'], env, 'runner')
        ])
    }

    private async runHapiCommand(args: string[], env: NodeJS.ProcessEnv, source: 'runner' | 'hub'): Promise<void> {
        const command = getHapiCommand()
        const fullArgs = [...command.argsPrefix, ...args]
        this.appendLog('system', `$ hapi ${args.join(' ')}`)
        await new Promise<void>((resolveRun, rejectRun) => {
            const child = spawn(command.command, fullArgs, {
                env,
                windowsHide: true,
                stdio: 'pipe'
            })
            child.stdout.on('data', (chunk: Buffer) => this.appendProcessOutput(source, chunk))
            child.stderr.on('data', (chunk: Buffer) => this.appendProcessOutput(source, chunk))
            child.on('error', rejectRun)
            child.on('exit', (code) => {
                if (code === 0) {
                    resolveRun()
                    return
                }
                rejectRun(new Error(`hapi ${args.join(' ')} exited with code ${code ?? 'unknown'}`))
            })
        })
    }

    private appendProcessOutput(source: 'hub' | 'runner', chunk: Buffer): void {
        const lines = chunk.toString('utf8').split(/\r?\n/).filter((line) => line.length > 0)
        for (const line of lines) {
            this.appendLog(source, redactSensitiveLogLine(line))
        }
    }

    private async waitForReady(config: LauncherConfig, token: string): Promise<void> {
        await waitFor(async () => {
            const healthy = await isHubHealthy(config.hubPort)
            if (healthy) {
                this.setState({ hubHealthy: true })
            }
            return healthy
        }, 30000, 'Hub 没有成功启动')

        const machineId = await readMachineId()
        await waitFor(async () => {
            if (!machineId) {
                return false
            }
            const machine = await getMachine(config.hubPort, token, machineId)
            const runnerOnline = machine?.machine?.runnerState?.status === 'running'
            const rootsSynced = workspaceRootsEqual(config.workspaceRoots, machine?.machine?.metadata?.workspaceRoots)
            this.setState({ runnerOnline, workspaceRootsSynced: rootsSynced })
            return runnerOnline && rootsSynced
        }, 60000, 'Runner 没有完成连接')
    }
}

function redactSensitiveLogLine(line: string): string {
    return line
        .replace(/([?&]token=)[^&\s]+/gi, '$1[REDACTED]')
        .replace(/(Token:\s*)\S+/gi, '$1[REDACTED]')
        .replace(/(CLI_API_TOKEN=)\S+/gi, '$1[REDACTED]')
}

function getHapiCommand(): HapiCommand {
    if (app.isPackaged) {
        const platformDir = process.platform === 'win32' ? 'win' : 'mac'
        const binaryName = process.platform === 'win32' ? 'hapi.exe' : 'hapi'
        return { command: join(process.resourcesPath, 'hapi-cli', platformDir, binaryName), argsPrefix: [] }
    }

    return {
        command: process.env.HAPI_DESKTOP_NODE_PATH || 'node',
        argsPrefix: [join(repoRoot, 'cli', 'bin', 'hapi.cjs')]
    }
}

function workspaceRootArgs(workspaceRoots: string[]): string[] {
    return workspaceRoots.flatMap((root) => ['--workspace-root', root])
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, timeoutMessage: string): Promise<void> {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
        if (await check()) {
            return
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
    }
    throw new Error(timeoutMessage)
}

async function isHubHealthy(port: number): Promise<boolean> {
    try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })
        return response.ok
    } catch {
        return false
    }
}

async function isPortAvailable(port: number): Promise<boolean> {
    return await new Promise<boolean>((resolveAvailable) => {
        const server = createServer()
        server.once('error', () => resolveAvailable(false))
        server.once('listening', () => {
            server.close(() => resolveAvailable(true))
        })
        server.listen(port, '127.0.0.1')
    })
}

async function readMachineId(): Promise<string | null> {
    try {
        const raw = await readFile(join(homedir(), '.hapi', 'settings.json'), 'utf8')
        const parsed = JSON.parse(raw) as { machineId?: unknown }
        return typeof parsed.machineId === 'string' ? parsed.machineId : null
    } catch {
        return null
    }
}

async function getMachine(port: number, token: string, machineId: string): Promise<MachineResponse | null> {
    try {
        const response = await fetch(`http://127.0.0.1:${port}/cli/machines/${encodeURIComponent(machineId)}`, {
            headers: { authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(1000)
        })
        if (!response.ok) {
            return null
        }
        return await response.json() as MachineResponse
    } catch {
        return null
    }
}

function workspaceRootsEqual(left: string[], right?: string[]): boolean {
    const expected = normalizeWorkspaceRoots(left ?? [])
    const actual = normalizeWorkspaceRoots(right ?? [])
    if (expected.length !== actual.length) {
        return false
    }
    return expected.every((value, index) => value === actual[index])
}

function normalizeWorkspaceRoots(values: string[]): string[] {
    return values
        .map((value) => {
            const normalized = resolve(value)
            return process.platform === 'win32' ? normalized.toLowerCase() : normalized
        })
        .sort()
}

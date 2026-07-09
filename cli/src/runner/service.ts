import { execFile } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { configuration } from '@/configuration'
import { readSettings, updateSettings } from '@/persistence'
import { nativeHelperPath } from '@/native/localHelper'
import { getHappyCliCommand, type HappyCliCommand } from '@/utils/spawnHappyCLI'
import { initializeToken } from '@/ui/tokenInit'
import { logger } from '@/ui/logger'

export const RUNNER_LAUNCHD_LABEL = 'com.hapi.runner'
export const RUNNER_SYSTEMD_UNIT = 'hapi-runner.service'

type ExecFileLike = (file: string, args: string[]) => Promise<{ stdout: string, stderr: string }>

interface RunnerServiceOptions {
    workspaceRoots?: string[]
    execFile?: ExecFileLike
}

interface RunnerServiceResult {
    servicePath: string
    status?: string
    persistedApiUrl: boolean
    persistedToken: boolean
}

interface NativeServiceResult {
    servicePath: string
    status?: string
}

const execFileAsync = promisify(execFile)
let loggedMissingNativeService = false

async function defaultExecFile(file: string, args: string[]): Promise<{ stdout: string, stderr: string }> {
    const result = await execFileAsync(file, args, { encoding: 'utf8' }) as { stdout?: string, stderr?: string }
    return {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? ''
    }
}

function commandText(file: string, args: string[]): string {
    return [file, ...args].join(' ')
}

function outputFromError(error: unknown): string {
    const err = error as { stdout?: unknown, stderr?: unknown, message?: unknown }
    const stdout = typeof err.stdout === 'string' ? err.stdout : ''
    const stderr = typeof err.stderr === 'string' ? err.stderr : ''
    const message = typeof err.message === 'string' ? err.message : ''
    return [stdout, stderr, message].filter(Boolean).join('\n').trim()
}

function isUnsupportedNativeHelper(output: string): boolean {
    return output.includes('unknown command') || output.includes('unknown service action')
}

async function runExternal(exec: ExecFileLike, file: string, args: string[], allowFailure = false): Promise<string> {
    try {
        const { stdout, stderr } = await exec(file, args)
        return [stdout, stderr].filter(Boolean).join('\n').trim()
    } catch (error) {
        const output = outputFromError(error)
        if (allowFailure) {
            return output
        }
        throw new Error(`${commandText(file, args)} failed${output ? `:\n${output}` : ''}`)
    }
}

function buildRunnerStartArgs(workspaceRoots?: string[]): string[] {
    const args = ['runner', 'start-sync']
    for (const workspaceRoot of workspaceRoots ?? []) {
        args.push('--workspace-root', workspaceRoot)
    }
    return args
}

function findExecutableOnPath(name: string): string | null {
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
        if (!dir.trim()) {
            continue
        }
        const candidate = join(isAbsolute(dir) ? dir : resolve(dir), name)
        try {
            accessSync(candidate, constants.X_OK)
            return candidate
        } catch {
            // keep searching
        }
    }
    return null
}

function serviceExecutableOverride(): string | null {
    const override = process.env.HAPI_SERVICE_EXECUTABLE?.trim()
    if (override && isAbsolute(override) && existsSync(override)) {
        return override
    }

    return findExecutableOnPath('hapi')
}

export function buildRunnerServiceCommand(workspaceRoots?: string[]): HappyCliCommand {
    const args = buildRunnerStartArgs(workspaceRoots)
    const executable = serviceExecutableOverride()
    if (executable) {
        return { command: executable, args }
    }
    return getHappyCliCommand(args)
}

function nativeServiceArgs(action: 'install' | 'uninstall' | 'status', command: HappyCliCommand): string[] {
    const args = [
        'service',
        action,
        '--home',
        homedir(),
        '--logs-dir',
        configuration.logsDir,
        '--command',
        command.command
    ]

    for (const arg of command.args) {
        args.push('--arg', arg)
    }

    return args
}

function parseNativeServiceResult(stdout: string): NativeServiceResult {
    const text = stdout.trim()
    if (!text) {
        throw new Error('Native service helper returned empty output')
    }
    const parsed = JSON.parse(text) as Partial<NativeServiceResult>
    if (typeof parsed.servicePath !== 'string') {
        throw new Error('Native service helper returned invalid servicePath')
    }
    if (parsed.status !== undefined && typeof parsed.status !== 'string') {
        throw new Error('Native service helper returned invalid status')
    }
    return {
        servicePath: parsed.servicePath,
        ...(parsed.status !== undefined ? { status: parsed.status } : {})
    }
}

async function runNativeService(
    exec: ExecFileLike,
    action: 'install' | 'uninstall' | 'status',
    command: HappyCliCommand
): Promise<NativeServiceResult | null> {
    const helper = nativeHelperPath()
    if (!helper) {
        if (!loggedMissingNativeService) {
            loggedMissingNativeService = true
            logger.debug('[native] hapi-local not found; using TypeScript service fallback')
        }
        return null
    }

    try {
        const { stdout } = await exec(helper, nativeServiceArgs(action, command))
        return parseNativeServiceResult(stdout)
    } catch (error) {
        const output = outputFromError(error)
        if (isUnsupportedNativeHelper(output)) {
            logger.debug(`[native] hapi-local service ${action} unsupported; using TypeScript fallback`, output)
            return null
        }
        throw new Error(`${helper} service ${action} failed${output ? `:\n${output}` : ''}`)
    }
}

function serviceEnvironment(): Record<string, string> {
    const env: Record<string, string> = {
        HAPI_DISABLE_VERSION_HANDOFF: '1'
    }

    env.HOME = process.env.HOME?.trim() || homedir()
    if (process.env.USER?.trim()) {
        env.USER = process.env.USER.trim()
    }
    if (process.env.SHELL?.trim()) {
        env.SHELL = process.env.SHELL.trim()
    }
    if (process.env.PATH?.trim()) {
        env.PATH = process.env.PATH.trim()
    }
    if (process.env.HAPI_HOME?.trim()) {
        env.HAPI_HOME = process.env.HAPI_HOME.trim()
    }

    return env
}

function escapeXml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;')
}

export function renderMacOSLaunchAgent(command: HappyCliCommand, logPath: string): string {
    const programArguments = [command.command, ...command.args]
        .map(arg => `        <string>${escapeXml(arg)}</string>`)
        .join('\n')
    const environment = Object.entries(serviceEnvironment())
        .map(([key, value]) => `        <key>${escapeXml(key)}</key>\n        <string>${escapeXml(value)}</string>`)
        .join('\n')

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${RUNNER_LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${programArguments}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${environment}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>${escapeXml(logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(logPath)}</string>
</dict>
</plist>
`
}

function systemdQuote(value: string): string {
    return `"${value
        .replaceAll('\\', '\\\\')
        .replaceAll('"', '\\"')
        .replaceAll('$', '\\$')}"`
}

function systemdExecArg(value: string): string {
    return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : systemdQuote(value)
}

function systemdEnvironmentLine(key: string, value: string): string {
    return `Environment=${systemdQuote(`${key}=${value}`)}`
}

export function renderSystemdUserUnit(command: HappyCliCommand): string {
    const execStart = [command.command, ...command.args]
        .map(systemdExecArg)
        .join(' ')
    const environment = Object.entries(serviceEnvironment())
        .map(([key, value]) => systemdEnvironmentLine(key, value))
        .join('\n')

    return `[Unit]
Description=HAPI Runner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
KillMode=process
ExecStart=${execStart}
Restart=on-failure
RestartSec=5
${environment}

[Install]
WantedBy=default.target
`
}

function macOSLaunchAgentPath(): string {
    return join(homedir(), 'Library', 'LaunchAgents', `${RUNNER_LAUNCHD_LABEL}.plist`)
}

function linuxSystemdUnitPath(): string {
    return join(homedir(), '.config', 'systemd', 'user', RUNNER_SYSTEMD_UNIT)
}

function macOSUserTarget(): string {
    const uid = process.getuid?.()
    if (typeof uid !== 'number') {
        throw new Error('Cannot determine current user id for launchctl')
    }
    return `gui/${uid}`
}

async function persistServiceConfig(): Promise<{ persistedApiUrl: boolean, persistedToken: boolean }> {
    await initializeToken()

    const settings = await readSettings()
    const envApiUrl = process.env.HAPI_API_URL?.trim()
    const envToken = process.env.CLI_API_TOKEN?.trim()
    const persistedApiUrl = Boolean(envApiUrl && settings.apiUrl !== envApiUrl)
    const persistedToken = Boolean(envToken && settings.cliApiToken !== envToken)

    if (persistedApiUrl || persistedToken) {
        await updateSettings(current => ({
            ...current,
            ...(envApiUrl ? { apiUrl: envApiUrl } : {}),
            ...(envToken ? { cliApiToken: envToken } : {})
        }))
    }

    return { persistedApiUrl, persistedToken }
}

export async function installRunnerService(options: RunnerServiceOptions = {}): Promise<RunnerServiceResult> {
    const { persistedApiUrl, persistedToken } = await persistServiceConfig()
    const command = buildRunnerServiceCommand(options.workspaceRoots)
    const exec = options.execFile ?? defaultExecFile

    const nativeResult = await runNativeService(exec, 'install', command)
    if (nativeResult) {
        return { ...nativeResult, persistedApiUrl, persistedToken }
    }

    if (process.platform === 'darwin') {
        const servicePath = macOSLaunchAgentPath()
        const logPath = join(configuration.logsDir, 'runner-service.log')
        await mkdir(dirname(servicePath), { recursive: true })
        await mkdir(configuration.logsDir, { recursive: true })
        await writeFile(servicePath, renderMacOSLaunchAgent(command, logPath), { mode: 0o644 })

        const target = macOSUserTarget()
        await runExternal(exec, 'launchctl', ['bootout', `${target}/${RUNNER_LAUNCHD_LABEL}`], true)
        await runExternal(exec, 'launchctl', ['bootstrap', target, servicePath])
        await runExternal(exec, 'launchctl', ['enable', `${target}/${RUNNER_LAUNCHD_LABEL}`], true)
        await runExternal(exec, 'launchctl', ['kickstart', '-k', `${target}/${RUNNER_LAUNCHD_LABEL}`])

        return { servicePath, persistedApiUrl, persistedToken }
    }

    if (process.platform === 'linux') {
        const servicePath = linuxSystemdUnitPath()
        await mkdir(dirname(servicePath), { recursive: true })
        await writeFile(servicePath, renderSystemdUserUnit(command), { mode: 0o644 })
        await runExternal(exec, 'systemctl', ['--user', 'daemon-reload'])
        await runExternal(exec, 'systemctl', ['--user', 'enable', '--now', RUNNER_SYSTEMD_UNIT])

        return { servicePath, persistedApiUrl, persistedToken }
    }

    throw new Error(`Runner auto-start service is not supported on ${process.platform} yet`)
}

export async function uninstallRunnerService(options: { execFile?: ExecFileLike } = {}): Promise<{ servicePath: string }> {
    const exec = options.execFile ?? defaultExecFile
    const command = buildRunnerServiceCommand()

    const nativeResult = await runNativeService(exec, 'uninstall', command)
    if (nativeResult) {
        return { servicePath: nativeResult.servicePath }
    }

    if (process.platform === 'darwin') {
        const servicePath = macOSLaunchAgentPath()
        const target = macOSUserTarget()
        await runExternal(exec, 'launchctl', ['bootout', `${target}/${RUNNER_LAUNCHD_LABEL}`], true)
        await rm(servicePath, { force: true })
        return { servicePath }
    }

    if (process.platform === 'linux') {
        const servicePath = linuxSystemdUnitPath()
        await runExternal(exec, 'systemctl', ['--user', 'disable', '--now', RUNNER_SYSTEMD_UNIT], true)
        await rm(servicePath, { force: true })
        await runExternal(exec, 'systemctl', ['--user', 'daemon-reload'], true)
        return { servicePath }
    }

    throw new Error(`Runner auto-start service is not supported on ${process.platform} yet`)
}

export async function getRunnerServiceStatus(options: { execFile?: ExecFileLike } = {}): Promise<string> {
    const exec = options.execFile ?? defaultExecFile
    const command = buildRunnerServiceCommand()

    const nativeResult = await runNativeService(exec, 'status', command)
    if (nativeResult) {
        return nativeResult.status ?? `Runner auto-start service is installed (${nativeResult.servicePath})`
    }

    if (process.platform === 'darwin') {
        const servicePath = macOSLaunchAgentPath()
        if (!existsSync(servicePath)) {
            return `Runner auto-start service is not installed (${servicePath})`
        }
        const target = macOSUserTarget()
        const output = await runExternal(exec, 'launchctl', ['print', `${target}/${RUNNER_LAUNCHD_LABEL}`], true)
        return output || `Runner auto-start service is installed (${servicePath})`
    }

    if (process.platform === 'linux') {
        const servicePath = linuxSystemdUnitPath()
        if (!existsSync(servicePath)) {
            return `Runner auto-start service is not installed (${servicePath})`
        }
        const output = await runExternal(exec, 'systemctl', ['--user', 'status', RUNNER_SYSTEMD_UNIT, '--no-pager'], true)
        return output || `Runner auto-start service is installed (${servicePath})`
    }

    return `Runner auto-start service is not supported on ${process.platform} yet`
}

import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { configuration, normalizeExtraHeaders } from '@/configuration'
import { readSettings } from '@/persistence'
import type { HappyCliCommand } from '@/utils/spawnHappyCLI'
import type { CommandDefinition } from './types'

const app = '/Applications/ChatGPT.app'
const codex = `${app}/Contents/Resources/codex-cli/bin/codex`
const label = 'com.hapi.chatgpt-desktop'
const flag = 'CODEX_APP_SERVER_USE_LOCAL_DAEMON'
// launchd clears both values at logout. Track ownership per login so removal
// does not undo a flag the user had already set before HAPI.
const ownerFlag = 'HAPI_CODEX_DESKTOP_DAEMON_FLAG_OWNER'
const launchctl = '/bin/launchctl'
const HELP = `Sync ChatGPT's Codex sessions with HAPI (experimental, macOS).
  hapi codex-desktop setup [--restart]   Install a per-user login agent and configure this login
  hapi codex-desktop remove [--restart]  Remove the setup without stopping the daemon

Uses /Applications/ChatGPT.app, the default ~/.codex directory, and saved
HAPI settings. Loaded desktop conversations appear automatically in HAPI.
Without --restart, reopen ChatGPT yourself. Run without sudo.`

// Used at login and for synchronous setup. Check the GUI launch environment, not
// the calling terminal's exports. Keep the flag off until the daemon is ready.
const prepareDaemon = `set -eu
check_env() {
    current=$(/bin/launchctl getenv "$1")
    if [ -n "$current" ] && [ "$current" != "$2" ]; then
        printf '%s conflicts with HAPI desktop setup in the GUI launch environment.\\n' "$1" >&2
        exit 1
    fi
}
check_env CODEX_HOME "$2"
check_env CODEX_CLI_PATH ''
check_env CODEX_APP_SERVER_FORCE_CLI 0
check_env CODEX_APP_SERVER_WS_URL ''
check_env ${flag} 1
(umask 077; /bin/mkdir -p "$2")
started=0
if [ "$3" = start-only ] || ! CODEX_HOME="$2" "$1" app-server daemon version >/dev/null 2>&1; then
    CODEX_HOME="$2" "$1" app-server daemon start
    started=1
fi
if [ ! -S "$2/app-server-control/app-server-control.sock" ]; then
    printf 'Codex did not expose its default local daemon socket.\\n' >&2
    exit 1
fi
if [ "$3" = start-only ]; then exit 0; fi
current=$(/bin/launchctl getenv ${flag})
if [ -z "$current" ]; then
    /bin/launchctl setenv ${flag} 1 ${ownerFlag} 1
fi
# If this launch started Codex, exit and let launchd abandon that process
# group before restarting the job as the sync worker. Removing the running
# sync worker must never kill a daemon started at login.
if [ "$started" -eq 1 ]; then exit 75; fi
# Use the selected HAPI profile, never ambient credentials from the GUI login.
unset CLI_API_TOKEN HAPI_API_URL HAPI_EXTRA_HEADERS_JSON
export CODEX_HOME="$2" HAPI_HOME="$3"
shift 3
# Compiled HAPI binaries can fail before JS starts at launchd's low soft limit.
ulimit -Sn 65536 2>/dev/null || true
exec "$@"`

// Ask the AppKit application to terminate normally; never signal or force-quit.
// Wait for exit before `open`, so Launch Services cannot just focus the old instance.
const quitChatGPT = `ObjC.import('AppKit');
const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.openai.codex');
for (let i = 0; i < apps.count; i++) {
    const app = apps.objectAtIndex(i);
    if (!app.isTerminated && !app.terminate) throw Error('ChatGPT did not accept the quit request');
}
for (let i = 0; i < 100; i++) {
    let active = false;
    for (let j = 0; j < apps.count; j++) active = active || !apps.objectAtIndex(j).isTerminated;
    if (!active) break;
    if (i === 99) throw Error('ChatGPT did not exit; quit and reopen it manually');
    delay(0.2);
}`

function xmlString(value: string): string {
    return `<string>${value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\r', '&#13;')}</string>`
}

function daemonArgs(codexHome: string): string[] {
    return ['-c', prepareDaemon, label, codex, codexHome]
}

const managedMarker = '<!-- Managed by hapi codex-desktop -->'
type SyncLaunch = HappyCliCommand & { hapiHome: string }

function desktopPlist(codexHome: string, sync: SyncLaunch): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
${managedMarker}
<plist version="1.0">
<dict>
    <key>Label</key>${xmlString(label)}
    <key>ProgramArguments</key>
    <array>
        ${['/bin/sh', ...daemonArgs(codexHome), sync.hapiHome, sync.command, ...sync.args].map(xmlString).join('\n        ')}
    </array>
    <key>LimitLoadToSessionType</key><string>Aqua</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
    <key>ThrottleInterval</key><integer>5</integer>
    <key>ExitTimeOut</key><integer>75</integer>
    <key>AbandonProcessGroup</key><true/>
</dict>
</plist>
`
}

type Run = (file: string, args: string[]) => Promise<string>
const exec = promisify(execFile)
const runCommand: Run = async (file, args) => (await exec(file, args, { timeout: 45_000 })).stdout.trim()

async function restartChatGPT(run: Run, operation: string): Promise<void> {
    try {
        await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', quitChatGPT])
        await run('/usr/bin/open', [app])
    } catch (error) {
        throw new Error(`${operation}, but ChatGPT could not be restarted. Quit and reopen it manually. ${errorDetail(error)}`)
    }
}

function errorCode(error: unknown): unknown {
    return error && typeof error === 'object' && 'code' in error ? error.code : undefined
}

function errorDetail(error: unknown): string {
    if (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string' && error.stderr.trim()) return error.stderr.trim()
    return error instanceof Error ? error.message : String(error)
}

async function readManagedFile(path: string, uid: number): Promise<string | null> {
    const stat = await lstat(path).catch((error: unknown) => {
        if (errorCode(error) === 'ENOENT') return null
        throw error
    })
    if (!stat) return null
    const foreign = new Error(`Refusing to change an unrecognized LaunchAgent: ${path}`)
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o022) !== 0) throw foreign
    const content = await readFile(path, 'utf8')
    if (!content.includes(`\n${managedMarker}\n`) || !content.includes(`<key>Label</key>${xmlString(label)}`)) throw foreign
    return content
}

export async function configureDesktop(action: 'setup' | 'remove', restart: boolean, user: { uid: number; homedir: string }, run: Run, sync?: SyncLaunch): Promise<string> {
    const domain = `gui/${user.uid}`
    const target = `${domain}/${label}`
    const agents = join(user.homedir, 'Library', 'LaunchAgents')
    const path = join(agents, `${label}.plist`)
    const codexHome = join(user.homedir, '.codex')
    const runInGui: Run = (file, args) => run(launchctl, ['asuser', String(user.uid), file, ...args])

    const installed = await readManagedFile(path, user.uid)
    if (await runInGui(launchctl, ['managername']).catch(() => '') !== 'Aqua') {
        throw new Error('No macOS GUI login session is available for this user. Run from the logged-in Mac without sudo.')
    }
    const loaded = await run(launchctl, ['print', target]).then(() => true, (error: unknown) => {
        if (errorCode(error) === 113) return false // launchctl: could not find service
        throw error
    })
    if (loaded && !installed) throw new Error(`A LaunchAgent named ${label} is already loaded without the HAPI configuration`)

    if (action === 'remove') {
        if (!installed) return 'No HAPI desktop setup is installed.'
        if (loaded) await run(launchctl, ['bootout', target])
        if (await runInGui(launchctl, ['getenv', ownerFlag]) === '1') {
            const current = await runInGui(launchctl, ['getenv', flag])
            await runInGui(launchctl, ['unsetenv', ...(current === '1' ? [flag] : []), ownerFlag])
        }
        await unlink(path)
        if (restart) await restartChatGPT(runInGui, 'Setup was removed')
        return `Desktop sync was removed. ${restart ? 'ChatGPT was reopened.' : 'Quit and reopen ChatGPT when ready.'} The running daemon was left intact.`
    }

    if (!sync) throw new Error('The desktop sync command was not configured')
    const plist = desktopPlist(codexHome, sync)
    if (installed && installed !== plist) throw new Error('Desktop sync is already installed for another HAPI profile or executable. Run hapi codex-desktop remove first.')
    // Fail before installing anything if the bundled CLI, daemon or existing GUI
    // environment is incompatible. The login agent can then repeat this preparation.
    await runInGui('/bin/sh', [...daemonArgs(codexHome), 'start-only'])
    if (!installed) {
        await mkdir(agents, { recursive: true })
        await writeFile(path, plist, { flag: 'wx', mode: 0o600 })
    }
    if (!loaded) {
        try {
            await run(launchctl, ['bootstrap', domain, path])
        } catch (error) {
            if (!installed) await unlink(path)
            throw error
        }
    }
    // RunAtLoad is asynchronous; before opening ChatGPT we need the flag now.
    const current = await runInGui(launchctl, ['getenv', flag])
    if (!current) await runInGui(launchctl, ['setenv', flag, '1', ownerFlag, '1'])
    else if (current !== '1') throw new Error(`${flag} conflicts with HAPI desktop setup in the GUI launch environment.`)

    if (restart) await restartChatGPT(runInGui, 'Setup is installed')
    return `HAPI desktop sync installed. ${restart ? 'ChatGPT was opened.' : 'Quit and reopen ChatGPT when ready.'}\n`
        + 'Open a Codex conversation in ChatGPT; it will appear automatically in HAPI.'
}

function settingsIdentity(settings: Awaited<ReturnType<typeof readSettings>>) {
    return {
        token: settings.cliApiToken ?? '',
        hub: settings.apiUrl || settings.serverUrl || 'http://localhost:3006',
        headers: JSON.stringify(Object.entries(normalizeExtraHeaders(settings.extraHeaders ?? {}, 'saved HAPI settings', () => {})).sort())
    }
}

async function requireSavedProfile() {
    const identity = settingsIdentity(await readSettings())
    if (!identity.token) throw new Error('Save your HAPI Hub credentials first with hapi auth login; desktop sync must work outside this terminal.')
    if (process.env.CLI_API_TOKEN && process.env.CLI_API_TOKEN !== identity.token
        || process.env.HAPI_API_URL && process.env.HAPI_API_URL !== identity.hub
        || process.env.HAPI_EXTRA_HEADERS_JSON !== undefined && JSON.stringify(Object.entries(configuration.extraHeaders).sort()) !== identity.headers) {
        throw new Error('Desktop sync uses saved HAPI settings. Save your Hub connection or remove the terminal-only HAPI overrides before setup.')
    }
    return identity
}

async function runDesktopSync(home: string): Promise<void> {
    const { initializeToken } = await import('@/ui/tokenInit')
    const { authAndSetupMachineIfNeeded } = await import('@/ui/auth')
    const { syncCodexDesktop } = await import('@/codex/shared/desktopSync')
    const { logger } = await import('@/ui/logger')
    const abort = new AbortController()
    const stop = () => abort.abort()
    const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const
    for (const signal of signals) process.on(signal, stop)
    try {
        const initial = await requireSavedProfile()
        await initializeToken()
        await authAndSetupMachineIfNeeded()
        await syncCodexDesktop(process.env.CODEX_HOME || join(home, '.codex'), abort.signal, async () => {
            const current = settingsIdentity(await readSettings())
            if (current.token !== initial.token || current.hub !== initial.hub || current.headers !== initial.headers) {
                throw new Error('Saved HAPI connection changed; restarting desktop sync')
            }
        })
    } catch (error) {
        logger.debug(`[Codex Desktop] ${errorDetail(error)}`)
        throw error
    } finally {
        for (const signal of signals) process.off(signal, stop)
    }
}

export const codexDesktopCommand: CommandDefinition = {
    name: 'codex-desktop',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        if (commandArgs.length === 0 || commandArgs.includes('--help') || commandArgs.includes('-h')) return console.log(HELP)
        try {
            const [action, option, ...rest] = commandArgs
            if (action !== 'setup' && action !== 'remove' && action !== '_sync' || rest.length || option !== undefined && (option !== '--restart' || action === '_sync')) {
                throw new Error(HELP)
            }
            if (process.platform !== 'darwin' || process.getuid?.() === 0) throw new Error('Run hapi codex-desktop on macOS as your logged-in user, without sudo.')
            const user = userInfo()
            if (action === '_sync') return await runDesktopSync(user.homedir)
            let sync: SyncLaunch | undefined
            if (action === 'setup') {
                await access(codex, constants.X_OK).catch(() => {
                    throw new Error(`Compatible ChatGPT bundled Codex CLI not found: ${codex}`)
                })
                await requireSavedProfile()
                const { getHappyCliCommand } = await import('@/utils/spawnHappyCLI')
                sync = { ...getHappyCliCommand(['codex-desktop', '_sync']), hapiHome: resolve(configuration.happyHomeDir) }
            }
            console.log(await configureDesktop(action, option === '--restart', user, runCommand, sync))
        } catch (error) {
            console.error(errorDetail(error))
            process.exitCode = 1
        }
    }
}

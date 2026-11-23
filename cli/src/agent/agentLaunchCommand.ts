import { accessSync, existsSync, readFileSync, statSync } from 'node:fs'
import { constants } from 'node:fs'
import { delimiter, posix, win32 } from 'node:path'
import type { AgentFlavor } from '@hapi/protocol'

type LaunchEnvironment = Record<string, string | undefined>

const DEFAULT_COMMANDS: Record<AgentFlavor, string> = {
    agy: 'agy',
    claude: 'claude',
    codex: 'codex',
    copilot: 'copilot',
    cursor: 'agent',
    dsh: 'dsh',
    gemini: 'gemini',
    grok: 'grok',
    kimi: 'kimi',
    opencode: 'opencode',
    pi: 'pi',
}

/** Command source shared by availability preflight and agent launchers. */
export function getAgentLaunchCommand(
    flavor: AgentFlavor,
    env: LaunchEnvironment = process.env,
): string {
    if (flavor === 'claude') return env.HAPI_CLAUDE_PATH?.trim() || DEFAULT_COMMANDS.claude
    if (flavor === 'copilot') return env.COPILOT_CLI_PATH?.trim() || DEFAULT_COMMANDS.copilot
    if (flavor === 'dsh') return env.HAPI_DSH_ACP_COMMAND?.trim() || DEFAULT_COMMANDS.dsh
    return DEFAULT_COMMANDS[flavor]
}

export function executableCandidates(
    command: string,
    options: {
        platform?: NodeJS.Platform
        pathValue?: string
        pathExt?: string
        cwd?: string
    } = {},
): string[] {
    const platform = options.platform ?? process.platform
    const isWindows = platform === 'win32'
    const pathApi = isWindows ? win32 : posix
    const cwd = options.cwd ?? process.cwd()
    const hasPathSeparator = command.includes('/') || command.includes('\\')
    const commandPath = pathApi.isAbsolute(command)
        ? command
        : hasPathSeparator
            ? pathApi.resolve(cwd, command)
            : null

    const extensions = isWindows && pathApi.extname(command) === ''
        ? (options.pathExt ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
            .split(';')
            .map((entry) => entry.trim())
            .filter(Boolean)
        : ['']

    if (commandPath) {
        return extensions.map((extension) => commandPath + extension)
    }

    const pathValue = options.pathValue ?? process.env.PATH ?? ''
    const pathDelimiter = isWindows ? ';' : delimiter
    return pathValue
        .split(pathDelimiter)
        // Windows accepts quoted PATH entries such as "C:\Program Files\npm".
        .map((directory) => isWindows ? directory.replace(/^"(.*)"$/, '$1') : directory)
        .filter(Boolean)
        .flatMap((directory) => extensions.map((extension) => pathApi.join(directory, command + extension)))
}

export function resolveExecutable(
    command: string,
    options: Parameters<typeof executableCandidates>[1] & {
        isExecutable?: (path: string) => boolean
    } = {},
): string | null {
    const platform = options.platform ?? process.platform
    const isExecutable = options.isExecutable ?? ((path: string) => {
        try {
            if (!existsSync(path) || !statSync(path).isFile()) return false
            if (platform !== 'win32') accessSync(path, constants.X_OK)
            return true
        } catch {
            return false
        }
    })

    return executableCandidates(command, options).find(isExecutable) ?? null
}

export type LaunchCommand = { command: string; args: string[] }

export type NodeShim = { script: string; node: string | null }

/**
 * What a Windows npm/pnpm `.cmd` shim runs, e.g.
 * `"%_prog%"  "%dp0%\\node_modules\\pkg\\cli.js" %*`. `node` is the interpreter
 * the shim names explicitly (pnpm), or null when it picks one at run time.
 */
export function parseNodeShimScript(shimPath: string, shim: string): NodeShim | null {
    const shimDir = win32.dirname(shimPath)
    const resolveShimPath = (path: string): string | null => {
        const relative = /^%~?dp0%?\\(.+)$/i.exec(path)
        if (relative) return win32.resolve(shimDir, relative[1])
        return win32.isAbsolute(path) ? win32.normalize(path) : null
    }
    const match = /(?:"([^"]+\.exe)"\s+)?"([^"]+\.[cm]?js)"\s+%\*/i.exec(shim)
    const script = match && resolveShimPath(match[2])
    if (!script) return null
    return { script, node: match[1] ? resolveShimPath(match[1]) : null }
}

/**
 * How to start a Node-based agent CLI without a shell. On Windows a `.cmd`
 * shim would run through cmd.exe, which also searches the working directory
 * for the shim and for `node`, cannot use a UNC working directory, and is the
 * process a kill reaches instead of the agent. So the shim's script is run with
 * node directly. Null when Windows has no runnable command; POSIX leaves lookup
 * to spawn.
 */
export function resolveNodeCliLaunch(
    command: string,
    env: LaunchEnvironment = process.env,
    platform: NodeJS.Platform = process.platform,
): LaunchCommand | null {
    if (platform !== 'win32') return { command, args: [] }
    const pathValue = env.PATH ?? env.Path
    const found = resolveExecutable(command, { platform, pathValue, pathExt: env.PATHEXT })
    if (!found) return null
    const executable = win32.resolve(found)
    if (!/\.(cmd|bat)$/i.test(executable)) return { command: executable, args: [] }

    let shim: NodeShim | null
    try {
        shim = parseNodeShimScript(executable, readFileSync(executable, 'utf8'))
    } catch {
        return null
    }
    if (!shim || !existsSync(shim.script)) return null
    const bundledNode = win32.join(win32.dirname(executable), 'node.exe')
    const node = [shim.node, bundledNode].find((path): path is string => !!path && existsSync(path))
        ?? resolveExecutable('node', { platform, pathValue, pathExt: '.EXE' })
    return node ? { command: win32.resolve(node), args: [shim.script] } : null
}

import { accessSync, existsSync, statSync } from 'node:fs'
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
    dsh: 'dsh-acp-demo',
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

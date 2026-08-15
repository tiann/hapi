import { readFile } from 'node:fs/promises'
import chalk from 'chalk'
import { SESSION_NAME_MAX_LENGTH } from '@hapi/protocol'
import { CREATABLE_AGENT_FLAVORS, type AgentFlavor, type PermissionMode } from '@hapi/protocol/modes'
import { PermissionModeSchema } from '@hapi/protocol/schemas'
import { initializeToken } from '@/ui/tokenInit'
import {
    SpawnPeerError,
    exitCodeForSpawnPeerError,
    spawnPeer
} from '@/modules/spawnPeer/spawnPeer'
import type { CommandDefinition } from './types'

type ParsedSpawnPeerArgs = {
    help: boolean
    directory?: string
    name?: string
    message?: string
    messageFile?: string
    agent?: AgentFlavor
    sessionType?: 'simple' | 'worktree'
    permissionMode?: PermissionMode
    waitActiveSecs?: number
}

function showHelp(): void {
    console.log(`
${chalk.bold('hapi spawn-peer')} - Spawn a HAPI session and deliver a required first message

${chalk.bold('Usage:')}
  hapi spawn-peer --dir PATH --name TITLE --message-file -
  hapi spawn-peer --dir PATH --name TITLE --message-file <path>
  hapi spawn-peer --dir PATH --name TITLE <message-text>

${chalk.bold('Notes:')}
  Machine spawn (POST /api/machines/:id/spawn) creates an empty composer.
  Do not put the remit in the spawn JSON - the hub 400s message/prompt/text.
  This command spawns, optionally renames, delivers via the ping-peer path,
  then exits non-zero if the new session still has no user message.
  Same hub token/namespace as this CLI. Prefer MCP spawn_peer in-session.

${chalk.bold('Options:')}
  --dir PATH              Working directory on this machine (required; relative paths resolve here, not in the runner)
  --name TITLE            Session display name (required, 1-255 chars)
  --message-file PATH|-   Remit text (or - for stdin)
  --agent NAME            Agent flavor (default: hub default, usually claude)
  --session-type TYPE     simple | worktree (default: simple; worktree creates a new tree from PATH)
  --permission-mode MODE  Operator-visible mode for the new session (not cloned from parent)
  --wait SECONDS          Active/verify timeout (default 60, or HAPI_WAIT_ACTIVE_SECS)

${chalk.bold('Env:')}
  HAPI_API_URL / CLI_API_TOKEN (or ~/.hapi/settings.json via \`hapi auth login\`)
  HAPI_WAIT_ACTIVE_SECS (default 60; overridable with --wait)
`)
}

export function parseSpawnPeerArgs(args: string[]): ParsedSpawnPeerArgs {
    const result: ParsedSpawnPeerArgs = {
        help: false
    }

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!
        if (arg === '--help' || arg === '-h') {
            result.help = true
            continue
        }
        if (arg === '--dir') {
            const value = args[++i]
            if (!value) {
                throw new SpawnPeerError('bad_args', '--dir requires a path')
            }
            result.directory = value
            continue
        }
        if (arg.startsWith('--dir=')) {
            const value = arg.slice('--dir='.length)
            if (!value) {
                throw new SpawnPeerError('bad_args', '--dir requires a path')
            }
            result.directory = value
            continue
        }
        if (arg === '--name') {
            const value = args[++i]
            if (!value) {
                throw new SpawnPeerError('bad_args', '--name requires a title')
            }
            result.name = value
            continue
        }
        if (arg.startsWith('--name=')) {
            const value = arg.slice('--name='.length)
            if (!value) {
                throw new SpawnPeerError('bad_args', '--name requires a title')
            }
            result.name = value
            continue
        }
        if (arg === '--message-file') {
            const value = args[++i]
            if (!value) {
                throw new SpawnPeerError('bad_args', '--message-file requires a path (or - for stdin)')
            }
            result.messageFile = value
            continue
        }
        if (arg.startsWith('--message-file=')) {
            const value = arg.slice('--message-file='.length)
            if (!value) {
                throw new SpawnPeerError('bad_args', '--message-file requires a path (or - for stdin)')
            }
            result.messageFile = value
            continue
        }
        if (arg === '--agent') {
            const value = args[++i]
            if (!value) {
                throw new SpawnPeerError('bad_args', '--agent requires a flavor')
            }
            result.agent = parseAgent(value)
            continue
        }
        if (arg.startsWith('--agent=')) {
            result.agent = parseAgent(arg.slice('--agent='.length))
            continue
        }
        if (arg === '--session-type') {
            const value = args[++i]
            if (!value) {
                throw new SpawnPeerError('bad_args', '--session-type requires simple or worktree')
            }
            result.sessionType = parseSessionType(value)
            continue
        }
        if (arg.startsWith('--session-type=')) {
            result.sessionType = parseSessionType(arg.slice('--session-type='.length))
            continue
        }
        if (arg === '--permission-mode') {
            const value = args[++i]
            if (!value) {
                throw new SpawnPeerError('bad_args', '--permission-mode requires a mode')
            }
            result.permissionMode = parsePermissionMode(value)
            continue
        }
        if (arg.startsWith('--permission-mode=')) {
            result.permissionMode = parsePermissionMode(arg.slice('--permission-mode='.length))
            continue
        }
        if (arg === '--wait') {
            const value = args[++i]
            if (!value) {
                throw new SpawnPeerError('bad_args', '--wait requires seconds')
            }
            result.waitActiveSecs = Number(value)
            continue
        }
        if (arg.startsWith('--wait=')) {
            result.waitActiveSecs = Number(arg.slice('--wait='.length))
            continue
        }
        if (arg.startsWith('-')) {
            throw new SpawnPeerError('bad_args', `unexpected flag: ${arg}`)
        }
        if (result.message === undefined) {
            result.message = arg
            continue
        }
        throw new SpawnPeerError('bad_args', `unexpected arg: ${arg}`)
    }

    if (result.waitActiveSecs !== undefined && (!Number.isFinite(result.waitActiveSecs) || result.waitActiveSecs <= 0)) {
        throw new SpawnPeerError('bad_args', '--wait must be a positive number of seconds')
    }

    return result
}

function parseAgent(value: string): AgentFlavor {
    if (!(CREATABLE_AGENT_FLAVORS as readonly string[]).includes(value)) {
        throw new SpawnPeerError(
            'bad_args',
            `unsupported --agent '${value}' (expected ${CREATABLE_AGENT_FLAVORS.join(', ')})`
        )
    }
    return value as AgentFlavor
}

function parseSessionType(value: string): 'simple' | 'worktree' {
    if (value !== 'simple' && value !== 'worktree') {
        throw new SpawnPeerError('bad_args', '--session-type must be simple or worktree')
    }
    return value
}

function parsePermissionMode(value: string): PermissionMode {
    const parsed = PermissionModeSchema.safeParse(value)
    if (!parsed.success) {
        throw new SpawnPeerError('bad_args', `unsupported --permission-mode '${value}'`)
    }
    return parsed.data
}

async function readMessage(parsed: ParsedSpawnPeerArgs): Promise<string> {
    if (parsed.messageFile !== undefined) {
        if (parsed.message !== undefined) {
            throw new SpawnPeerError('bad_args', 'provide message as an argument or --message-file, not both')
        }
        if (parsed.messageFile === '-') {
            const chunks: Buffer[] = []
            for await (const chunk of process.stdin) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
            }
            return Buffer.concat(chunks).toString('utf8')
        }
        return await readFile(parsed.messageFile, 'utf8')
    }
    return parsed.message ?? ''
}

function envWaitActiveSecs(): number | undefined {
    const raw = process.env.HAPI_WAIT_ACTIVE_SECS
    if (!raw) {
        return undefined
    }
    const value = Number(raw)
    if (!Number.isFinite(value) || value <= 0) {
        throw new SpawnPeerError('bad_args', 'HAPI_WAIT_ACTIVE_SECS must be a positive number')
    }
    return value
}

export async function handleSpawnPeerCommand(args: string[]): Promise<void> {
    const parsed = parseSpawnPeerArgs(args)
    if (parsed.help) {
        showHelp()
        return
    }

    if (!parsed.directory) {
        showHelp()
        throw new SpawnPeerError('bad_args', 'missing --dir; usage: hapi spawn-peer --dir PATH --name TITLE --message-file -')
    }
    const name = parsed.name?.trim() ?? ''
    if (!name || name.length > SESSION_NAME_MAX_LENGTH) {
        showHelp()
        throw new SpawnPeerError(
            'bad_args',
            `--name must be 1-${SESSION_NAME_MAX_LENGTH} characters`
        )
    }

    await initializeToken()

    const message = await readMessage(parsed)
    if (!message.trim()) {
        throw new SpawnPeerError(
            'bad_args',
            'missing message; provide as arg, --message-file PATH, or --message-file -'
        )
    }

    const result = await spawnPeer({
        directory: parsed.directory,
        message,
        name,
        agent: parsed.agent,
        sessionType: parsed.sessionType,
        permissionMode: parsed.permissionMode,
        waitActiveSecs: parsed.waitActiveSecs ?? envWaitActiveSecs(),
        onProgress: (line) => console.log(`hapi spawn-peer: ${line}`)
    })

    console.log(chalk.green(`hapi spawn-peer: OK ${result.sessionId}  name="${result.name}"`))
}

export const spawnPeerCommand: CommandDefinition = {
    name: 'spawn-peer',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        try {
            await handleSpawnPeerCommand(commandArgs)
        } catch (error) {
            if (error instanceof SpawnPeerError) {
                console.error(chalk.red('hapi spawn-peer:'), error.message)
                process.exit(exitCodeForSpawnPeerError(error))
            }
            console.error(
                chalk.red('hapi spawn-peer:'),
                error instanceof Error ? error.message : 'Unknown error'
            )
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}

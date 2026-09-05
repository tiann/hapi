import { readFile } from 'node:fs/promises'
import chalk from 'chalk'
import { SESSION_NAME_MAX_LENGTH } from '@hapi/protocol'
import { CREATABLE_AGENT_FLAVORS, type AgentFlavor, type PermissionMode } from '@hapi/protocol/modes'
import { PermissionModeSchema } from '@hapi/protocol/schemas'
import { initializeToken, TokenInitializationError } from '@/ui/tokenInit'
import {
    SpawnPeerError,
    exitCodeForSpawnPeerError,
    spawnPeer
} from '@/modules/spawnPeer/spawnPeer'
import type { CommandDefinition } from './types'

type ParsedSpawnPeerArgs = {
    help: boolean
    json: boolean
    directory?: string
    name?: string
    message?: string
    messageFile?: string
    agent?: AgentFlavor
    machineId?: string
    model?: string
    effort?: string
    sessionType?: 'simple' | 'worktree'
    permissionMode?: PermissionMode
    waitActiveSecs?: number
    remitId?: string
}

function showHelp(): void {
    console.log(`
${chalk.bold('hapi spawn-peer')} - Spawn a HAPI session and deliver a required first message

${chalk.bold('Usage:')}
  hapi spawn-peer --dir PATH --name TITLE --message-file -
  hapi spawn-peer --dir PATH --name TITLE --message-file <path>
  hapi spawn-peer --dir PATH --name TITLE <message-text>

${chalk.bold('Notes:')}
  The hub creates a fresh session and atomically delivers the remit.
  Failure cleans up the child and exits non-zero.

${chalk.bold('Options:')}
  --dir PATH              Absolute working directory on the selected machine (required)
  --name TITLE            Session display name (required, 1-255 chars)
  --message-file PATH|-   Remit text (or - for stdin)
  --agent NAME            Agent flavor (default: claude)
  --machine ID            Exact runner machine id (default: this CLI's machine)
  --model ID              Runtime model id
  --effort VALUE          Effort for Claude/Grok/Pi/AGY or reasoning effort for Codex/OpenCode
  --session-type TYPE     simple | worktree (default: simple; worktree creates a new tree from PATH)
  --permission-mode MODE  Operator-visible mode for the new session (not cloned from parent)
  --wait SECONDS          Ready/verify timeout (default 60, or HAPI_WAIT_ACTIVE_SECS)
  --remit-id UUID         Stable idempotency key for caller-managed retries
  --json                  Stable JSON output; progress is suppressed

${chalk.bold('Env:')}
  HAPI_API_URL / CLI_API_TOKEN (or ~/.hapi/settings.json via \`hapi auth login\`)
  HAPI_WAIT_ACTIVE_SECS (default 60; overridable with --wait)
`)
}

export function parseSpawnPeerArgs(args: string[]): ParsedSpawnPeerArgs {
    const result: ParsedSpawnPeerArgs = {
        help: false,
        json: false
    }

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!
        if (arg === '--help' || arg === '-h') {
            result.help = true
            continue
        }
        if (arg === '--json') {
            result.json = true
            continue
        }
        if (arg === '--dir') {
            const value = args[++i]
            if (!value || value.startsWith('-')) {
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
            if (!value || value.startsWith('--')) {
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
            if (!value || (value.startsWith('-') && value !== '-')) {
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
            if (!value || value.startsWith('-')) {
                throw new SpawnPeerError('bad_args', '--agent requires a flavor')
            }
            result.agent = parseAgent(value)
            continue
        }
        if (arg.startsWith('--agent=')) {
            result.agent = parseAgent(arg.slice('--agent='.length))
            continue
        }
        if (arg === '--machine' || arg === '--model' || arg === '--effort' || arg === '--remit-id') {
            const value = args[++i]
            if (!value || value.startsWith('-')) throw new SpawnPeerError('bad_args', `${arg} requires a value`)
            if (arg === '--machine') result.machineId = value
            if (arg === '--model') result.model = value
            if (arg === '--effort') result.effort = value
            if (arg === '--remit-id') result.remitId = value
            continue
        }
        if (arg.startsWith('--machine=')) {
            result.machineId = arg.slice('--machine='.length)
            continue
        }
        if (arg.startsWith('--model=')) {
            result.model = arg.slice('--model='.length)
            continue
        }
        if (arg.startsWith('--effort=')) {
            result.effort = arg.slice('--effort='.length)
            continue
        }
        if (arg.startsWith('--remit-id=')) {
            const value = arg.slice('--remit-id='.length)
            if (!value) throw new SpawnPeerError('bad_args', '--remit-id requires a value')
            result.remitId = value
            continue
        }
        if (arg === '--session-type') {
            const value = args[++i]
            if (!value || value.startsWith('-')) {
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
            if (!value || value.startsWith('-')) {
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
            if (!value || value.startsWith('-')) {
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

    if (result.waitActiveSecs !== undefined && (!Number.isFinite(result.waitActiveSecs) || result.waitActiveSecs <= 0 || result.waitActiveSecs > 300)) {
        throw new SpawnPeerError('bad_args', '--wait must be between 1 and 300 seconds')
    }
    if (result.machineId !== undefined && !result.machineId.trim()) throw new SpawnPeerError('bad_args', '--machine requires a value')
    if (result.model !== undefined && !result.model.trim()) throw new SpawnPeerError('bad_args', '--model requires a value')
    if (result.effort !== undefined && !result.effort.trim()) throw new SpawnPeerError('bad_args', '--effort requires a value')

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
    if (!Number.isFinite(value) || value <= 0 || value > 300) {
        throw new SpawnPeerError('bad_args', 'HAPI_WAIT_ACTIVE_SECS must be between 1 and 300')
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
        throw new SpawnPeerError('bad_args', 'missing --dir; usage: hapi spawn-peer --dir PATH --name TITLE --message-file -')
    }
    const name = parsed.name?.trim() ?? ''
    if (!name || name.length > SESSION_NAME_MAX_LENGTH) {
        throw new SpawnPeerError(
            'bad_args',
            `--name must be 1-${SESSION_NAME_MAX_LENGTH} characters`
        )
    }

    const message = await readMessage(parsed)
    if (!message.trim()) {
        throw new SpawnPeerError(
            'bad_args',
            'missing message; provide as arg, --message-file PATH, or --message-file -'
        )
    }
    const waitActiveSecs = parsed.waitActiveSecs ?? envWaitActiveSecs()

    await initializeToken({ interactive: !parsed.json })

    const result = await spawnPeer({
        directory: parsed.directory,
        message,
        name,
        agent: parsed.agent,
        machineId: parsed.machineId,
        model: parsed.model,
        effort: parsed.effort,
        sessionType: parsed.sessionType,
        permissionMode: parsed.permissionMode,
        waitActiveSecs,
        remitId: parsed.remitId,
        onProgress: parsed.json ? undefined : (line) => console.log(`hapi spawn-peer: ${line}`)
    })

    console.log(parsed.json
        ? JSON.stringify({ ok: true, ...result })
        : chalk.green(`hapi spawn-peer: OK ${result.sessionId}  name="${result.name}"`))
}

export const spawnPeerCommand: CommandDefinition = {
    name: 'spawn-peer',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        try {
            await handleSpawnPeerCommand(commandArgs)
        } catch (error) {
            if (error instanceof SpawnPeerError || error instanceof TokenInitializationError) {
                const output = commandArgs.includes('--json')
                    ? JSON.stringify({
                        ok: false,
                        ...(error instanceof SpawnPeerError && error.remitId ? { remitId: error.remitId } : {}),
                        error: { code: error.code, message: error.message }
                    })
                    : `${chalk.red('hapi spawn-peer:')} ${error.message}`
                commandArgs.includes('--json') ? console.log(output) : console.error(output)
                process.exit(error instanceof TokenInitializationError ? 2 : exitCodeForSpawnPeerError(error))
            }
            const output = commandArgs.includes('--json')
                ? JSON.stringify({ ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : 'Unknown error' } })
                : `${chalk.red('hapi spawn-peer:')} ${error instanceof Error ? error.message : 'Unknown error'}`
            commandArgs.includes('--json') ? console.log(output) : console.error(output)
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}

import { readFile } from 'node:fs/promises'
import chalk from 'chalk'
import { initializeToken } from '@/ui/tokenInit'
import {
    PingPeerError,
    exitCodeForPingPeerError,
    formatPeerSessionsList,
    listPeerSessions,
    peerListFetchLimit,
    pingPeer
} from '@/modules/pingPeer/pingPeer'
import type { CommandDefinition } from './types'

type ParsedPingPeerArgs = {
    help: boolean
    list: boolean
    sessionIdPrefix?: string
    message?: string
    messageFile?: string
    waitActiveSecs?: number
}

function showHelp(): void {
    console.log(`
${chalk.bold('hapi ping-peer')} - Resume a HAPI session (if needed) and send it a message

${chalk.bold('Usage:')}
  hapi ping-peer <session-id-prefix> <message-text>
  hapi ping-peer <session-id-prefix> --message-file <path>
  hapi ping-peer <session-id-prefix> --message-file -   # read message from stdin
  hapi ping-peer --list

${chalk.bold('Notes:')}
  Do not reinvent JWT + curl for peer handoffs. Prefer this command or MCP ping_peer / list_peers.
  Resolves by id prefix (8 chars OK). Same hub token/namespace as this CLI.
  Inactive sessions are resumed via POST /api/sessions/:id/resume, then messaged.
  When a user cites [title](/sessions/<id>) or Copy-reference
  See session "…" (/sessions/<id>) for context, pass that <id> here.
  On a remote runner, --list needs HAPI_API_URL set to the runner hub, plus
  CLI_API_TOKEN or \`hapi auth login\` for the token. Inside a session prefer MCP list_peers.

${chalk.bold('Env:')}
  HAPI_API_URL / CLI_API_TOKEN (or ~/.hapi/settings.json via \`hapi auth login\`)
  HAPI_WAIT_ACTIVE_SECS (default 60; overridable with --wait)
`)
}

export function parsePingPeerArgs(args: string[]): ParsedPingPeerArgs {
    const result: ParsedPingPeerArgs = {
        help: false,
        list: false
    }

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!
        if (arg === '--help' || arg === '-h') {
            result.help = true
            continue
        }
        if (arg === '--list') {
            result.list = true
            continue
        }
        if (arg === '--message-file') {
            const value = args[++i]
            if (!value) {
                throw new PingPeerError('bad_args', '--message-file requires a path (or - for stdin)')
            }
            result.messageFile = value
            continue
        }
        if (arg.startsWith('--message-file=')) {
            const value = arg.slice('--message-file='.length)
            if (!value) {
                throw new PingPeerError('bad_args', '--message-file requires a path (or - for stdin)')
            }
            result.messageFile = value
            continue
        }
        if (arg === '--wait') {
            const value = args[++i]
            if (!value) {
                throw new PingPeerError('bad_args', '--wait requires seconds')
            }
            result.waitActiveSecs = Number(value)
            continue
        }
        if (arg.startsWith('--wait=')) {
            result.waitActiveSecs = Number(arg.slice('--wait='.length))
            continue
        }
        if (arg.startsWith('-')) {
            throw new PingPeerError('bad_args', `unexpected flag: ${arg}`)
        }
        if (!result.sessionIdPrefix) {
            result.sessionIdPrefix = arg
            continue
        }
        if (result.message === undefined) {
            result.message = arg
            continue
        }
        throw new PingPeerError('bad_args', `unexpected arg: ${arg}`)
    }

    if (result.waitActiveSecs !== undefined && (!Number.isFinite(result.waitActiveSecs) || result.waitActiveSecs <= 0)) {
        throw new PingPeerError('bad_args', '--wait must be a positive number of seconds')
    }

    return result
}

async function readMessage(parsed: ParsedPingPeerArgs): Promise<string> {
    if (parsed.messageFile !== undefined) {
        if (parsed.message !== undefined) {
            throw new PingPeerError('bad_args', 'provide message as an argument or --message-file, not both')
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
        throw new PingPeerError('bad_args', 'HAPI_WAIT_ACTIVE_SECS must be a positive number')
    }
    return value
}

async function handleList(): Promise<void> {
    const maxRows = 30
    const sessions = await listPeerSessions({
        limit: peerListFetchLimit(maxRows)
    })
    console.log(formatPeerSessionsList(sessions, {
        maxRows,
        hasMore: sessions.length > maxRows
    }))
}

export async function handlePingPeerCommand(args: string[]): Promise<void> {
    const parsed = parsePingPeerArgs(args)
    if (parsed.help) {
        showHelp()
        return
    }

    await initializeToken()

    if (parsed.list) {
        await handleList()
        return
    }

    if (!parsed.sessionIdPrefix) {
        showHelp()
        throw new PingPeerError('bad_args', 'missing session id; usage: hapi ping-peer <session-id> <message>')
    }

    const message = await readMessage(parsed)
    if (!message) {
        throw new PingPeerError(
            'bad_args',
            'missing message; provide as arg, --message-file PATH, or --message-file -'
        )
    }

    const result = await pingPeer({
        sessionIdPrefix: parsed.sessionIdPrefix,
        message,
        waitActiveSecs: parsed.waitActiveSecs ?? envWaitActiveSecs(),
        onProgress: (line) => console.log(`hapi ping-peer: ${line}`)
    })

    console.log(chalk.green(`hapi ping-peer: OK - delivered to ${result.sessionId}`))
}

export const pingPeerCommand: CommandDefinition = {
    name: 'ping-peer',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        try {
            await handlePingPeerCommand(commandArgs)
        } catch (error) {
            if (error instanceof PingPeerError) {
                console.error(chalk.red('hapi ping-peer:'), error.message)
                process.exit(exitCodeForPingPeerError(error))
            }
            console.error(
                chalk.red('hapi ping-peer:'),
                error instanceof Error ? error.message : 'Unknown error'
            )
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}

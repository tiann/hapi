import chalk from 'chalk'
import { initializeToken } from '@/ui/tokenInit'
import {
    PingPeerError,
    exitCodeForPingPeerError,
    formatInspectPeerReport,
    inspectPeer
} from '@/modules/pingPeer/pingPeer'
import type { CommandDefinition } from './types'

type ParsedInspectPeerArgs = {
    help: boolean
    sessionIdPrefix?: string
    messageLimit?: number
}

function showHelp(): void {
    console.log(`
${chalk.bold('hapi inspect-peer')} - Read another HAPI session's metadata + recent messages

${chalk.bold('Usage:')}
  hapi inspect-peer <session-id-or-prefix>
  hapi inspect-peer <session-id-or-prefix> --limit 50

${chalk.bold('Notes:')}
  Read-only twin of ping-peer. Prefer this (or MCP inspect_peer) over JWT+curl.
  Resolves by id prefix (8 chars OK; full UUID best). Same hub token/namespace.
  Does NOT resume inactive sessions.
  When a user cites [title](/sessions/<id>) or Copy-reference
  See session "…" (/sessions/<id>) for context, pass that <id> here.
  /sessions/<id> is a hub path - not a local filesystem path.

${chalk.bold('Env:')}
  HAPI_API_URL / CLI_API_TOKEN (or ~/.hapi/settings.json via \`hapi auth login\`)
`)
}

export function parseInspectPeerArgs(args: string[]): ParsedInspectPeerArgs {
    const result: ParsedInspectPeerArgs = { help: false }

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!
        if (arg === '--help' || arg === '-h') {
            result.help = true
            continue
        }
        if (arg === '--limit') {
            const value = args[++i]
            if (!value) {
                throw new PingPeerError('bad_args', '--limit requires a number')
            }
            result.messageLimit = Number(value)
            continue
        }
        if (arg.startsWith('--limit=')) {
            result.messageLimit = Number(arg.slice('--limit='.length))
            continue
        }
        if (arg.startsWith('-')) {
            throw new PingPeerError('bad_args', `unexpected flag: ${arg}`)
        }
        if (!result.sessionIdPrefix) {
            result.sessionIdPrefix = arg
            continue
        }
        throw new PingPeerError('bad_args', `unexpected arg: ${arg}`)
    }

    if (result.messageLimit !== undefined && !Number.isFinite(result.messageLimit)) {
        throw new PingPeerError('bad_args', '--limit must be a number')
    }

    return result
}

export async function handleInspectPeerCommand(args: string[]): Promise<void> {
    const parsed = parseInspectPeerArgs(args)
    if (parsed.help) {
        showHelp()
        return
    }

    await initializeToken()

    if (!parsed.sessionIdPrefix) {
        showHelp()
        throw new PingPeerError('bad_args', 'missing session id; usage: hapi inspect-peer <session-id>')
    }

    const result = await inspectPeer({
        sessionIdPrefix: parsed.sessionIdPrefix,
        messageLimit: parsed.messageLimit
    })
    console.log(formatInspectPeerReport(result))
}

export const inspectPeerCommand: CommandDefinition = {
    name: 'inspect-peer',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        try {
            await handleInspectPeerCommand(commandArgs)
        } catch (error) {
            if (error instanceof PingPeerError) {
                console.error(chalk.red('hapi inspect-peer:'), error.message)
                process.exit(exitCodeForPingPeerError(error))
            }
            console.error(
                chalk.red('hapi inspect-peer:'),
                error instanceof Error ? error.message : 'Unknown error'
            )
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}

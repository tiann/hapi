import chalk from 'chalk'
import { initializeToken } from '@/ui/tokenInit'
import {
    ArchivePeerError,
    archivePeer,
    exitCodeForArchivePeerError
} from '@/modules/archivePeer/archivePeer'
import type { CommandDefinition } from './types'

type ParsedArchivePeerArgs = {
    help: boolean
    sessionIdPrefix?: string
}

function showHelp(): void {
    console.log(`
${chalk.bold('hapi archive-peer')} - Soft stand-down (archive) another HAPI session

${chalk.bold('Usage:')}
  hapi archive-peer <session-id-or-prefix>

${chalk.bold('Notes:')}
  Archive only — never hard-deletes. Prefer this (or MCP archive_peer) over JWT+curl.
  Resolves by id prefix (8 chars OK; full UUID best). Same hub token/namespace.
  Peer Done / idle workers should archive even when the hub previously 409'd
  on still_alive ghosts (tiann/hapi#2020). WORKING (thinking) peers still refuse.
  When a user cites [title](/sessions/<id>) or Copy-reference
  See session "…" (/sessions/<id>) for context, pass that <id> here.
  /sessions/<id> is a hub path - not a local filesystem path.

${chalk.bold('Env:')}
  HAPI_API_URL / CLI_API_TOKEN (or ~/.hapi/settings.json via \`hapi auth login\`)
`)
}

export function parseArchivePeerArgs(args: string[]): ParsedArchivePeerArgs {
    const result: ParsedArchivePeerArgs = { help: false }

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!
        if (arg === '--help' || arg === '-h') {
            result.help = true
            continue
        }
        if (arg.startsWith('-')) {
            throw new ArchivePeerError('bad_args', `unexpected flag: ${arg}`)
        }
        if (!result.sessionIdPrefix) {
            result.sessionIdPrefix = arg
            continue
        }
        throw new ArchivePeerError('bad_args', `unexpected arg: ${arg}`)
    }

    return result
}

export async function handleArchivePeerCommand(args: string[]): Promise<void> {
    const parsed = parseArchivePeerArgs(args)
    if (parsed.help) {
        showHelp()
        return
    }

    await initializeToken()

    if (!parsed.sessionIdPrefix) {
        showHelp()
        throw new ArchivePeerError('bad_args', 'missing session id; usage: hapi archive-peer <session-id>')
    }

    const result = await archivePeer({
        sessionIdPrefix: parsed.sessionIdPrefix,
        onProgress: (line) => console.log(`hapi archive-peer: ${line}`)
    })

    if (result.alreadyArchived) {
        console.log(chalk.green(`hapi archive-peer: OK - already archived ${result.sessionId} (${result.name})`))
        return
    }
    console.log(chalk.green(`hapi archive-peer: OK - archived ${result.sessionId} (${result.name})`))
}

export const archivePeerCommand: CommandDefinition = {
    name: 'archive-peer',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        try {
            await handleArchivePeerCommand(commandArgs)
        } catch (error) {
            if (error instanceof ArchivePeerError) {
                console.error(chalk.red('hapi archive-peer:'), error.message)
                process.exit(exitCodeForArchivePeerError(error))
            }
            console.error(
                chalk.red('hapi archive-peer:'),
                error instanceof Error ? error.message : 'Unknown error'
            )
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}

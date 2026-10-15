import chalk from 'chalk'
import { initializeToken } from '@/ui/tokenInit'
import {
    PingPeerError,
    exitCodeForPingPeerError,
    formatPeerSessionsList,
    peerListFetchLimit,
    searchPeerSessions
} from '@/modules/pingPeer/pingPeer'
import type { CommandDefinition } from './types'

type ParsedSearchPeersArgs = {
    help: boolean
    query?: string
    limit?: number
}

function showHelp(): void {
    console.log(`
${chalk.bold('hapi search-peers')} - Find HAPI sessions by keyword beyond list_peers recency

${chalk.bold('Usage:')}
  hapi search-peers <query>
  hapi search-peers <query> --limit 50

${chalk.bold('Notes:')}
  Searches name, summary/displayed title, path, and agentSessionId on the hub
  (namespace-scoped). Not bounded by "most recently updated N" — use this for
  quiet/aged sessions that fall out of MCP list_peers / \`hapi ping-peer --list\`.
  Output is dense (MCP-context friendly): legend then \`id a|i flavor title\` rows.
  When more matches exist than --limit, a short overflow footer is shown.
  Prefer MCP search_peers inside a session. Then inspect_peer / ping_peer by id.

${chalk.bold('Env:')}
  HAPI_API_URL / CLI_API_TOKEN (or ~/.hapi/settings.json via \`hapi auth login\`)
`)
}

export function parseSearchPeersArgs(args: string[]): ParsedSearchPeersArgs {
    const result: ParsedSearchPeersArgs = { help: false }

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
            result.limit = Number(value)
            continue
        }
        if (arg.startsWith('--limit=')) {
            result.limit = Number(arg.slice('--limit='.length))
            continue
        }
        if (arg.startsWith('-')) {
            throw new PingPeerError('bad_args', `unexpected flag: ${arg}`)
        }
        if (result.query === undefined) {
            result.query = arg
            continue
        }
        // Allow multi-word queries without forcing quotes when shell already splits.
        result.query = `${result.query} ${arg}`
    }

    if (result.limit !== undefined && (!Number.isFinite(result.limit) || result.limit < 1)) {
        throw new PingPeerError('bad_args', '--limit must be a positive number')
    }

    return result
}

export async function handleSearchPeersCommand(args: string[]): Promise<void> {
    const parsed = parseSearchPeersArgs(args)
    if (parsed.help) {
        showHelp()
        return
    }

    await initializeToken()

    const query = parsed.query?.trim() ?? ''
    if (!query) {
        showHelp()
        throw new PingPeerError('bad_args', 'missing query; usage: hapi search-peers <query>')
    }

    // Hub search max is 500; leave one slot for the overflow probe (same as
    // ping-peer --list). MCP page stays ≤100 separately.
    const MAX_CLI_PAGE = 499
    const limit = Math.min(MAX_CLI_PAGE, parsed.limit ?? 30)
    const sessions = await searchPeerSessions({
        query,
        limit: peerListFetchLimit(limit),
    })
    console.log(formatPeerSessionsList(sessions, {
        maxRows: limit,
        hasMore: sessions.length > limit,
        preserveOrder: true,
        dense: true,
        emptyMessage: `No peer sessions matched query '${query}'.`
    }))
}

export const searchPeersCommand: CommandDefinition = {
    name: 'search-peers',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        try {
            await handleSearchPeersCommand(commandArgs)
        } catch (error) {
            if (error instanceof PingPeerError) {
                console.error(chalk.red('hapi search-peers:'), error.message)
                process.exit(exitCodeForPingPeerError(error))
            }
            console.error(
                chalk.red('hapi search-peers:'),
                error instanceof Error ? error.message : 'Unknown error'
            )
            process.exit(1)
        }
    }
}

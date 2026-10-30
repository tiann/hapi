import chalk from 'chalk'
import { initializeToken } from '@/ui/tokenInit'
import {
    ActivityError,
    exitCodeForActivityError,
    fetchActivity,
    formatActivityReport,
    parseTimeArg
} from '@/modules/activity/activity'
import type { CommandDefinition } from './types'

type ParsedUsageArgs = {
    help: boolean
    json: boolean
    since?: string
    until?: string
}

function showHelp(): void {
    console.log(`
${chalk.bold('hapi usage')} - When agents were working, across every machine on this hub

${chalk.bold('Usage:')}
  hapi usage                      Last 24 hours
  hapi usage --since 7d
  hapi usage --since 2026-10-01 --until 2026-10-08
  hapi usage --json               Machine-readable (schema hapi.activity.v1)

${chalk.bold('Notes:')}
  A turn runs from the agent starting to think until it stops; waits for
  permission or answers are listed separately. Windows are at most 31 days.
  --since/--until take 30m, 24h, 7d, an ISO date or epoch milliseconds.

${chalk.bold('Exit codes:')}
  2 bad arguments · 3 not signed in or refused · 4 hub too old · 1 other

${chalk.bold('Env:')}
  HAPI_API_URL / CLI_API_TOKEN (or ~/.hapi/settings.json via \`hapi auth login\`)
`)
}

export function parseUsageArgs(args: string[]): ParsedUsageArgs {
    const result: ParsedUsageArgs = { help: false, json: false }
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!
        if (arg === '--help' || arg === '-h') {
            result.help = true
        } else if (arg === '--json') {
            result.json = true
        } else if (arg === '--since' || arg === '--until') {
            const value = args[++i]
            if (!value) throw new ActivityError('bad_args', `${arg} requires a value`)
            result[arg === '--since' ? 'since' : 'until'] = value
        } else if (arg.startsWith('--since=')) {
            result.since = arg.slice('--since='.length)
        } else if (arg.startsWith('--until=')) {
            result.until = arg.slice('--until='.length)
        } else {
            throw new ActivityError('bad_args', `unexpected argument: ${arg}`)
        }
    }
    return result
}

export async function handleUsageCommand(args: string[]): Promise<void> {
    const parsed = parseUsageArgs(args)
    if (parsed.help) {
        showHelp()
        return
    }
    const now = Date.now()
    const until = parsed.until ? parseTimeArg(parsed.until, now) : now
    const since = parsed.since ? parseTimeArg(parsed.since, now) : until - 24 * 60 * 60 * 1000

    try {
        await initializeToken()
    } catch (error) {
        throw new ActivityError('auth_failed', error instanceof Error ? error.message : String(error))
    }
    const report = await fetchActivity({ since, until })
    console.log(parsed.json ? JSON.stringify(report) : formatActivityReport(report))
}

export const usageCommand: CommandDefinition = {
    name: 'usage',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        try {
            await handleUsageCommand(commandArgs)
        } catch (error) {
            // Errors go to stderr so --json output on stdout stays parseable.
            if (error instanceof ActivityError) {
                console.error(chalk.red('hapi usage:'), error.message)
                process.exit(exitCodeForActivityError(error))
            }
            console.error(chalk.red('hapi usage:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}

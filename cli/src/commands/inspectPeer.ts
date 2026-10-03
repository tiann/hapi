import { cliT } from '@/i18n/cliI18n'
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
${chalk.bold('hapi inspect-peer')} - ${cliT('inspectPeer.help.tagline')}

${chalk.bold(cliT('inspectPeer.help.usage'))}
  hapi inspect-peer <session-id-or-prefix>
  hapi inspect-peer <session-id-or-prefix> --limit 50

${chalk.bold(cliT('inspectPeer.help.notes'))}
  ${cliT('inspectPeer.help.note1')}
  ${cliT('inspectPeer.help.note2')}
  ${cliT('inspectPeer.help.note3')}
  ${cliT('inspectPeer.help.note4')}
  ${cliT('inspectPeer.help.note5')}
  ${cliT('inspectPeer.help.note6')}

${chalk.bold(cliT('inspectPeer.help.env'))}
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
                error instanceof Error ? error.message : cliT('common.unknownError')
            )
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}

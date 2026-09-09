import chalk from 'chalk'
import { initializeToken, TokenInitializationError } from '@/ui/tokenInit'
import {
    PingPeerError,
    exitCodeForPingPeerError,
    formatInspectPeerReport,
    inspectPeer
} from '@/modules/pingPeer/pingPeer'
import type { CommandDefinition } from './types'

type ParsedInspectPeerArgs = {
    help: boolean
    json: boolean
    sessionId?: string
    messageLimit?: number
}

function showHelp(): void {
    console.log(`
${chalk.bold('hapi inspect-peer')} - Read one user-selected HAPI session

${chalk.bold('Usage:')}
  hapi inspect-peer <exact-session-id> [--limit 50] [--json]

Read-only. The exact session UUID must come from the user; prefixes are rejected.
`)
}

export function parseInspectPeerArgs(args: string[]): ParsedInspectPeerArgs {
    const result: ParsedInspectPeerArgs = { help: false, json: false }
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!
        if (arg === '--help' || arg === '-h') result.help = true
        else if (arg === '--json') result.json = true
        else if (arg === '--limit') {
            const value = args[++i]
            if (!value || value.startsWith('-')) throw new PingPeerError('bad_args', '--limit requires a number')
            result.messageLimit = Number(value)
        } else if (arg.startsWith('--limit=')) {
            result.messageLimit = Number(arg.slice('--limit='.length))
        } else if (arg.startsWith('-')) {
            throw new PingPeerError('bad_args', `unexpected flag: ${arg}`)
        } else if (!result.sessionId) {
            result.sessionId = arg
        } else {
            throw new PingPeerError('bad_args', `unexpected arg: ${arg}`)
        }
    }
    if (result.messageLimit !== undefined && (!Number.isInteger(result.messageLimit) || result.messageLimit < 1 || result.messageLimit > 100)) {
        throw new PingPeerError('bad_args', '--limit must be an integer between 1 and 100')
    }
    return result
}

export async function handleInspectPeerCommand(args: string[]): Promise<void> {
    const parsed = parseInspectPeerArgs(args)
    if (parsed.help) return showHelp()
    if (!parsed.sessionId) throw new PingPeerError('bad_args', 'exact session id is required')

    await initializeToken({ interactive: !parsed.json })
    const result = await inspectPeer({ sessionId: parsed.sessionId, messageLimit: parsed.messageLimit })
    console.log(parsed.json ? JSON.stringify({ ok: true, ...result }) : formatInspectPeerReport(result))
}

export const inspectPeerCommand: CommandDefinition = {
    name: 'inspect-peer',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        try {
            await handleInspectPeerCommand(commandArgs)
        } catch (error) {
            if (error instanceof PingPeerError || error instanceof TokenInitializationError) {
                const output = commandArgs.includes('--json')
                    ? JSON.stringify({ ok: false, error: { code: error.code, message: error.message } })
                    : `${chalk.red('hapi inspect-peer:')} ${error.message}`
                commandArgs.includes('--json') ? console.log(output) : console.error(output)
                process.exit(error instanceof TokenInitializationError ? 2 : exitCodeForPingPeerError(error))
            }
            const output = commandArgs.includes('--json')
                ? JSON.stringify({ ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : 'Unknown error' } })
                : `${chalk.red('hapi inspect-peer:')} ${error instanceof Error ? error.message : 'Unknown error'}`
            commandArgs.includes('--json') ? console.log(output) : console.error(output)
            process.exit(1)
        }
    }
}

import chalk from 'chalk'
import { initializeToken } from '@/ui/tokenInit'
import {
    PingPeerError,
    exitCodeForPingPeerError,
    setPeerPermissionMode
} from '@/modules/pingPeer/pingPeer'
import type { CommandDefinition } from './types'

type ParsedSetModeArgs = {
    help: boolean
    sessionIdPrefix?: string
    mode?: string
}

function showHelp(): void {
    console.log(`
${chalk.bold('hapi set-mode')} - Change the permission mode of an existing HAPI session

${chalk.bold('Usage:')}
  hapi set-mode <session-id-or-prefix> <mode>

${chalk.bold('Notes:')}
  Same as the web permission picker. Active sessions switch immediately;
  inactive sessions use the mode on their next resume.
  Allowed modes depend on the agent; an invalid mode prints the allowed list.
  Resolves by id prefix (8 chars OK). Same hub token/namespace as this CLI.

${chalk.bold('Env:')}
  HAPI_API_URL / CLI_API_TOKEN (or ~/.hapi/settings.json via \`hapi auth login\`)
`)
}

export function parseSetModeArgs(args: string[]): ParsedSetModeArgs {
    const result: ParsedSetModeArgs = { help: false }

    for (const arg of args) {
        if (arg === '--help' || arg === '-h') {
            result.help = true
            continue
        }
        if (arg.startsWith('-')) {
            throw new PingPeerError('bad_args', `unexpected flag: ${arg}`)
        }
        if (!result.sessionIdPrefix) {
            result.sessionIdPrefix = arg
            continue
        }
        if (!result.mode) {
            result.mode = arg
            continue
        }
        throw new PingPeerError('bad_args', `unexpected arg: ${arg}`)
    }

    return result
}

export async function handleSetModeCommand(args: string[]): Promise<void> {
    const parsed = parseSetModeArgs(args)
    if (parsed.help) {
        showHelp()
        return
    }

    if (!parsed.sessionIdPrefix || !parsed.mode) {
        showHelp()
        throw new PingPeerError('bad_args', 'usage: hapi set-mode <session-id> <mode>')
    }

    await initializeToken()

    const result = await setPeerPermissionMode({
        sessionIdPrefix: parsed.sessionIdPrefix,
        mode: parsed.mode
    })
    const when = result.active ? '' : ' (applies on next resume)'
    console.log(chalk.green(`hapi set-mode: OK - ${result.sessionId} (${result.flavor}) is now ${result.mode}${when}`))
}

export const setModeCommand: CommandDefinition = {
    name: 'set-mode',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        try {
            await handleSetModeCommand(commandArgs)
        } catch (error) {
            if (error instanceof PingPeerError) {
                console.error(chalk.red('hapi set-mode:'), error.message)
                process.exit(exitCodeForPingPeerError(error))
            }
            console.error(
                chalk.red('hapi set-mode:'),
                error instanceof Error ? error.message : 'Unknown error'
            )
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}

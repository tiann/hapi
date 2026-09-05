import chalk from 'chalk'
import { initializeToken, TokenInitializationError } from '@/ui/tokenInit'
import { controlPeer, PingPeerError, exitCodeForPingPeerError } from '@/modules/pingPeer/pingPeer'
import type { CommandDefinition } from './types'

type Action = 'abort' | 'stop' | 'archive' | 'delete'

async function handlePeerLifecycleCommand(args: string[], action: Action): Promise<void> {
    let sessionId: string | undefined
    let json = false
    for (const arg of args) {
        if (arg === '--help' || arg === '-h') {
            console.log(`Usage: hapi ${action}-peer <exact-session-id> [--json]`)
            return
        }
        if (arg === '--json') json = true
        else if (arg.startsWith('-')) throw new PingPeerError('bad_args', `unexpected flag: ${arg}`)
        else if (!sessionId) sessionId = arg
        else throw new PingPeerError('bad_args', `unexpected arg: ${arg}`)
    }
    if (!sessionId) throw new PingPeerError('bad_args', 'exact session id is required')

    await initializeToken({ interactive: !json })
    const result = await controlPeer({ sessionId, action })
    console.log(json
        ? JSON.stringify({ ok: true, ...result })
        : chalk.green(`hapi ${action}-peer: OK - ${result.sessionId}`))
}

function command(action: Action): CommandDefinition {
    return {
        name: `${action}-peer`,
        requiresRuntimeAssets: false,
        run: async ({ commandArgs }) => {
            try {
                await handlePeerLifecycleCommand(commandArgs, action)
            } catch (error) {
                const json = commandArgs.includes('--json')
                const code = error instanceof PingPeerError || error instanceof TokenInitializationError ? error.code : 'internal'
                const message = error instanceof Error ? error.message : 'Unknown error'
                const output = json
                    ? JSON.stringify({ ok: false, error: { code, message } })
                    : `${chalk.red(`hapi ${action}-peer:`)} ${message}`
                json ? console.log(output) : console.error(output)
                process.exit(error instanceof TokenInitializationError ? 2 : error instanceof PingPeerError ? exitCodeForPingPeerError(error) : 1)
            }
        }
    }
}

export const abortPeerCommand = command('abort')
export const stopPeerCommand = command('stop')
export const archivePeerCommand = command('archive')
export const deletePeerCommand = command('delete')

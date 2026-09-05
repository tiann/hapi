import chalk from 'chalk'
import { initializeToken, TokenInitializationError } from '@/ui/tokenInit'
import { PingPeerError, exitCodeForPingPeerError, waitPeer } from '@/modules/pingPeer/pingPeer'
import type { CommandDefinition } from './types'

export async function handleWaitPeerCommand(args: string[]): Promise<void> {
    let sessionId: string | undefined
    let remitId: string | undefined
    let timeoutSecs: number | undefined
    let json = false

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!
        if (arg === '--help' || arg === '-h') {
            console.log('Usage: hapi wait-peer <exact-session-id> --remit-id <uuid> [--timeout seconds] [--json]')
            return
        }
        if (arg === '--json') json = true
        else if (arg === '--remit-id') {
            const value = args[++i]
            if (!value || value.startsWith('-')) throw new PingPeerError('bad_args', '--remit-id requires a UUID')
            remitId = value
        }
        else if (arg.startsWith('--remit-id=')) remitId = arg.slice('--remit-id='.length)
        else if (arg === '--timeout') {
            const value = args[++i]
            if (!value || value.startsWith('-')) throw new PingPeerError('bad_args', '--timeout requires seconds')
            timeoutSecs = Number(value)
        }
        else if (arg.startsWith('--timeout=')) timeoutSecs = Number(arg.slice('--timeout='.length))
        else if (arg.startsWith('-')) throw new PingPeerError('bad_args', `unexpected flag: ${arg}`)
        else if (!sessionId) sessionId = arg
        else throw new PingPeerError('bad_args', `unexpected arg: ${arg}`)
    }
    if (!sessionId || !remitId) throw new PingPeerError('bad_args', 'exact session id and --remit-id are required')
    if (timeoutSecs !== undefined && (!Number.isFinite(timeoutSecs) || timeoutSecs <= 0 || timeoutSecs > 86_400)) {
        throw new PingPeerError('bad_args', '--timeout must be between 1 and 86400 seconds')
    }

    await initializeToken({ interactive: !json })
    const result = await waitPeer({ sessionId, remitId, timeoutSecs })
    console.log(json ? JSON.stringify({ ok: true, ...result }) : result.text)
}

export const waitPeerCommand: CommandDefinition = {
    name: 'wait-peer',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        try {
            await handleWaitPeerCommand(commandArgs)
        } catch (error) {
            if (error instanceof PingPeerError || error instanceof TokenInitializationError) {
                const output = commandArgs.includes('--json')
                    ? JSON.stringify({ ok: false, error: { code: error.code, message: error.message } })
                    : `${chalk.red('hapi wait-peer:')} ${error.message}`
                commandArgs.includes('--json') ? console.log(output) : console.error(output)
                process.exit(error instanceof TokenInitializationError ? 2 : exitCodeForPingPeerError(error))
            }
            const output = commandArgs.includes('--json')
                ? JSON.stringify({ ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : 'Unknown error' } })
                : `${chalk.red('hapi wait-peer:')} ${error instanceof Error ? error.message : 'Unknown error'}`
            commandArgs.includes('--json') ? console.log(output) : console.error(output)
            process.exit(1)
        }
    }
}

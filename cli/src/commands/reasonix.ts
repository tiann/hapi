import chalk from 'chalk'
import type { CommandDefinition } from './types'
import { REASONIX_PERMISSION_MODES } from '@hapi/protocol/modes'
import { parseRemoteAgentCommandOptions } from './agentCommandOptions'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { initializeToken } from '@/ui/tokenInit'
import { maybeAutoStartServer } from '@/utils/autoStartServer'

/** Launch Reasonix through its ACP stdio endpoint. Local TUI handoff is not
 * advertised yet because HAPI cannot mirror the native terminal transcript. */
export const reasonixCommand: CommandDefinition = {
    name: 'reasonix',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            const options = parseRemoteAgentCommandOptions(commandArgs, REASONIX_PERMISSION_MODES)
            options.startingMode = 'remote'

            await initializeToken()
            await maybeAutoStartServer()
            await authAndSetupMachineIfNeeded()

            const { runReasonix } = await import('@/reasonix/runReasonix')
            await runReasonix(options)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) console.error(error)
            process.exit(1)
        }
    }
}

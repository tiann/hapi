import chalk from 'chalk'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { initializeToken } from '@/ui/tokenInit'
import { maybeAutoStartServer } from '@/utils/autoStartServer'
import type { CommandDefinition } from './types'
import { AGY_PERMISSION_MODES } from '@hapi/protocol/modes'
import { parseRemoteAgentCommandOptions } from './agentCommandOptions'

export function parseAgyCommandOptions(commandArgs: string[]) {
    const options = parseRemoteAgentCommandOptions(
        commandArgs,
        AGY_PERMISSION_MODES,
        ['remote'],
    )
    return { ...options, startingMode: options.startingMode ?? 'remote' as const }
}

export const agyCommand: CommandDefinition = {
    name: 'agy',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            const options = parseAgyCommandOptions(commandArgs)

            await initializeToken()
            await maybeAutoStartServer()
            await authAndSetupMachineIfNeeded()

            const { runAgy } = await import('@/agy/runAgy')
            await runAgy(options)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}

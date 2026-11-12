import chalk from 'chalk'
import { initializeToken } from '@/ui/tokenInit'
import { maybeAutoStartServer } from '@/utils/autoStartServer'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { BERRY_PERMISSION_MODES } from '@hapi/protocol/modes'
import { parseRemoteAgentCommandOptions } from './agentCommandOptions'
import type { CommandDefinition } from './types'

export function parseBerryCommandOptions(commandArgs: string[]) {
    const options = parseRemoteAgentCommandOptions(commandArgs, BERRY_PERMISSION_MODES, ['remote'])
    if (options.effort || options.modelReasoningEffort) {
        throw new Error('Berry effort is configured by the Berry agent')
    }
    return { ...options, startingMode: 'remote' as const }
}

export const berryCommand: CommandDefinition = {
    name: 'berry',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            const options = parseBerryCommandOptions(commandArgs)
            await initializeToken()
            await maybeAutoStartServer()
            await authAndSetupMachineIfNeeded()

            const { runBerry } = await import('@/berry/runBerry')
            await runBerry(options)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) console.error(error)
            process.exit(1)
        }
    }
}

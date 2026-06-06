import chalk from 'chalk'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { initializeToken } from '@/ui/tokenInit'
import { maybeAutoStartServer } from '@/utils/autoStartServer'
import type { CommandDefinition } from './types'
import { PI_PERMISSION_MODES } from '@hapi/protocol/modes'
import { parseRemoteAgentCommandOptions } from './agentCommandOptions'

export const piCommand: CommandDefinition = {
    name: 'pi',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        try {
            const options = parseRemoteAgentCommandOptions(commandArgs, PI_PERMISSION_MODES)

            await initializeToken()
            await maybeAutoStartServer()
            await authAndSetupMachineIfNeeded()

            const { runPi } = await import('@/pi/runPi')
            await runPi(options)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}

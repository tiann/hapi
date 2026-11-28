import chalk from 'chalk'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { initializeToken } from '@/ui/tokenInit'
import { maybeAutoStartServer } from '@/utils/autoStartServer'
import type { CommandDefinition } from './types'
import { Flavors } from '@hapi/protocol/modes'
import { parseRemoteAgentCommandOptions } from './agentCommandOptions'

export const opencodeCommand: CommandDefinition = {
    name: 'opencode',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            const options = parseRemoteAgentCommandOptions(commandArgs, Flavors.opencode.permissionModes)

            await initializeToken()
            await maybeAutoStartServer()
            await authAndSetupMachineIfNeeded()

            const { runOpencode } = await import('@/opencode/runOpencode')
            await runOpencode(options)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}

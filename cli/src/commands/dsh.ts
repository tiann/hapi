import chalk from 'chalk'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { initializeToken } from '@/ui/tokenInit'
import { maybeAutoStartServer } from '@/utils/autoStartServer'
import type { CommandDefinition } from './types'
import { parseRemoteAgentCommandOptions } from './agentCommandOptions'

export const dshCommand: CommandDefinition = {
    name: 'dsh',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        try {
            // DSH permission presets are runtime-discovered from the host; pass
            // an empty allow-list so --permission-mode is rejected.
            const options = parseRemoteAgentCommandOptions(commandArgs, [])

            await initializeToken()
            await maybeAutoStartServer()
            await authAndSetupMachineIfNeeded()

            const { runDsh } = await import('@/dsh/runDsh')
            await runDsh(options)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}

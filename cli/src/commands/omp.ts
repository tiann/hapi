import chalk from 'chalk'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { initializeToken } from '@/ui/tokenInit'
import { maybeAutoStartServer } from '@/utils/autoStartServer'
import type { CommandDefinition } from './types'
import { parseRemoteAgentCommandOptions } from './agentCommandOptions'
import { OMP_PERMISSION_MODES } from '@hapi/protocol'

export const ompCommand: CommandDefinition = {
    name: 'omp',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        try {
            // OMP rpc mode has no runtime permission switching; `--approval-mode`
            // is fixed at spawn to `yolo`. Only `yolo` is offered.
            const options = parseRemoteAgentCommandOptions(commandArgs, OMP_PERMISSION_MODES)

            await initializeToken()
            await maybeAutoStartServer()
            await authAndSetupMachineIfNeeded()

            const { runOmp } = await import('@/omp/runOmp')
            await runOmp(options)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}

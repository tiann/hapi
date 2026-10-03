import { cliT } from '@/i18n/cliI18n'
import chalk from 'chalk'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { initializeToken } from '@/ui/tokenInit'
import { maybeAutoStartServer } from '@/utils/autoStartServer'
import type { CommandDefinition } from './types'
import { OPENCODE_PERMISSION_MODES } from '@hapi/protocol/modes'
import { parseRemoteAgentCommandOptions } from './agentCommandOptions'

export const opencodeCommand: CommandDefinition = {
    name: 'opencode',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            const options = parseRemoteAgentCommandOptions(commandArgs, OPENCODE_PERMISSION_MODES)

            await initializeToken()
            await maybeAutoStartServer()
            await authAndSetupMachineIfNeeded()

            const { runOpencode } = await import('@/opencode/runOpencode')
            await runOpencode(options)
        } catch (error) {
            console.error(chalk.red(cliT('common.error')), error instanceof Error ? error.message : cliT('common.unknownError'))
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}

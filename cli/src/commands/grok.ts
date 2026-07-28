import chalk from 'chalk'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { initializeToken } from '@/ui/tokenInit'
import { maybeAutoStartServer } from '@/utils/autoStartServer'
import type { CommandDefinition } from './types'
import { GROK_PERMISSION_MODES } from '@hapi/protocol/modes'
import { parseRemoteAgentCommandOptions } from './agentCommandOptions'

export const grokCommand: CommandDefinition = {
    name: 'grok',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            const hasExplicitPermissionMode = commandArgs.includes('--permission-mode')
            const normalizedArgs = hasExplicitPermissionMode
                ? commandArgs
                : commandArgs.flatMap((arg) => arg === '--yolo'
                    ? ['--permission-mode', 'bypassPermissions']
                    : [arg])
            const options = parseRemoteAgentCommandOptions(normalizedArgs, GROK_PERMISSION_MODES)

            await initializeToken()
            await maybeAutoStartServer()
            await authAndSetupMachineIfNeeded()

            const { runGrok } = await import('@/grok/runGrok')
            await runGrok(options)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) console.error(error)
            process.exit(1)
        }
    }
}

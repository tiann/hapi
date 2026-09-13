import chalk from 'chalk'
import { initializeToken } from '@/ui/tokenInit'
import { maybeAutoStartServer } from '@/utils/autoStartServer'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { parseRemoteAgentCommandOptions } from './agentCommandOptions'
import type { CommandDefinition } from './types'

export function parseDshCommandOptions(commandArgs: string[]) {
    const options = parseRemoteAgentCommandOptions(commandArgs, [], ['remote'])
    if (commandArgs.includes('--yolo')) {
        throw new Error('DeepSeek Harness permission policy is configured by the ACP server')
    }
    if (options.resumeSessionId) {
        throw new Error('DeepSeek Harness ACP only supports fresh sessions; resume is unavailable')
    }
    if (options.model || options.effort || options.modelReasoningEffort) {
        throw new Error('DeepSeek Harness model and effort are configured by the ACP server')
    }
    return { ...options, startingMode: 'remote' as const }
}

export const dshCommand: CommandDefinition = {
    name: 'dsh',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            const options = parseDshCommandOptions(commandArgs)
            await initializeToken()
            await maybeAutoStartServer()
            await authAndSetupMachineIfNeeded()

            const { runDsh } = await import('@/dsh/runDsh')
            await runDsh(options)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) console.error(error)
            process.exit(1)
        }
    }
}

import chalk from 'chalk'
import { initializeToken } from '@/ui/tokenInit'
import { maybeAutoStartServer } from '@/utils/autoStartServer'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { parseRemoteAgentCommandOptions } from './agentCommandOptions'
import type { CommandDefinition } from './types'

/**
 * dsh accepts the standard permission-mode flags: `read-only` and `yolo` map
 * onto the server's DSH_PERMISSION_MODE sandbox presets at spawn
 * (see utils/dshBackend); the other modes only shape HAPI-side auto-approval.
 */
export const DSH_PERMISSION_MODES = ['default', 'read-only', 'safe-yolo', 'yolo'] as const

export function parseDshCommandOptions(commandArgs: string[]) {
    const options = parseRemoteAgentCommandOptions(commandArgs, DSH_PERMISSION_MODES, ['remote'])
    if (options.effort || options.modelReasoningEffort) {
        throw new Error('DeepSeek Harness effort is configured by the ACP server')
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

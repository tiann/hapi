import chalk from 'chalk'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { initializeToken } from '@/ui/tokenInit'
import { maybeAutoStartServer } from '@/utils/autoStartServer'
import type { CommandDefinition } from './types'
import { GROK_PERMISSION_MODES } from '@hapi/protocol/modes'
import { parseRemoteAgentCommandOptions } from './agentCommandOptions'
import { applyProviderSelection } from '@/host/applyProviderSelection'

export const grokCommand: CommandDefinition = {
    name: 'grok',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            let providerProfileId: string | null | undefined
            const argsWithoutProvider: string[] = []
            for (let index = 0; index < commandArgs.length; index += 1) {
                const arg = commandArgs[index]
                if (arg === '--hapi-provider') {
                    const value = commandArgs[++index]
                    if (!value) throw new Error('Missing --hapi-provider value')
                    providerProfileId = value === 'system' ? null : value
                    continue
                }
                argsWithoutProvider.push(arg)
            }
            const hasExplicitPermissionMode = argsWithoutProvider.includes('--permission-mode')
            const normalizedArgs = hasExplicitPermissionMode
                ? argsWithoutProvider
                : argsWithoutProvider.flatMap((arg) => arg === '--yolo'
                    ? ['--permission-mode', 'bypassPermissions']
                    : [arg])
            const options = parseRemoteAgentCommandOptions(normalizedArgs, GROK_PERMISSION_MODES)

            await initializeToken()
            await maybeAutoStartServer()
            await authAndSetupMachineIfNeeded()
            const providerLaunch = await applyProviderSelection('grok', providerProfileId)
            if (!options.model && providerLaunch?.defaultModel) options.model = providerLaunch.defaultModel

            const { runGrok } = await import('@/grok/runGrok')
            await runGrok(options)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) console.error(error)
            process.exit(1)
        }
    }
}

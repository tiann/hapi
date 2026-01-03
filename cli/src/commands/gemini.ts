import chalk from 'chalk'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { initializeToken } from '@/ui/tokenInit'
import { maybeAutoStartServer } from '@/utils/autoStartServer'
import type { CommandDefinition } from './types'

export const geminiCommand: CommandDefinition = {
    name: 'gemini',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            let startedBy: 'daemon' | 'terminal' | undefined
            let yolo = false

            for (let i = 0; i < commandArgs.length; i++) {
                if (commandArgs[i] === '--started-by') {
                    startedBy = commandArgs[++i] as 'daemon' | 'terminal'
                } else if (commandArgs[i] === '--yolo') {
                    yolo = true
                }
            }

            const { registerGeminiAgent } = await import('@/agent/runners/gemini')
            const { runAgentSession } = await import('@/agent/runners/runAgentSession')
            registerGeminiAgent(yolo)

            await initializeToken()
            await maybeAutoStartServer()
            await authAndSetupMachineIfNeeded()
            await runAgentSession({ agentType: 'gemini', startedBy })
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}

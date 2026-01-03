import chalk from 'chalk'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { initializeToken } from '@/ui/tokenInit'
import { maybeAutoStartServer } from '@/utils/autoStartServer'
import type { CommandDefinition } from './types'

export const codexCommand: CommandDefinition = {
    name: 'codex',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            const { runCodex } = await import('@/codex/runCodex')

            const options: {
                startedBy?: 'daemon' | 'terminal'
                codexArgs?: string[]
                permissionMode?: 'default' | 'read-only' | 'safe-yolo' | 'yolo'
            } = {}
            const unknownArgs: string[] = []

            for (let i = 0; i < commandArgs.length; i++) {
                const arg = commandArgs[i]
                if (arg === '--started-by') {
                    options.startedBy = commandArgs[++i] as 'daemon' | 'terminal'
                } else if (arg === '--yolo' || arg === '--dangerously-bypass-approvals-and-sandbox') {
                    options.permissionMode = 'yolo'
                    unknownArgs.push(arg)
                } else {
                    unknownArgs.push(arg)
                }
            }
            if (unknownArgs.length > 0) {
                options.codexArgs = unknownArgs
            }

            await initializeToken()
            await maybeAutoStartServer()
            await authAndSetupMachineIfNeeded()
            await runCodex(options)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}

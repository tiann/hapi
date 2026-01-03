import chalk from 'chalk'
import type { CommandDefinition } from './types'

export const serverCommand: CommandDefinition = {
    name: 'server',
    requiresRuntimeAssets: false,
    run: async () => {
        try {
            await import('../../../server/src/index')
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}

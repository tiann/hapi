import chalk from 'chalk'
import { handleAuthCommand } from './auth'
import type { CommandDefinition } from './types'

export const logoutCommand: CommandDefinition = {
    name: 'logout',
    requiresRuntimeAssets: true,
    run: async () => {
        console.log(chalk.yellow('Note: "hapi logout" is deprecated. Use "hapi auth logout" instead.\n'))
        try {
            await handleAuthCommand(['logout'])
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}

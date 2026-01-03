import chalk from 'chalk'
import type { CommandDefinition } from './types'

export const notifyCommand: CommandDefinition = {
    name: 'notify',
    requiresRuntimeAssets: true,
    run: async () => {
        console.error(chalk.red('The `hapi notify` command is not available in direct-connect mode.'))
        console.error(chalk.gray('Use Telegram notifications from hapi-server instead.'))
        process.exit(1)
    }
}

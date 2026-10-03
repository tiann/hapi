import chalk from 'chalk'
import { cliT } from '@/i18n/cliI18n'
import type { CommandDefinition } from './types'

export const notifyCommand: CommandDefinition = {
    name: 'notify',
    requiresRuntimeAssets: true,
    run: async () => {
        console.error(chalk.red(cliT('notify.unavailable')))
        console.error(chalk.gray(cliT('notify.unavailableHint')))
        process.exit(1)
    }
}

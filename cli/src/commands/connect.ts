import chalk from 'chalk'
import { cliT } from '@/i18n/cliI18n'
import type { CommandDefinition } from './types'

export async function handleConnectCommand(_args: string[]): Promise<void> {
    console.error(chalk.red(cliT('connect.unavailable')))
    console.error(chalk.gray(cliT('connect.unavailableHint')))
    process.exit(1)
}

export const connectCommand: CommandDefinition = {
    name: 'connect',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            await handleConnectCommand(commandArgs)
        } catch (error) {
            console.error(chalk.red(cliT('common.error')), error instanceof Error ? error.message : cliT('common.unknownError'))
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}

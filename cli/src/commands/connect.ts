import chalk from 'chalk'
import type { CommandDefinition } from './types'

export async function handleConnectCommand(_args: string[]): Promise<void> {
    console.error(chalk.red('The `hapi connect` command is not available in direct-connect mode.'))
    console.error(chalk.gray('Vendor token storage was part of the hosted server flow.'))
    process.exit(1)
}

export const connectCommand: CommandDefinition = {
    name: 'connect',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            await handleConnectCommand(commandArgs)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}

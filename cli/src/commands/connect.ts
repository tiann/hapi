import chalk from 'chalk'

export async function handleConnectCommand(_args: string[]): Promise<void> {
    console.error(chalk.red('The `hapi connect` command is not available in direct-connect mode.'))
    console.error(chalk.gray('Vendor token storage was part of the hosted server flow.'))
    process.exit(1)
}

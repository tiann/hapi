import chalk from 'chalk'
import os from 'node:os'
import { configuration } from '@/configuration'
import { readSettings, clearMachineId } from '@/persistence'

export async function handleAuthCommand(args: string[]): Promise<void> {
    const subcommand = args[0]

    if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
        showHelp()
        return
    }

    if (subcommand === 'status') {
        const settings = await readSettings()
        console.log(chalk.bold('\nDirect Connect Status\n'))
        console.log(chalk.gray(`  HAPPY_BOT_URL: ${configuration.serverUrl}`))
        console.log(chalk.gray(`  CLI_API_TOKEN: ${configuration.cliApiToken ? 'set' : 'missing'}`))
        console.log(chalk.gray(`  Machine ID: ${settings.machineId ?? 'not set'}`))
        console.log(chalk.gray(`  Host: ${os.hostname()}`))
        return
    }

    if (subcommand === 'login') {
        console.log(chalk.yellow('No login flow in direct-connect mode.'))
        console.log(chalk.gray('Set `HAPPY_BOT_URL` and `CLI_API_TOKEN` in your environment.'))
        return
    }

    if (subcommand === 'logout') {
        await clearMachineId()
        console.log(chalk.green('Cleared local machineId.'))
        console.log(chalk.gray('Unset `CLI_API_TOKEN` in your environment to fully revoke access.'))
        return
    }

    console.error(chalk.red(`Unknown auth subcommand: ${subcommand}`))
    showHelp()
    process.exit(1)
}

function showHelp(): void {
    console.log(`
${chalk.bold('hapi auth')} - Direct-connect configuration

${chalk.bold('Usage:')}
  hapi auth status            Show current configuration
  hapi auth login             Print configuration help
  hapi auth logout            Clear local machineId

${chalk.bold('Required env vars:')}
  HAPPY_BOT_URL=<https://your-bot-domain>
  CLI_API_TOKEN=<shared secret>
`)
}

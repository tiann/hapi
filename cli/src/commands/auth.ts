import chalk from 'chalk'
import os from 'node:os'
import * as readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { configuration } from '@/configuration'
import { cliT } from '@/i18n/cliI18n'
import { readSettings, clearMachineId, updateSettings } from '@/persistence'
import { initializeApiUrl } from '@/ui/apiUrlInit'
import type { CommandDefinition } from './types'

export async function handleAuthCommand(args: string[]): Promise<void> {
    const subcommand = args[0]

    if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
        showHelp()
        return
    }

    if (subcommand === 'status') {
        await initializeApiUrl()
        const settings = await readSettings()
        const envToken = process.env.CLI_API_TOKEN
        const settingsToken = settings.cliApiToken
        const hasToken = Boolean(envToken || settingsToken)
        const tokenSource = envToken
            ? cliT('auth.status.tokenSource.environment')
            : (settingsToken ? cliT('auth.status.tokenSource.settingsFile') : cliT('auth.status.tokenSource.none'))
        console.log(chalk.bold(`\n${cliT('auth.status.title')}\n`))
        console.log(chalk.gray(`  HAPI_API_URL: ${configuration.apiUrl}`))
        console.log(chalk.gray(`  CLI_API_TOKEN: ${hasToken ? cliT('auth.status.tokenSet') : cliT('auth.status.tokenMissing')}`))
        console.log(chalk.gray(`  ${cliT('auth.status.tokenSourceLabel')}: ${tokenSource}`))
        console.log(chalk.gray(`  ${cliT('auth.status.machineId')}: ${settings.machineId ?? cliT('auth.status.notSet')}`))
        console.log(chalk.gray(`  ${cliT('auth.status.host')}: ${os.hostname()}`))

        if (!hasToken) {
            console.log('')
            console.log(chalk.yellow(`  ${cliT('auth.status.missing.title')}`))
            console.log(chalk.gray(`    ${cliT('auth.status.missing.step1')}`))
            console.log(chalk.gray(`    ${cliT('auth.status.missing.step2')}`))
            console.log(chalk.gray(`    ${cliT('auth.status.missing.step3')}`))
            console.log('')
            console.log(chalk.gray(`  ${cliT('auth.status.missing.then')}`))
        }
        return
    }

    if (subcommand === 'login') {
        if (!process.stdin.isTTY) {
            console.error(chalk.red(cliT('auth.error.noTty')))
            console.error(chalk.gray(cliT('auth.error.noTtyHint')))
            process.exit(1)
        }

        const rl = readline.createInterface({ input, output })

        try {
            const token = await rl.question(chalk.cyan(cliT('auth.prompt.token')))

            if (!token.trim()) {
                console.error(chalk.red(cliT('auth.error.emptyToken')))
                process.exit(1)
            }

            await updateSettings(current => ({
                ...current,
                cliApiToken: token.trim()
            }))
            configuration._setCliApiToken(token.trim())
            console.log(chalk.green(`\n${cliT('auth.saved', { path: configuration.settingsFile })}`))
        } finally {
            rl.close()
        }
        return
    }

    if (subcommand === 'logout') {
        await updateSettings(current => ({
            ...current,
            cliApiToken: undefined
        }))
        await clearMachineId()
        console.log(chalk.green(cliT('auth.logout.done')))
        console.log(chalk.gray(cliT('auth.logout.note')))
        return
    }

    console.error(chalk.red(cliT('auth.error.unknownSubcommand', { subcommand })))
    showHelp()
    process.exit(1)
}

function showHelp(): void {
    console.log(`
${chalk.bold('hapi auth')} - ${cliT('auth.help.tagline')}

${chalk.bold(cliT('auth.help.usage'))}
  hapi auth status            ${cliT('auth.help.status')}
  hapi auth login             ${cliT('auth.help.login')}
  hapi auth logout            ${cliT('auth.help.logout')}

${chalk.bold(cliT('auth.help.priority'))}
  ${cliT('auth.help.priority1')}
  ${cliT('auth.help.priority2')}
  ${cliT('auth.help.priority3')}
`)
}

export const authCommand: CommandDefinition = {
    name: 'auth',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            await handleAuthCommand(commandArgs)
        } catch (error) {
            console.error(chalk.red(cliT('common.error')), error instanceof Error ? error.message : cliT('common.unknownError'))
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}

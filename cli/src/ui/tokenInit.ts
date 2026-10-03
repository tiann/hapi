/**
 * Token initialization module
 *
 * Handles CLI_API_TOKEN initialization with priority:
 * 1. Environment variable (highest - allows temporary override)
 * 2. Settings file (~/.hapi/settings.json)
 * 3. Interactive prompt (only when both above are missing)
 */

import * as readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import chalk from 'chalk'
import { exportHapiHubAuthEnv } from '@/agent/hapiSessionEnv'
import { configuration } from '@/configuration'
import { cliT } from '@/i18n/cliI18n'
import { readSettings, updateSettings } from '@/persistence'
import { initializeApiUrl } from '@/ui/apiUrlInit'
import { initializeExtraHeaders } from '@/ui/extraHeadersInit'

/**
 * Initialize CLI API token
 * Must be called before any API operations
 */
export async function initializeToken(): Promise<void> {
    // Initialize API URL first (env > settings.json > default)
    const apiUrlSource = await initializeApiUrl()
    await initializeExtraHeaders()
    const exportApiUrl = apiUrlSource !== 'default'

    // 1. Environment variable has highest priority (allows temporary override)
    if (configuration.cliApiToken) {
        exportHapiHubAuthEnv({ exportApiUrl })
        return
    }

    // 2. Read from settings file
    const settings = await readSettings()
    if (settings.cliApiToken) {
        configuration._setCliApiToken(settings.cliApiToken)
        exportHapiHubAuthEnv({ exportApiUrl })
        return
    }

    // 3. Non-TTY environment cannot prompt, fail with clear error
    if (!process.stdin.isTTY) {
        throw new Error(cliT('token.required'))
    }

    // 4. Interactive prompt
    const token = await promptForToken()

    // 5. Save and update configuration
    await updateSettings(current => ({
        ...current,
        cliApiToken: token
    }))
    configuration._setCliApiToken(token)
    exportHapiHubAuthEnv({ exportApiUrl })
}

async function promptForToken(): Promise<string> {
    const rl = readline.createInterface({ input, output })

    console.log(chalk.yellow(`\n${cliT('token.missing.title')}`))
    console.log(chalk.gray(cliT('token.missing.where')))
    console.log(chalk.gray(cliT('token.missing.step1')))
    console.log(chalk.gray(cliT('token.missing.step2')))
    console.log(chalk.gray(`${cliT('token.missing.step3')}\n`))

    try {
        const token = await rl.question(chalk.cyan(cliT('auth.prompt.token')))
        if (!token.trim()) {
            throw new Error(cliT('auth.error.emptyToken'))
        }
        console.log(chalk.green(`\n${cliT('auth.saved', { path: configuration.settingsFile })}`))
        return token.trim()
    } finally {
        rl.close()
    }
}

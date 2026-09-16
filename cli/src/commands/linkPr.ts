import chalk from 'chalk'
import { buildGithubPrExternalRef, parseGithubPrInput } from '@hapi/protocol'
import { upsertSessionExternalRef } from '@/api/upsertSessionExternalRef'
import { HAPI_SESSION_ID_ENV } from '@/agent/hapiSessionEnv'
import { initializeToken } from '@/ui/tokenInit'
import type { CommandDefinition } from './types'

export const linkPrCommand: CommandDefinition = {
    name: 'link-pr',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        const input = commandArgs[0]
        if (!input || commandArgs.includes('--help') || commandArgs.includes('-h')) {
            console.log('Usage: hapi link-pr <url|owner/repo#N>')
            console.log(`Requires ${HAPI_SESSION_ID_ENV} (exported into agent shells).`)
            console.log('Auth: CLI_API_TOKEN env or ~/.hapi/settings.json (hapi auth login).')
            console.log('Hub setting githubPrAwareness must be enabled.')
            process.exit(input ? 0 : 2)
        }

        await initializeToken()

        const sessionId = process.env[HAPI_SESSION_ID_ENV]?.trim()
        if (!sessionId) {
            console.error(chalk.red('Error:'), `${HAPI_SESSION_ID_ENV} is not set (run inside a HAPI session).`)
            process.exit(2)
        }

        const parsed = parseGithubPrInput(input)
        if (!parsed.ok) {
            console.error(chalk.red('Error:'), parsed.error)
            process.exit(2)
        }

        const ref = buildGithubPrExternalRef({
            repo: parsed.repo,
            number: parsed.number,
            role: 'primary',
            source: 'agent',
            linkedAt: Date.now()
        })

        try {
            const response = await upsertSessionExternalRef(sessionId, ref)
            if (response.status === 403) {
                console.error(chalk.red('Error:'), 'GitHub PR awareness is disabled on the hub (enable in Settings → General).')
                process.exit(1)
            }
            if (!response.ok) {
                console.error(chalk.red('Error:'), response.error ?? `HTTP ${response.status}`)
                process.exit(1)
            }
            console.log(chalk.green(`Linked ${parsed.repo}#${parsed.number} to session ${sessionId}`))
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'request failed')
            process.exit(1)
        }
    }
}

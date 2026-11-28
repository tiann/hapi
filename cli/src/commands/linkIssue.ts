import chalk from 'chalk'
import { initializeToken } from '@/ui/tokenInit'
import { HAPI_SESSION_ID_ENV } from '@/agent/hapiSessionEnv'
import { linkIssue, LinkIssueError } from '@/modules/linkIssue/linkIssue'
import type { CommandDefinition } from './types'

function showHelp(): void {
    console.log(`
${chalk.bold('hapi link-issue')} - Attach a GitHub issue reference to the current HAPI session

${chalk.bold('Usage:')}
  hapi link-issue <url>
  hapi link-issue <owner>/<repo>#<number>
  hapi link-issue <host>:<owner>/<repo>#<number>   (GHE; omit host for github.com)

${chalk.bold('Notes:')}
  Self-session only — links the issue to whichever session this command runs
  inside (resolved from ${HAPI_SESSION_ID_ENV}), not an arbitrary session id.
  Shows as a chip on the session row/detail. Re-linking the same issue just
  refreshes it, not a duplicate.

${chalk.bold('Env:')}
  HAPI_API_URL / CLI_API_TOKEN (or ~/.hapi/settings.json via \`hapi auth login\`)
`)
}

export async function handleLinkIssueCommand(args: string[]): Promise<void> {
    const url = args[0]
    if (!url || url === '--help' || url === '-h') {
        showHelp()
        if (!url) {
            throw new LinkIssueError('bad_args', 'missing url; usage: hapi link-issue <url|owner/repo#N>')
        }
        return
    }

    await initializeToken()
    await linkIssue(process.env[HAPI_SESSION_ID_ENV] ?? '', url)
    console.log(chalk.green(`hapi link-issue: OK - linked ${url}`))
}

export const linkIssueCommand: CommandDefinition = {
    name: 'link-issue',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        try {
            await handleLinkIssueCommand(commandArgs)
        } catch (error) {
            if (error instanceof LinkIssueError) {
                console.error(chalk.red('hapi link-issue:'), error.message)
                process.exit(error.code === 'bad_args' ? 2 : 1)
            }
            console.error(chalk.red('hapi link-issue:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) {
                // Never dump the raw error (review finding, tiann/hapi#2147,
                // round 14): linkIssue() sends a bearer JWT, and an AxiosError
                // carries its own request config — headers included — so
                // logging it whole here would print a live credential to the
                // terminal under DEBUG. Surface only the transport-level
                // signal a debugging session actually needs.
                const code = (error as { code?: unknown } | null)?.code
                const status = (error as { response?: { status?: unknown } } | null)?.response?.status
                console.error(chalk.dim(`  code=${String(code ?? 'unknown')} status=${String(status ?? 'none')}`))
            }
            process.exit(1)
        }
    }
}

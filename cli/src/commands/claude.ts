import chalk from 'chalk'
import { execFileSync } from 'node:child_process'
import { z } from 'zod'
import type { StartOptions } from '@/claude/runClaude'
import { configuration } from '@/configuration'
import { isDaemonRunningCurrentlyInstalledHappyVersion } from '@/daemon/controlClient'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { logger } from '@/ui/logger'
import { initializeToken } from '@/ui/tokenInit'
import { spawnHappyCLI } from '@/utils/spawnHappyCLI'
import { maybeAutoStartServer } from '@/utils/autoStartServer'
import { withBunRuntimeEnv } from '@/utils/bunRuntime'
import { extractErrorInfo } from '@/utils/errorUtils'
import type { CommandDefinition } from './types'

export const claudeCommand: CommandDefinition = {
    name: 'default',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        const args = [...commandArgs]

        if (args.length > 0 && args[0] === 'claude') {
            args.shift()
        }

        const options: StartOptions = {}
        let showHelp = false
        const unknownArgs: string[] = []

        for (let i = 0; i < args.length; i++) {
            const arg = args[i]

            if (arg === '-h' || arg === '--help') {
                showHelp = true
                unknownArgs.push(arg)
            } else if (arg === '--hapi-starting-mode') {
                options.startingMode = z.enum(['local', 'remote']).parse(args[++i])
            } else if (arg === '--yolo') {
                options.permissionMode = 'bypassPermissions'
                unknownArgs.push('--dangerously-skip-permissions')
            } else if (arg === '--dangerously-skip-permissions') {
                options.permissionMode = 'bypassPermissions'
                unknownArgs.push(arg)
            } else if (arg === '--started-by') {
                options.startedBy = args[++i] as 'daemon' | 'terminal'
            } else {
                unknownArgs.push(arg)
                if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
                    unknownArgs.push(args[++i])
                }
            }
        }

        if (unknownArgs.length > 0) {
            options.claudeArgs = [...(options.claudeArgs || []), ...unknownArgs]
        }

        if (showHelp) {
            console.log(`
${chalk.bold('hapi')} - Claude Code On the Go

${chalk.bold('Usage:')}
  hapi [options]         Start Claude with Telegram control (direct-connect)
  hapi auth              Manage authentication
  hapi codex             Start Codex mode
  hapi gemini            Start Gemini ACP mode
  hapi mcp               Start MCP stdio bridge
  hapi connect           (not available in direct-connect mode)
  hapi notify            (not available in direct-connect mode)
  hapi server            Start the API + web server
  hapi server --relay    Start with public relay
  hapi daemon            Manage background service that allows
                            to spawn new sessions away from your computer
  hapi doctor            System diagnostics & troubleshooting

${chalk.bold('Examples:')}
  hapi                    Start session (will prompt for token if not set)
  hapi auth login         Configure CLI_API_TOKEN interactively
  hapi --yolo             Start with bypassing permissions
                            hapi sugar for --dangerously-skip-permissions
  hapi auth status        Show direct-connect status
  hapi doctor             Run diagnostics

${chalk.bold('hapi supports ALL Claude options!')}
  Use any claude flag with hapi as you would with claude. Our favorite:

  hapi --resume

${chalk.gray('─'.repeat(60))}
${chalk.bold.cyan('Claude Code Options (from `claude --help`):')}
`)

            try {
                const claudeHelp = execFileSync(
                    'claude',
                    ['--help'],
                    { encoding: 'utf8', env: withBunRuntimeEnv(), shell: process.platform === 'win32' }
                )
                console.log(claudeHelp)
            } catch {
                console.log(chalk.yellow('Could not retrieve claude help. Make sure claude is installed.'))
            }

            process.exit(0)
        }

        await initializeToken()
        await maybeAutoStartServer()
        await authAndSetupMachineIfNeeded()

        logger.debug('Ensuring hapi background service is running & matches our version...')

        if (!(await isDaemonRunningCurrentlyInstalledHappyVersion())) {
            logger.debug('Starting hapi background service...')

            const daemonProcess = spawnHappyCLI(['daemon', 'start-sync'], {
                detached: true,
                stdio: 'ignore',
                env: process.env
            })
            daemonProcess.unref()

            await new Promise(resolve => setTimeout(resolve, 200))
        }

        try {
            const { runClaude } = await import('@/claude/runClaude')
            await runClaude(options)
        } catch (error) {
            const { message, messageLower, axiosCode, httpStatus, responseErrorText } = extractErrorInfo(error)

            if (
                axiosCode === 'ECONNREFUSED' ||
                axiosCode === 'ETIMEDOUT' ||
                axiosCode === 'ENOTFOUND' ||
                messageLower.includes('econnrefused') ||
                messageLower.includes('etimedout') ||
                messageLower.includes('enotfound') ||
                messageLower.includes('network error')
            ) {
                console.error(chalk.yellow('Unable to connect to HAPI server'))
                console.error(chalk.gray(`  Server URL: ${configuration.serverUrl}`))
                console.error(chalk.gray('  Please check your network connection or server status'))
            } else if (httpStatus === 403 && responseErrorText === 'Machine access denied') {
                console.error(chalk.red('Machine access denied.'))
                console.error(chalk.gray('  This machineId is already registered under a different namespace.'))
                console.error(chalk.gray('  Fix: run `hapi auth logout`, or set a separate HAPI_HOME per namespace.'))
            } else if (httpStatus === 403 && responseErrorText === 'Session access denied') {
                console.error(chalk.red('Session access denied.'))
                console.error(chalk.gray('  This session belongs to a different namespace.'))
                console.error(chalk.gray('  Use the matching CLI_API_TOKEN or switch namespaces.'))
            } else if (
                httpStatus === 401 ||
                httpStatus === 403 ||
                messageLower.includes('unauthorized') ||
                messageLower.includes('forbidden')
            ) {
                console.error(chalk.red('Authentication error:'), message)
                console.error(chalk.gray('  Run: hapi auth login'))
            } else {
                console.error(chalk.red('Error:'), message)
            }

            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}

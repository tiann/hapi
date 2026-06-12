import chalk from 'chalk'
import { execFileSync } from 'node:child_process'
import { z } from 'zod'
import { PROTOCOL_VERSION } from '@hapi/protocol'
import type { StartOptions } from '@/claude/runClaude'
import { CLAUDE_PERMISSION_MODES } from '@hapi/protocol/modes'
import { configuration } from '@/configuration'
import { isRunnerRunningCurrentlyInstalledHappyVersion } from '@/runner/controlClient'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { logger } from '@/ui/logger'
import { initializeToken } from '@/ui/tokenInit'
import { spawnHappyCLI } from '@/utils/spawnHappyCLI'
import { maybeAutoStartServer } from '@/utils/autoStartServer'
import { withBunRuntimeEnv } from '@/utils/bunRuntime'
import { extractErrorInfo } from '@/utils/errorUtils'
import type { CommandDefinition } from './types'

/**
 * Parse `hapi` / `hapi claude` CLI args into {@link StartOptions} plus a
 * showHelp flag. Extracted from {@link claudeCommand}.run so the arg handling
 * is unit-testable. Expects a leading `claude` subcommand to already be
 * stripped from `args`.
 */
export function parseClaudeStartOptions(args: string[]): { options: StartOptions; showHelp: boolean } {
    const options: StartOptions = {}
    let showHelp = false
    const unknownArgs: string[] = []
    let hasExplicitPermissionMode = false

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]

        if (arg === '-h' || arg === '--help') {
            showHelp = true
            unknownArgs.push(arg)
        } else if (arg === '--hapi-starting-mode') {
            const value = z.enum(['local', 'remote', 'pty']).parse(args[++i])
            if (value === 'pty') {
                // pty is the interactive-launch axis, not a control mode.
                options.interactive = true
            } else {
                options.startingMode = value
            }
        } else if (arg === '--permission-mode') {
            const mode = args[++i]
            if (!mode || !(CLAUDE_PERMISSION_MODES as readonly string[]).includes(mode)) {
                throw new Error(`Invalid --permission-mode value: ${mode ?? '(missing)'}`)
            }
            options.permissionMode = mode as StartOptions['permissionMode']
            hasExplicitPermissionMode = true
        } else if (arg === '--yolo' && !hasExplicitPermissionMode) {
            options.permissionMode = 'bypassPermissions'
            unknownArgs.push('--dangerously-skip-permissions')
        } else if (arg === '--dangerously-skip-permissions' && !hasExplicitPermissionMode) {
            options.permissionMode = 'bypassPermissions'
            unknownArgs.push(arg)
        } else if (arg === '--model') {
            const model = args[++i]
            if (!model) {
                throw new Error('Missing --model value')
            }
            options.model = model
            unknownArgs.push('--model', model)
        } else if (arg === '--effort') {
            const effort = args[++i]
            if (!effort) {
                throw new Error('Missing --effort value')
            }
            options.effort = effort
            unknownArgs.push('--effort', effort)
        } else if (arg === '--started-by') {
            options.startedBy = args[++i] as 'runner' | 'terminal'
        } else {
            unknownArgs.push(arg)
            if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
                unknownArgs.push(args[++i])
            }
        }
    }

    // PTY mode surfaces AskUserQuestion / permission requests in the web UI via
    // claude's PreToolUse hook (see ptyPermissionHandler). `--dangerously-skip-
    // permissions` makes claude bypass that hook entirely, so the question
    // renders only in the PTY TUI and never reaches the chat. In PTY mode we
    // always drop the flag — regardless of the resolved permission mode (an
    // explicit `--permission-mode default --dangerously-skip-permissions` would
    // otherwise keep it) — and rely on the hook instead: under bypassPermissions
    // every request is auto-approved, while question tools are still forwarded to
    // the web.
    if (options.interactive) {
        for (let i = unknownArgs.length - 1; i >= 0; i--) {
            if (unknownArgs[i] === '--dangerously-skip-permissions') {
                unknownArgs.splice(i, 1)
            }
        }
    }

    if (unknownArgs.length > 0) {
        options.claudeArgs = [...(options.claudeArgs || []), ...unknownArgs]
    }

    return { options, showHelp }
}

export const claudeCommand: CommandDefinition = {
    name: 'default',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        const args = [...commandArgs]

        if (args.length > 0 && args[0] === 'claude') {
            args.shift()
        }

        const { options, showHelp } = parseClaudeStartOptions(args)

        if (showHelp) {
            console.log(`
${chalk.bold('hapi')} - Claude Code On the Go

${chalk.bold('Usage:')}
  hapi [options]         Start Claude with Telegram control (direct-connect)
  hapi auth              Manage authentication
  hapi codex             Start Codex mode
  hapi cursor            Start Cursor Agent mode
  hapi opencode          Start OpenCode ACP mode
  hapi resume [id]       Resume an existing HAPI session locally
  hapi mcp               Start MCP stdio bridge
  hapi connect           (not available in direct-connect mode)
  hapi notify            (not available in direct-connect mode)
  hapi hub               Start the API + web hub
  hapi hub --relay       Start with public relay
  hapi server            Alias for hapi hub
  hapi runner            Manage background service that allows
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
                    {
                        encoding: 'utf8',
                        env: withBunRuntimeEnv(),
                        shell: process.platform === 'win32',
                        windowsHide: process.platform === 'win32'
                    }
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

        if (!(await isRunnerRunningCurrentlyInstalledHappyVersion())) {
            logger.debug('Starting hapi background service...')

            const runnerProcess = spawnHappyCLI(['runner', 'start-sync'], {
                detached: true,
                stdio: 'ignore',
                env: process.env
            })
            runnerProcess.unref()

            await new Promise(resolve => setTimeout(resolve, 200))
        }

        try {
            const { runClaude } = await import('@/claude/runClaude')
            await runClaude(options)
        } catch (error) {
            const { message, messageLower, axiosCode, httpStatus, responseErrorText, serverProtocolVersion } = extractErrorInfo(error)

            if (
                axiosCode === 'ECONNREFUSED' ||
                axiosCode === 'ETIMEDOUT' ||
                axiosCode === 'ENOTFOUND' ||
                messageLower.includes('econnrefused') ||
                messageLower.includes('etimedout') ||
                messageLower.includes('enotfound') ||
                messageLower.includes('network error')
            ) {
                console.error(chalk.yellow('Unable to connect to HAPI hub'))
                console.error(chalk.gray(`  Hub URL: ${configuration.apiUrl}`))
                console.error(chalk.gray('  Please check your network connection or hub status'))
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

            if (serverProtocolVersion !== undefined && serverProtocolVersion !== PROTOCOL_VERSION) {
                if (serverProtocolVersion < PROTOCOL_VERSION) {
                    console.error(chalk.yellow(`  Hint: hub protocol version (${serverProtocolVersion}) is behind CLI (${PROTOCOL_VERSION}). Please update the hub.`))
                } else {
                    console.error(chalk.yellow(`  Hint: CLI protocol version (${PROTOCOL_VERSION}) is behind hub (${serverProtocolVersion}). Please update the CLI.`))
                }
            }

            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}

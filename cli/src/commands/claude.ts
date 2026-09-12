import chalk from 'chalk'
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
import { extractErrorInfo } from '@/utils/errorUtils'
import type { CommandDefinition } from './types'

export const claudeCommand: CommandDefinition = {
    name: 'claude',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        const args = [...commandArgs]

        const options: StartOptions = {}
        const unknownArgs: string[] = []
        let hasExplicitPermissionMode = false

        for (let i = 0; i < args.length; i++) {
            const arg = args[i]

            if (arg === '--') {
                unknownArgs.push(...args.slice(i))
                break
            } else if (arg === '--hapi-starting-mode') {
                options.startingMode = z.enum(['local', 'remote']).parse(args[++i])
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
            } else if (arg.startsWith('--model=')) {
                const model = arg.slice('--model='.length)
                if (!model) {
                    throw new Error('Missing --model value')
                }
                options.model = model
            } else if (arg === '--effort') {
                const effort = args[++i]
                if (!effort) {
                    throw new Error('Missing --effort value')
                }
                options.effort = effort
                unknownArgs.push('--effort', effort)
            } else if (arg === '--started-by') {
                options.startedBy = args[++i] as 'runner' | 'terminal'
            } else if (arg === '--existing-session-id') {
                const sessionId = args[++i]
                if (!sessionId) {
                    throw new Error('Missing --existing-session-id value')
                }
                options.existingSessionId = sessionId
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

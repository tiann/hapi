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
import type { ClaudePermissionMode } from '@hapi/protocol/types'
import { ApiClient } from '@/api/api'
import { getInvokedCwd } from '@/utils/invokedCwd'
import { parseClaudeResumeArgs, resolveClaudeResume } from '@/claude/resumeIdentity'
import { claudeCheckSession } from '@/claude/utils/claudeCheckSession'
import { prepareLocalResume, selectResumableSession } from './resume'

/**
 * Terminal `hapi claude --resume/--continue`: when HAPI already owns the
 * conversation, reopen that HAPI session (same id) instead of creating a new
 * one. Must run before runClaude because HAPI_SESSION_ID is fixed at bootstrap.
 */
async function applyClaudeResumeIdentity(options: StartOptions, machineId: string): Promise<void> {
    // Runner/web spawns already carry the HAPI id they reopen or reserved.
    if (options.existingSessionId || options.reservedSessionId || options.startedBy === 'runner') return

    const parsed = parseClaudeResumeArgs(options.claudeArgs ?? [])
    if (!parsed.request) return

    const api = await ApiClient.create()
    const workingDirectory = options.workingDirectory ?? getInvokedCwd()
    const resolution = await resolveClaudeResume(parsed.request, {
        api,
        machineId,
        workingDirectory,
        isTTY: Boolean(process.stdin.isTTY),
        selectSession: selectResumableSession
    })
    if (resolution.kind !== 'reopen') return

    const { target, notice } = resolution
    if (target.flavor !== 'claude') {
        throw new Error(`HAPI session ${target.sessionId} is a ${target.flavor} session; use hapi resume ${target.sessionId}`)
    }
    // An explicit resume must never degrade into a fresh conversation under
    // the existing HAPI id: the local launcher drops a resume id whose
    // transcript is gone. Check before any handoff or archive change.
    if (!claudeCheckSession(target.agentSessionId, target.directory)) {
        throw new Error(
            `Claude conversation ${target.agentSessionId} of HAPI session ${target.sessionId} `
            + `has no transcript in ${target.directory}; nothing to resume`
        )
    }
    await prepareLocalResume(api, target, machineId)

    if (notice) console.log(chalk.gray(notice))
    console.log(chalk.gray(`Reopening HAPI session ${target.sessionId}`))

    options.existingSessionId = target.sessionId
    options.resumeSessionId = target.agentSessionId
    options.workingDirectory = target.directory
    options.startingMode = 'local'
    options.claudeArgs = parsed.remainingArgs.length > 0 ? parsed.remainingArgs : undefined
    // Explicit CLI flags win; otherwise keep the session's own settings.
    options.permissionMode ??= target.permissionMode as ClaudePermissionMode | undefined
    options.model ??= target.model ?? undefined
    if (options.effort === undefined && target.effort) {
        options.effort = target.effort
    }
}

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
            } else if (arg === '--yolo' || arg === '--dangerously-skip-permissions') {
                // Not forwarded: Claude lets this flag override --permission-mode,
                // so a later switch away from Yolo could never reach the TUI.
                if (!hasExplicitPermissionMode) {
                    options.permissionMode = 'bypassPermissions'
                }
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
            } else if (arg === '--hapi-session-id') {
                // Fresh-spawn reserved id (hub prealloc / runner stamp). Create
                // bootstrap with getOrCreate({ id }) — must NOT take the reopen
                // path (`existingSessionId` / `--existing-session-id`).
                const sessionId = args[++i]
                if (!sessionId) {
                    throw new Error('Missing --hapi-session-id value')
                }
                options.reservedSessionId = sessionId
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
        const { machineId } = await authAndSetupMachineIfNeeded()

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
            await applyClaudeResumeIdentity(options, machineId)
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

import chalk from 'chalk'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { startRunner } from '@/runner/run'
import {
    checkIfRunnerRunningAndCleanupStaleState,
    listRunnerSessions,
    stopRunner,
    stopRunnerSession
} from '@/runner/controlClient'
import { getLatestRunnerLog } from '@/ui/logger'
import { spawnHappyCLI } from '@/utils/spawnHappyCLI'
import { runDoctorCommand } from '@/ui/doctor'
import { initializeToken } from '@/ui/tokenInit'
import type { CommandDefinition } from './types'

/**
 * Parses `--workspace-root <path>` / `--workspace-root=<path>` from the
 * runner's positional args. Returns the resolved absolute path or exits
 * the process with a clear error. Mutates `args` to remove the consumed
 * entries so subcommand dispatch still works.
 */
function extractWorkspaceRootArg(args: string[]): string | undefined {
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        let value: string | undefined
        if (arg === '--workspace-root') {
            const next = args[i + 1]
            if (next === undefined || next.startsWith('--')) {
                console.error('--workspace-root requires a path argument')
                process.exit(1)
            }
            value = next
            args.splice(i, 2)
        } else if (arg?.startsWith('--workspace-root=')) {
            value = arg.slice('--workspace-root='.length)
            args.splice(i, 1)
        }
        if (value === undefined) continue

        const trimmed = value.trim()
        if (!trimmed) {
            console.error('--workspace-root requires a non-empty path')
            process.exit(1)
        }
        // Handle `~` / `~/foo` since the shell only expands unquoted tildes.
        let expanded = trimmed
        if (expanded === '~') {
            expanded = homedir()
        } else if (expanded.startsWith('~/')) {
            expanded = resolve(homedir(), expanded.slice(2))
        }
        const absolute = isAbsolute(expanded) ? expanded : resolve(expanded)
        if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
            console.error(`--workspace-root path does not exist or is not a directory: ${absolute}`)
            process.exit(1)
        }
        return absolute
    }
    return undefined
}

export const runnerCommand: CommandDefinition = {
    name: 'runner',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        const mutableArgs = [...commandArgs]
        const workspaceRoot = extractWorkspaceRootArg(mutableArgs)
        const runnerSubcommand = mutableArgs[0]

        if (runnerSubcommand === 'list') {
            try {
                const sessions = await listRunnerSessions()

                if (sessions.length === 0) {
                    console.log('No active sessions this runner is aware of (they might have been started by a previous version of the runner)')
                } else {
                    console.log('Active sessions:')
                    console.log(JSON.stringify(sessions, null, 2))
                }
            } catch {
                console.log('No runner running')
            }
            return
        }

        if (runnerSubcommand === 'stop-session') {
            const sessionId = mutableArgs[1]
            if (!sessionId) {
                console.error('Session ID required')
                process.exit(1)
            }

            try {
                const success = await stopRunnerSession(sessionId)
                console.log(success ? 'Session stopped' : 'Failed to stop session')
            } catch {
                console.log('No runner running')
            }
            return
        }

        if (runnerSubcommand === 'start') {
            const childArgs = ['runner', 'start-sync']
            if (workspaceRoot) {
                childArgs.push('--workspace-root', workspaceRoot)
            }
            const child = spawnHappyCLI(childArgs, {
                detached: true,
                stdio: 'ignore',
                env: process.env
            })
            child.unref()

            let started = false
            for (let i = 0; i < 50; i++) {
                if (await checkIfRunnerRunningAndCleanupStaleState()) {
                    started = true
                    break
                }
                await new Promise(resolve => setTimeout(resolve, 100))
            }

            if (started) {
                console.log('Runner started successfully')
            } else {
                console.error('Failed to start runner')
                process.exit(1)
            }
            process.exit(0)
        }

        if (runnerSubcommand === 'start-sync') {
            await initializeToken()
            await startRunner({ workspaceRoot })
            process.exit(0)
        }

        if (runnerSubcommand === 'stop') {
            await stopRunner()
            process.exit(0)
        }

        if (runnerSubcommand === 'status') {
            await runDoctorCommand('runner')
            process.exit(0)
        }

        if (runnerSubcommand === 'logs') {
            const latest = await getLatestRunnerLog()
            if (!latest) {
                console.log('No runner logs found')
            } else {
                console.log(latest.path)
            }
            process.exit(0)
        }

        console.log(`
${chalk.bold('hapi runner')} - Runner management

${chalk.bold('Usage:')}
  hapi runner start              Start the runner (detached)
  hapi runner stop               Stop the runner (sessions stay alive)
  hapi runner status             Show runner status
  hapi runner list               List active sessions

${chalk.bold('Options:')}
  --workspace-root <path>        Restrict the runner to this directory.
                                 Browse & spawn will reject paths outside it.
                                 Supports \`~\` / \`~/foo\` expansion.
                                 Omit to leave browsing off (legacy mode).

  If you want to kill all hapi related processes run 
  ${chalk.cyan('hapi doctor clean')}

${chalk.bold('Note:')} The runner runs in the background and manages Claude sessions.

${chalk.bold('To clean up runaway processes:')} Use ${chalk.cyan('hapi doctor clean')}
`)
    }
}

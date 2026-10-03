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
import { cliT } from '@/i18n/cliI18n'
import type { CommandDefinition } from './types'

/**
 * Parses repeated `--workspace-root <path>` / `--workspace-root=<path>` from
 * the runner's positional args. Returns resolved absolute paths or exits
 * the process with a clear error. Mutates `args` to remove the consumed
 * entries so subcommand dispatch still works.
 */
function extractWorkspaceRootArgs(args: string[]): string[] | undefined {
    const workspaceRoots: string[] = []

    for (let i = 0; i < args.length;) {
        const arg = args[i]
        let value: string | undefined
        let consumed = 0
        if (arg === '--workspace-root') {
            const next = args[i + 1]
            if (next === undefined || next.startsWith('--')) {
                console.error(cliT('runner.workspaceRoot.needsPath'))
                process.exit(1)
            }
            value = next
            consumed = 2
        } else if (arg?.startsWith('--workspace-root=')) {
            value = arg.slice('--workspace-root='.length)
            consumed = 1
        }
        if (value === undefined) {
            i += 1
            continue
        }

        const trimmed = value.trim()
        if (!trimmed) {
            console.error(cliT('runner.workspaceRoot.empty'))
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
            console.error(cliT('runner.workspaceRoot.notDirectory', { path: absolute }))
            process.exit(1)
        }
        workspaceRoots.push(absolute)
        args.splice(i, consumed)
    }

    const uniqueWorkspaceRoots = Array.from(new Set(workspaceRoots))
    return uniqueWorkspaceRoots.length > 0 ? uniqueWorkspaceRoots : undefined
}

async function waitForRunnerToStop(maxAttempts = 50): Promise<boolean> {
    for (let i = 0; i < maxAttempts; i++) {
        if (!(await checkIfRunnerRunningAndCleanupStaleState())) {
            return true
        }
        await new Promise(resolve => setTimeout(resolve, 100))
    }

    return false
}

export const runnerCommand: CommandDefinition = {
    name: 'runner',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        const mutableArgs = [...commandArgs]
        const workspaceRoots = extractWorkspaceRootArgs(mutableArgs)
        const runnerSubcommand = mutableArgs[0]

        if (runnerSubcommand === 'list') {
            try {
                const sessions = await listRunnerSessions()

                if (sessions.length === 0) {
                    console.log(cliT('runner.list.empty'))
                } else {
                    console.log(cliT('runner.list.header'))
                    console.log(JSON.stringify(sessions, null, 2))
                }
            } catch {
                console.log(cliT('runner.notRunning'))
            }
            return
        }

        if (runnerSubcommand === 'stop-session') {
            const sessionId = mutableArgs[1]
            if (!sessionId) {
                console.error(cliT('runner.stopSession.needsId'))
                process.exit(1)
            }

            try {
                const status = await stopRunnerSession(sessionId)
                if (status === 'stopped') {
                    console.log(cliT('runner.stopSession.stopped'))
                } else if (status === 'already_gone') {
                    console.log(cliT('runner.stopSession.alreadyGone'))
                } else {
                    console.log(cliT('runner.stopSession.failed'))
                }
            } catch {
                console.log(cliT('runner.notRunning'))
            }
            return
        }

        if (runnerSubcommand === 'start') {
            if (await checkIfRunnerRunningAndCleanupStaleState()) {
                console.log(cliT('runner.start.replacing'))
                await stopRunner()

                if (!(await waitForRunnerToStop())) {
                    console.error(cliT('runner.start.stopFailed'))
                    process.exit(1)
                }
            }

            const childArgs = ['runner', 'start-sync']
            if (workspaceRoots?.length) {
                for (const workspaceRoot of workspaceRoots) {
                    childArgs.push('--workspace-root', workspaceRoot)
                }
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
                console.log(cliT('runner.start.started'))
            } else {
                console.error(cliT('runner.start.failed'))
                process.exit(1)
            }
            process.exit(0)
        }

        if (runnerSubcommand === 'start-sync') {
            await initializeToken()
            await startRunner({ workspaceRoots })
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
                console.log(cliT('runner.logs.none'))
            } else {
                console.log(latest.path)
            }
            process.exit(0)
        }

        const doctorClean = chalk.cyan('hapi doctor clean')
        console.log(`
${chalk.bold('hapi runner')} - ${cliT('runner.help.tagline')}

${chalk.bold(cliT('runner.help.usage'))}
  hapi runner start              ${cliT('runner.help.start')}
  hapi runner stop               ${cliT('runner.help.stop')}
  hapi runner status             ${cliT('runner.help.status')}
  hapi runner list               ${cliT('runner.help.list')}

${chalk.bold(cliT('runner.help.options'))}
  --workspace-root <path>        ${cliT('runner.help.workspaceRoot.part1')}
                                 ${cliT('runner.help.workspaceRoot.part2')}
                                 ${cliT('runner.help.workspaceRoot.part3')}
                                 ${cliT('runner.help.workspaceRoot.part4')}
                                 ${cliT('runner.help.workspaceRoot.part5')}

  ${cliT('runner.help.killHint')}
  ${doctorClean}

${chalk.bold(cliT('runner.help.note'))} ${cliT('runner.help.noteBody')}
${cliT('runner.help.noteStart', { runnerStart: chalk.cyan('hapi runner start') })}

${chalk.bold(cliT('runner.help.cleanup'))} ${cliT('runner.help.cleanupBody', { doctorClean })}
`)
    }
}

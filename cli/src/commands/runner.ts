import chalk from 'chalk'
import { restartSessionsViaHub } from '@/api/hubClient'
import { readSettings } from '@/persistence'
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

export const runnerCommand: CommandDefinition = {
    name: 'runner',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        const runnerSubcommand = commandArgs[0]

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
            const sessionId = commandArgs[1]
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

        if (runnerSubcommand === 'restart-sessions') {
            await initializeToken()
            const settings = await readSettings()
            const machineId = typeof settings.machineId === 'string' ? settings.machineId.trim() : ''
            if (!machineId) {
                console.error('Cannot restart sessions: machineId is missing in local settings. Re-run setup or reconnect this machine.')
                process.exit(1)
            }

            const requestedSessionIds = commandArgs.slice(1)
                .map((value) => value.trim())
                .filter(Boolean)

            let results: Array<{ sessionId: string; name: string | null; status: 'restarted' | 'skipped' | 'failed'; error?: string }> = []
            try {
                const response = await restartSessionsViaHub({
                    sessionIds: requestedSessionIds.length > 0 ? requestedSessionIds : undefined,
                    machineId
                })
                results = response.results
            } catch (error) {
                console.error(error instanceof Error ? error.message : 'Failed to restart sessions via hub')
                process.exit(1)
            }

            if (results.length === 0) {
                console.log('No active sessions to restart')
                process.exit(0)
            }

            let failedCount = 0
            for (const result of results) {
                const label = result.name ? `${result.name} (${result.sessionId})` : result.sessionId
                if (result.status === 'restarted') {
                    console.log(`restarted: ${label}`)
                    continue
                }
                if (result.status === 'skipped') {
                    const reason = result.error ?? 'unknown'
                    console.log(`skipped: ${label} (${reason})`)
                    continue
                }

                failedCount += 1
                const reason = result.error ?? 'unknown'
                console.error(`failed: ${label} (${reason})`)
            }

            process.exit(failedCount > 0 ? 1 : 0)
        }

        if (runnerSubcommand === 'start') {
            const child = spawnHappyCLI(['runner', 'start-sync'], {
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
            await startRunner()
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
  hapi runner restart-sessions   Restart active sessions on this machine

  If you want to kill all hapi related processes run 
  ${chalk.cyan('hapi doctor clean')}

${chalk.bold('Note:')} The runner runs in the background and manages Claude sessions.

${chalk.bold('To clean up runaway processes:')} Use ${chalk.cyan('hapi doctor clean')}
`)
    }
}

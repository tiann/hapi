import chalk from 'chalk'
import { startRunner } from '@/runner/run'
import {
    checkIfRunnerRunningAndCleanupStaleState,
    getRunnerAvailability,
    isRunnerRunningCurrentlyInstalledHappyVersion,
    listRunnerSessions,
    stopRunner,
    stopRunnerSession
} from '@/runner/controlClient'
import { getLatestRunnerLog } from '@/ui/logger'
import { spawnHappyCLI } from '@/utils/spawnHappyCLI'
import { runDoctorCommand } from '@/ui/doctor'
import { initializeToken } from '@/ui/tokenInit'
import { readRunnerState } from '@/persistence'
import { isProcessAlive } from '@/utils/process'
import type { CommandDefinition } from './types'

/**
 * Spawn a detached runner process and poll until it is confirmed running.
 * When previousPid is provided, waits until a different runner PID has taken over.
 */
async function startRunnerDetached(previousPid?: number): Promise<boolean> {
    const child = spawnHappyCLI(['runner', 'start-sync'], {
        detached: true,
        stdio: 'ignore',
        env: process.env
    })
    child.unref()

    for (let i = 0; i < 50; i++) {
        const runningCurrentVersion = await isRunnerRunningCurrentlyInstalledHappyVersion()
        if (runningCurrentVersion) {
            if (previousPid === undefined) {
                return true
            }

            const nextState = await readRunnerState()
            if (nextState && nextState.pid !== previousPid) {
                return true
            }
        } else {
            await checkIfRunnerRunningAndCleanupStaleState()
        }
        await new Promise(resolve => setTimeout(resolve, 100))
    }
    return false
}

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

        if (runnerSubcommand === 'start') {
            let lastAvailability = await getRunnerAvailability()
            if (lastAvailability.status !== 'running') {
                const started = await startRunnerDetached()
                if (started) {
                    console.log('Runner started successfully')
                    process.exit(0)
                }
                lastAvailability = await getRunnerAvailability()
            }

            if (lastAvailability.status === 'running') {
                console.log('Runner started successfully')
                process.exit(0)
            }

            if (lastAvailability.status === 'degraded') {
                console.log('Runner process started but control port is not healthy yet')
                process.exit(0)
            }

            console.error('Failed to start runner')
            process.exit(1)
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

        if (runnerSubcommand === 'restart') {
            const previousPid = (await readRunnerState())?.pid
            const stopped = await stopRunner()

            if (!stopped || (previousPid !== undefined && isProcessAlive(previousPid))) {
                console.error('Failed to stop existing runner')
                process.exit(1)
            }

            // Start a fresh runner and ensure it is not the old process
            const started = await startRunnerDetached(previousPid)

            if (started) {
                console.log('Runner restarted successfully')
            } else {
                console.error('Failed to start runner')
                process.exit(1)
            }

            // Show full status after restart
            await runDoctorCommand('runner')
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
${chalk.bold('zs runner')} - Runner management

${chalk.bold('Usage:')}
  zs runner start              Start the runner (detached)
  zs runner stop               Stop the runner (sessions stay alive)
  zs runner restart            Restart the runner (stop + start + show status)
  zs runner status             Show runner status
  zs runner list               List active sessions

  If you want to kill all zs related processes run
  ${chalk.cyan('zs doctor clean')}

${chalk.bold('Note:')} The runner runs in the background and manages Claude sessions.

${chalk.bold('To clean up runaway processes:')} Use ${chalk.cyan('zs doctor clean')}
`)
    }
}

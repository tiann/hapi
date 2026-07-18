import chalk from 'chalk'
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
import { isProcessAlive } from '@/utils/process'
import { FOREGROUND_REPLACEMENT_READY, waitForOldRunnerThenStart } from '@/runner/foregroundReplacement'
import type { CommandDefinition } from './types'

const sleep = async (ms: number) => await new Promise<void>((resolve) => setTimeout(resolve, ms))

async function startDetachedRunner(): Promise<boolean> {
    const child = spawnHappyCLI(['runner', 'start-sync'], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, HAPI_RUNNER_SUPERVISED: 'foreground' }
    })
    child.unref()

    for (let i = 0; i < 50; i++) {
        if (await checkIfRunnerRunningAndCleanupStaleState()) return true
        await sleep(100)
    }
    return false
}

export const runnerCommand: CommandDefinition = {
    name: 'runner',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        const runnerSubcommand = commandArgs[0]

        if (runnerSubcommand === 'integration-fixture-agent') {
            const { runIntegrationAgentFixture } = await import('@/runner/fixtures/integrationAgent')
            await runIntegrationAgentFixture()
            return
        }

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
            if (await startDetachedRunner()) {
                console.log('Runner started successfully')
            } else {
                console.error('Failed to start runner')
                process.exit(1)
            }
            process.exit(0)
        }

        if (runnerSubcommand === 'restart-after') {
            const oldPid = Number(commandArgs[1])
            if (!Number.isSafeInteger(oldPid) || oldPid <= 0 || oldPid === process.pid) {
                process.exit(64)
            }

            process.stdout.write(`${FOREGROUND_REPLACEMENT_READY}\n`)
            const restarted = await waitForOldRunnerThenStart({
                oldPid,
                isAlive: isProcessAlive,
                startRunner: startDetachedRunner,
                sleep,
                waitTimeoutMs: 30_000,
                maxStartAttempts: 3
            })
            process.exit(restarted ? 0 : 1)
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
            await runDoctorCommand('runner', {
                fullArgs: commandArgs.includes('--full-args') || commandArgs.includes('--verbose')
            })
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
  hapi runner status             Show runner status (redacted process args by default)
  hapi runner status --full-args Show runner status with full process argv
  hapi runner list               List active sessions

  If you want to kill all hapi related processes run 
  ${chalk.cyan('hapi doctor')} (report only; manually verify legacy identities before any signal)

${chalk.bold('Note:')} The runner runs in the background and manages Claude sessions.

${chalk.bold('Legacy process cleanup:')} automatic PID/name-based cleanup is disabled; use the report and verify each identity manually.
`)
    }
}

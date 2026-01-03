import chalk from 'chalk'
import { startDaemon } from '@/daemon/run'
import {
    checkIfDaemonRunningAndCleanupStaleState,
    listDaemonSessions,
    stopDaemon,
    stopDaemonSession
} from '@/daemon/controlClient'
import { getLatestDaemonLog } from '@/ui/logger'
import { spawnHappyCLI } from '@/utils/spawnHappyCLI'
import { runDoctorCommand } from '@/ui/doctor'
import { install } from '@/daemon/install'
import { uninstall } from '@/daemon/uninstall'
import { initializeToken } from '@/ui/tokenInit'
import type { CommandDefinition } from './types'

export const daemonCommand: CommandDefinition = {
    name: 'daemon',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        const daemonSubcommand = commandArgs[0]

        if (daemonSubcommand === 'list') {
            try {
                const sessions = await listDaemonSessions()

                if (sessions.length === 0) {
                    console.log('No active sessions this daemon is aware of (they might have been started by a previous version of the daemon)')
                } else {
                    console.log('Active sessions:')
                    console.log(JSON.stringify(sessions, null, 2))
                }
            } catch {
                console.log('No daemon running')
            }
            return
        }

        if (daemonSubcommand === 'stop-session') {
            const sessionId = commandArgs[1]
            if (!sessionId) {
                console.error('Session ID required')
                process.exit(1)
            }

            try {
                const success = await stopDaemonSession(sessionId)
                console.log(success ? 'Session stopped' : 'Failed to stop session')
            } catch {
                console.log('No daemon running')
            }
            return
        }

        if (daemonSubcommand === 'start') {
            const child = spawnHappyCLI(['daemon', 'start-sync'], {
                detached: true,
                stdio: 'ignore',
                env: process.env
            })
            child.unref()

            let started = false
            for (let i = 0; i < 50; i++) {
                if (await checkIfDaemonRunningAndCleanupStaleState()) {
                    started = true
                    break
                }
                await new Promise(resolve => setTimeout(resolve, 100))
            }

            if (started) {
                console.log('Daemon started successfully')
            } else {
                console.error('Failed to start daemon')
                process.exit(1)
            }
            process.exit(0)
        }

        if (daemonSubcommand === 'start-sync') {
            await initializeToken()
            await startDaemon()
            process.exit(0)
        }

        if (daemonSubcommand === 'stop') {
            await stopDaemon()
            process.exit(0)
        }

        if (daemonSubcommand === 'status') {
            await runDoctorCommand('daemon')
            process.exit(0)
        }

        if (daemonSubcommand === 'logs') {
            const latest = await getLatestDaemonLog()
            if (!latest) {
                console.log('No daemon logs found')
            } else {
                console.log(latest.path)
            }
            process.exit(0)
        }

        if (daemonSubcommand === 'install') {
            try {
                await install()
            } catch (error) {
                console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
                process.exit(1)
            }
            return
        }

        if (daemonSubcommand === 'uninstall') {
            try {
                await uninstall()
            } catch (error) {
                console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
                process.exit(1)
            }
            return
        }

        console.log(`
${chalk.bold('hapi daemon')} - Daemon management

${chalk.bold('Usage:')}
  hapi daemon start              Start the daemon (detached)
  hapi daemon stop               Stop the daemon (sessions stay alive)
  hapi daemon status             Show daemon status
  hapi daemon list               List active sessions

  If you want to kill all hapi related processes run 
  ${chalk.cyan('hapi doctor clean')}

${chalk.bold('Note:')} The daemon runs in the background and manages Claude sessions.

${chalk.bold('To clean up runaway processes:')} Use ${chalk.cyan('hapi doctor clean')}
`)
    }
}

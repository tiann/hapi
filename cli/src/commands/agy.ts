import chalk from 'chalk'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { initializeToken } from '@/ui/tokenInit'
import { maybeAutoStartServer } from '@/utils/autoStartServer'
import type { CommandDefinition } from './types'
import { AGY_PERMISSION_MODES } from '@hapi/protocol/modes'
import type { AgyPermissionMode } from '@hapi/protocol/types'

const NATIVE_AGY_CONVERSATION_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export const agyCommand: CommandDefinition = {
    name: 'agy',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            const options: {
                additionalDirectories?: string[]
                startedBy?: 'runner' | 'terminal'
                startingMode?: 'local' | 'remote'
                permissionMode?: AgyPermissionMode
                model?: string
                logFile?: string
                printTimeout?: string
                resumeSessionId?: string
            } = {
                additionalDirectories: []
            }

            let hasExplicitPermissionMode = false
            let nativeSandbox = false
            let nativeSkipPermissions = false

            for (let i = 0; i < commandArgs.length; i++) {
                const arg = commandArgs[i]
                if (arg === '--started-by') {
                    options.startedBy = commandArgs[++i] as 'runner' | 'terminal'
                } else if (arg === '--hapi-starting-mode') {
                    const value = commandArgs[++i]
                    if (value === 'local' || value === 'remote') {
                        options.startingMode = value
                    } else {
                        throw new Error('Invalid --hapi-starting-mode (expected local or remote)')
                    }
                } else if (arg === '--permission-mode') {
                    const mode = commandArgs[++i]
                    if (!mode || !(AGY_PERMISSION_MODES as readonly string[]).includes(mode)) {
                        throw new Error(`Invalid --permission-mode value: ${mode ?? '(missing)'}`)
                    }
                    options.permissionMode = mode as AgyPermissionMode
                    hasExplicitPermissionMode = true
                } else if (arg === '--yolo' && !hasExplicitPermissionMode) {
                    nativeSkipPermissions = true
                } else if (arg === '--sandbox') {
                    nativeSandbox = true
                } else if (arg === '--dangerously-skip-permissions') {
                    nativeSkipPermissions = true
                } else if (arg === '--add-dir') {
                    const directory = commandArgs[++i]
                    if (!directory) {
                        throw new Error('Missing --add-dir value')
                    }
                    options.additionalDirectories?.push(directory)
                } else if (arg === '--log-file') {
                    const logFile = commandArgs[++i]
                    if (!logFile) {
                        throw new Error('Missing --log-file value')
                    }
                    options.logFile = logFile
                } else if (arg === '--print-timeout') {
                    const printTimeout = commandArgs[++i]
                    if (!printTimeout) {
                        throw new Error('Missing --print-timeout value')
                    }
                    options.printTimeout = printTimeout
                } else if (arg === '--resume' || arg === '--conversation') {
                    const sessionId = commandArgs[++i]
                    if (!sessionId) {
                        throw new Error(`Missing ${arg} value`)
                    }
                    if (arg === '--conversation' && !NATIVE_AGY_CONVERSATION_ID_RE.test(sessionId)) {
                        throw new Error(`Invalid --conversation value: ${sessionId}`)
                    }
                    options.resumeSessionId = sessionId
                } else if (arg === '--model') {
                    const model = commandArgs[++i]
                    if (!model) {
                        throw new Error('Missing --model value')
                    }
                    options.model = model
                } else {
                    throw new Error(`Unsupported hapi agy option: ${arg}`)
                }
            }
            if (!hasExplicitPermissionMode) {
                if (nativeSandbox && nativeSkipPermissions) {
                    options.permissionMode = 'safe-yolo'
                } else if (nativeSandbox) {
                    options.permissionMode = 'read-only'
                } else if (nativeSkipPermissions) {
                    options.permissionMode = 'yolo'
                }
            }
            if (options.additionalDirectories?.length === 0) {
                delete options.additionalDirectories
            }

            await initializeToken()
            await maybeAutoStartServer()
            await authAndSetupMachineIfNeeded()

            const { runAgy } = await import('@/agy/runAgy')
            await runAgy(options)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}

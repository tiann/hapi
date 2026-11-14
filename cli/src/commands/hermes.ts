import chalk from 'chalk'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { initializeToken } from '@/ui/tokenInit'
import { maybeAutoStartServer } from '@/utils/autoStartServer'
import type { CommandDefinition } from './types'
import { HERMES_PERMISSION_MODES, type HermesPermissionMode } from '@hapi/protocol/modes'

export const hermesCommand: CommandDefinition = {
    name: 'hermes',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            const options: {
                startedBy?: 'runner' | 'terminal'
                startingMode?: 'remote'
                permissionMode?: HermesPermissionMode
                model?: string
                resumeSessionId?: string
                existingSessionId?: string
                reservedSessionId?: string
            } = {}

            let hasExplicitPermissionMode = false

            for (let i = 0; i < commandArgs.length; i++) {
                const arg = commandArgs[i]
                if (arg === '--started-by') {
                    options.startedBy = commandArgs[++i] as 'runner' | 'terminal'
                } else if (arg === '--hapi-starting-mode') {
                    const value = commandArgs[++i]
                    if (value === 'remote') {
                        options.startingMode = value
                    } else if (value === 'local') {
                        throw new Error('Hermes only supports remote mode')
                    } else {
                        throw new Error('Invalid --hapi-starting-mode (expected remote)')
                    }
                } else if (arg === '--hapi-session-id') {
                    const sessionId = commandArgs[++i]
                    if (!sessionId) {
                        throw new Error('Missing --hapi-session-id value')
                    }
                    options.reservedSessionId = sessionId
                } else if (arg === '--existing-session-id') {
                    const sessionId = commandArgs[++i]
                    if (!sessionId) {
                        throw new Error('Missing --existing-session-id value')
                    }
                    options.existingSessionId = sessionId
                } else if (arg === '--permission-mode') {
                    const mode = commandArgs[++i]
                    if (!mode || !(HERMES_PERMISSION_MODES as readonly string[]).includes(mode)) {
                        throw new Error(`Invalid --permission-mode value: ${mode ?? '(missing)'}`)
                    }
                    options.permissionMode = mode as HermesPermissionMode
                    hasExplicitPermissionMode = true
                } else if (arg === '--yolo' && !hasExplicitPermissionMode) {
                    options.permissionMode = 'yolo'
                } else if (arg === '--resume') {
                    const sessionId = commandArgs[++i]
                    if (!sessionId) {
                        throw new Error('Missing --resume value')
                    }
                    options.resumeSessionId = sessionId
                } else if (arg === '--model') {
                    const model = commandArgs[++i]
                    if (!model) {
                        throw new Error('Missing --model value')
                    }
                    options.model = model
                }
            }

            await maybeAutoStartServer()
            await initializeToken()
            await authAndSetupMachineIfNeeded()
            const { runHermes } = await import('@/hermes/runHermes')
            await runHermes(options)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            process.exit(1)
        }
    }
}

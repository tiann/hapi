import chalk from 'chalk'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { initializeToken } from '@/ui/tokenInit'
import { maybeAutoStartServer } from '@/utils/autoStartServer'
import type { CommandDefinition } from './types'
import { DSH_EFFORTS, DSH_PERMISSION_MODES, DSH_PRESETS } from '@hapi/protocol/modes'
import type { DshEffort, DshPermissionMode, DshPreset } from '@hapi/protocol/types'

export const dshCommand: CommandDefinition = {
    name: 'dsh',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            const options: {
                startedBy?: 'runner' | 'terminal'
                startingMode?: 'local' | 'remote'
                permissionMode?: DshPermissionMode
                model?: string
                effort?: DshEffort
                preset?: DshPreset
                resumeSessionId?: string
            } = {}

            let hasExplicitPermissionMode = false

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
                    if (!mode || !(DSH_PERMISSION_MODES as readonly string[]).includes(mode)) {
                        throw new Error(`Invalid --permission-mode value: ${mode ?? '(missing)'}`)
                    }
                    options.permissionMode = mode as DshPermissionMode
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
                } else if (arg === '--effort') {
                    const effort = commandArgs[++i]
                    if (!effort || !(DSH_EFFORTS as readonly string[]).includes(effort)) {
                        throw new Error(`Invalid --effort value: ${effort ?? '(missing)'}`)
                    }
                    options.effort = effort as DshEffort
                } else if (arg === '--preset') {
                    const preset = commandArgs[++i]
                    if (!preset || !(DSH_PRESETS as readonly string[]).includes(preset)) {
                        throw new Error(`Invalid --preset value: ${preset ?? '(missing)'}`)
                    }
                    options.preset = preset as DshPreset
                }
            }

            await initializeToken()
            await maybeAutoStartServer()
            await authAndSetupMachineIfNeeded()

            const { runDsh } = await import('@/dsh/runDsh')
            await runDsh(options)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}

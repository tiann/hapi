import chalk from 'chalk'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { initializeToken } from '@/ui/tokenInit'
import { maybeAutoStartServer } from '@/utils/autoStartServer'
import type { CommandDefinition } from './types'
import { HERMES_MOA_PERMISSION_MODES } from '@hapi/protocol/modes'
import { isHermesMoaPreset } from '@hapi/protocol'
import type { HermesMoaPermissionMode } from '@hapi/protocol/types'

export const hermesMoaCommand: CommandDefinition = {
    name: 'hermes-moa',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            const options: {
                startedBy?: 'runner' | 'terminal'
                startingMode?: 'local' | 'remote'
                permissionMode?: HermesMoaPermissionMode
                model?: string
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
                    if (!mode || !(HERMES_MOA_PERMISSION_MODES as readonly string[]).includes(mode)) {
                        throw new Error(`Invalid --permission-mode value: ${mode ?? '(missing)'}`)
                    }
                    options.permissionMode = mode as HermesMoaPermissionMode
                    hasExplicitPermissionMode = true
                } else if (arg === '--yolo' && !hasExplicitPermissionMode) {
                    options.permissionMode = 'yolo'
                } else if (arg === '--model') {
                    const model = commandArgs[++i]
                    if (!model) {
                        throw new Error('Missing --model value')
                    }
                    if (!isHermesMoaPreset(model)) {
                        throw new Error(`Invalid Hermes MoA preset: ${model}`)
                    }
                    options.model = model
                } else if (arg === '--resume') {
                    const resumeSessionId = commandArgs[++i]
                    if (!resumeSessionId) {
                        throw new Error('Missing --resume value')
                    }
                    options.resumeSessionId = resumeSessionId
                } else {
                    throw new Error(`Unsupported hapi hermes-moa option: ${arg}`)
                }
            }

            await initializeToken()
            await maybeAutoStartServer()
            await authAndSetupMachineIfNeeded()

            const { runHermesMoa } = await import('@/hermesMoa/runHermesMoa')
            await runHermesMoa(options)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}

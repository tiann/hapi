import chalk from 'chalk'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { initializeToken } from '@/ui/tokenInit'
import { maybeAutoStartServer } from '@/utils/autoStartServer'
import type { CommandDefinition } from './types'
import type { PiPermissionMode, PiThinkingLevel } from '@/pi/piTypes'

const parseThinkingLevel = (value: string): PiThinkingLevel => {
    const valid: PiThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']
    if (valid.includes(value as PiThinkingLevel)) {
        return value as PiThinkingLevel
    }
    throw new Error(`Invalid thinking level: ${value}. Valid values: ${valid.join(', ')}`)
}

export const piCommand: CommandDefinition = {
    name: 'pi',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            const options: {
                startedBy?: 'runner' | 'terminal'
                startingMode?: 'local' | 'remote'
                permissionMode?: PiPermissionMode
                resumeSessionId?: string
                model?: string
                thinkingLevel?: PiThinkingLevel
            } = {}

            for (let i = 0; i < commandArgs.length; i++) {
                const arg = commandArgs[i]

                if (i === 0 && arg === 'resume') {
                    const candidate = commandArgs[i + 1]
                    if (!candidate || candidate.startsWith('-')) {
                        throw new Error('resume requires a session path')
                    }
                    options.resumeSessionId = candidate
                    i += 1
                    continue
                }

                if (arg === '--started-by') {
                    const value = commandArgs[++i]
                    if (value !== 'runner' && value !== 'terminal') {
                        throw new Error('Invalid --started-by (expected runner or terminal)')
                    }
                    options.startedBy = value
                } else if (arg === '--hapi-starting-mode') {
                    const value = commandArgs[++i]
                    if (value === 'local' || value === 'remote') {
                        options.startingMode = value
                    } else {
                        throw new Error('Invalid --hapi-starting-mode (expected local or remote)')
                    }
                } else if (arg === '--yolo') {
                    options.permissionMode = 'yolo'
                } else if (arg === '--model') {
                    const model = commandArgs[++i]
                    if (!model) {
                        throw new Error('Missing --model value')
                    }
                    options.model = model
                } else if (arg === '--thinking-level' || arg === '--thinking') {
                    const level = commandArgs[++i]
                    if (!level) {
                        throw new Error('Missing --thinking-level value')
                    }
                    options.thinkingLevel = parseThinkingLevel(level)
                }
            }

            await initializeToken()
            await maybeAutoStartServer()
            await authAndSetupMachineIfNeeded()

            const { runPi } = await import('@/pi/runPi')
            await runPi(options)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}

import chalk from 'chalk'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { initializeToken } from '@/ui/tokenInit'
import { maybeAutoStartServer } from '@/utils/autoStartServer'
import type { CommandDefinition } from './types'
import type { CursorPermissionMode } from '@hapi/protocol/types'

export const cursorCommand: CommandDefinition = {
    name: 'cursor',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            const { runCursor } = await import('@/cursor/runCursor')

            const options: {
                startedBy?: 'runner' | 'terminal'
                cursorArgs?: string[]
                permissionMode?: CursorPermissionMode
                resumeSessionId?: string
                model?: string
            } = {}
            const unknownArgs: string[] = []

            for (let i = 0; i < commandArgs.length; i++) {
                const arg = commandArgs[i]
                if (i === 0 && arg === 'resume') {
                    const candidate = commandArgs[i + 1]
                    if (!candidate || candidate.startsWith('-')) {
                        throw new Error('resume requires a chat id')
                    }
                    options.resumeSessionId = candidate
                    i += 1
                    continue
                }
                if (arg === '--started-by') {
                    options.startedBy = commandArgs[++i] as 'runner' | 'terminal'
                } else if (arg === '--yolo' || arg === '--force') {
                    options.permissionMode = 'yolo'
                } else if (arg === '--mode') {
                    const mode = commandArgs[++i]
                    if (!mode) {
                        throw new Error('Missing --mode value')
                    }
                    if (mode === 'plan' || mode === 'ask') {
                        options.permissionMode = mode
                    }
                } else if (arg === '--plan') {
                    options.permissionMode = 'plan'
                } else if (arg === '--model') {
                    const model = commandArgs[++i]
                    if (!model) {
                        throw new Error('Missing --model value')
                    }
                    options.model = model
                } else if (arg === '--resume') {
                    const chatId = commandArgs[i + 1]
                    if (chatId && !chatId.startsWith('-')) {
                        options.resumeSessionId = chatId
                        i += 1
                    } else {
                        unknownArgs.push(arg)
                    }
                } else if (arg === '--continue') {
                    unknownArgs.push(arg)
                } else if (arg === '--hapi-starting-mode') {
                    const value = commandArgs[++i]
                    if (value !== 'local' && value !== 'remote') {
                        throw new Error('Invalid --hapi-starting-mode (expected local or remote)')
                    }
                    continue
                } else {
                    unknownArgs.push(arg)
                }
            }
            if (unknownArgs.length > 0) {
                options.cursorArgs = unknownArgs
            }

            await initializeToken()
            await maybeAutoStartServer()
            await authAndSetupMachineIfNeeded()
            await runCursor(options)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}

import chalk from 'chalk'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { initializeToken } from '@/ui/tokenInit'
import { maybeAutoStartServer } from '@/utils/autoStartServer'
import type { CommandDefinition } from './types'
import { CURSOR_PERMISSION_MODES } from '@hapi/protocol/modes'
import type { CursorPermissionMode } from '@hapi/protocol/types'

export type ParsedCursorCommandOptions = {
    startedBy?: 'runner' | 'terminal'
    cursorArgs?: string[]
    cursorWorktree?: boolean | string
    cursorAddDirs?: string[]
    permissionMode?: CursorPermissionMode
    resumeSessionId?: string
    model?: string
}

/** Pure argv parser for `hapi cursor` — exported for unit tests. */
export function parseCursorCommandArgs(commandArgs: string[]): ParsedCursorCommandOptions {
    const options: ParsedCursorCommandOptions = {}
    const unknownArgs: string[] = []
    let hasExplicitPermissionMode = false

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
        } else if (arg === '--permission-mode') {
            const mode = commandArgs[++i]
            if (!mode || !(CURSOR_PERMISSION_MODES as readonly string[]).includes(mode)) {
                throw new Error(`Invalid --permission-mode value: ${mode ?? '(missing)'}`)
            }
            options.permissionMode = mode as CursorPermissionMode
            hasExplicitPermissionMode = true
        } else if ((arg === '--yolo' || arg === '--force') && !hasExplicitPermissionMode) {
            options.permissionMode = 'yolo'
        } else if (arg === '--auto-review' && !hasExplicitPermissionMode) {
            options.permissionMode = 'autoReview'
        } else if (arg === '--mode') {
            const mode = commandArgs[++i]
            if (!mode || !(CURSOR_PERMISSION_MODES as readonly string[]).includes(mode)) {
                throw new Error(`Invalid --mode value: ${mode ?? '(missing)'}`)
            }
            options.permissionMode = mode as CursorPermissionMode
            hasExplicitPermissionMode = true
        } else if (arg === '--plan') {
            options.permissionMode = 'plan'
            hasExplicitPermissionMode = true
        } else if (arg === '--model') {
            const model = commandArgs[++i]
            if (!model) {
                throw new Error('Missing --model value')
            }
            options.model = model
        } else if (arg === '--cursor-worktree') {
            const next = commandArgs[i + 1]
            if (next && !next.startsWith('-')) {
                options.cursorWorktree = next
                i += 1
            } else {
                options.cursorWorktree = true
            }
        } else if (arg === '--cursor-add-dir') {
            const dir = commandArgs[++i]
            if (!dir || dir.startsWith('-')) {
                throw new Error('Missing --cursor-add-dir value')
            }
            options.cursorAddDirs = [...(options.cursorAddDirs ?? []), dir]
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
    return options
}

export const cursorCommand: CommandDefinition = {
    name: 'cursor',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            const { runCursor } = await import('@/cursor/runCursor')
            const options = parseCursorCommandArgs(commandArgs)

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

import chalk from 'chalk'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { initializeToken } from '@/ui/tokenInit'
import { maybeAutoStartServer } from '@/utils/autoStartServer'
import type { CommandDefinition } from './types'
import { COPILOT_PERMISSION_MODES } from '@hapi/protocol/modes'
import type { CopilotPermissionMode } from '@hapi/protocol/types'
import { isCopilotAgentMode, type CopilotAgentMode } from '@hapi/protocol'

export const copilotCommand: CommandDefinition = {
    name: 'copilot',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            const options: {
                startedBy?: 'runner' | 'terminal'
                startingMode?: 'local' | 'remote'
                permissionMode?: CopilotPermissionMode
                model?: string
                copilotAgentMode?: CopilotAgentMode
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
                    if (!mode || !(COPILOT_PERMISSION_MODES as readonly string[]).includes(mode)) {
                        throw new Error(`Invalid --permission-mode value: ${mode ?? '(missing)'}`)
                    }
                    options.permissionMode = mode as CopilotPermissionMode
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
                } else if (arg === '--copilot-agent-mode' || arg === '--mode') {
                    const mode = commandArgs[++i]
                    if (!mode || !isCopilotAgentMode(mode)) {
                        throw new Error(
                            mode === 'fleet'
                                ? 'Fleet is not an agent mode; use /fleet <task> inside the session (with Interactive, Plan, or Autopilot)'
                                : `Invalid --copilot-agent-mode value: ${mode ?? '(missing)'} (expected interactive, plan, or autopilot)`
                        )
                    }
                    options.copilotAgentMode = mode
                }
            }

            await initializeToken()
            await maybeAutoStartServer()
            await authAndSetupMachineIfNeeded()

            const { runCopilot } = await import('@/copilot/runCopilot')
            await runCopilot(options)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}

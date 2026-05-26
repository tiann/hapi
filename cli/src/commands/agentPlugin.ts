import chalk from 'chalk'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { initializeToken } from '@/ui/tokenInit'
import { maybeAutoStartServer } from '@/utils/autoStartServer'
import type { CommandDefinition } from './types'
import { AgentIdSchema } from '@hapi/protocol/plugins'
import { PermissionModeSchema } from '@hapi/protocol/schemas'
import type { SessionPermissionMode } from '@/api/types'

function valueAfter(args: string[], flag: string): string | undefined {
    const index = args.indexOf(flag)
    return index >= 0 ? args[index + 1] : undefined
}

export const agentPluginCommand: CommandDefinition = {
    name: 'agent-plugin',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            const rawType = valueAfter(commandArgs, '--type')
            if (!rawType) {
                throw new Error('Usage: hapi agent-plugin --type <agent-id> [--started-by runner|terminal] [--model <model>] [--permission-mode <mode>] [--yolo]')
            }
            const agentType = AgentIdSchema.parse(rawType)
            const startedByValue = valueAfter(commandArgs, '--started-by')
            const startedBy = startedByValue === 'runner' || startedByValue === 'terminal' ? startedByValue : undefined
            const model = valueAfter(commandArgs, '--model')
            const permissionValue = valueAfter(commandArgs, '--permission-mode')
            const permissionMode = permissionValue === undefined
                ? undefined
                : PermissionModeSchema.parse(permissionValue) as SessionPermissionMode
            const yolo = commandArgs.includes('--yolo')

            await initializeToken()
            await maybeAutoStartServer()
            await authAndSetupMachineIfNeeded()

            const { runPluginAgentSession } = await import('@/agent/runners/runPluginAgentSession')
            await runPluginAgentSession({ agentType, startedBy, model, permissionMode, yolo })
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}

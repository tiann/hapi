import { AgentRegistry } from '@/agent/AgentRegistry'
import { configuration } from '@/configuration'
import { readSettings } from '@/persistence'
import { RunnerPluginManager } from '@/runner/plugins/runnerPluginManager'
import { runAgentSession } from './runAgentSession'
import type { SessionPermissionMode } from '@/api/types'
import type { PermissionMode } from '@hapi/protocol'

export async function runPluginAgentSession(opts: {
    agentType: string
    startedBy?: 'runner' | 'terminal'
    permissionMode?: SessionPermissionMode
    yolo?: boolean
    model?: string
}): Promise<void> {
    const settings = await readSettings()
    const machineId = settings?.machineId ?? 'local'
    const manager = new RunnerPluginManager({
        hapiHome: configuration.happyHomeDir,
        machineId,
        envPluginDirs: process.env.HAPI_PLUGIN_DIRS,
        env: process.env,
        includeBundledCore: true,
        includeBundledExamples: process.env.HAPI_ENABLE_BUNDLED_EXAMPLES === '1'
    })

    await manager.start()
    const descriptor = manager.getAgentDescriptor(opts.agentType)
    const factory = manager.getAgentAdapterFactory(opts.agentType)
    if (!descriptor || !factory) {
        await manager.dispose()
        throw new Error(`Agent adapter ${opts.agentType} is not active on this runner.`)
    }

    const allowedPermissionModes = descriptor.capabilities.permissionModes as readonly PermissionMode[] | undefined
    const resolveYoloPermissionMode = (): SessionPermissionMode | undefined => {
        if (!opts.yolo) {
            return undefined
        }
        if (allowedPermissionModes?.includes('yolo')) {
            return 'yolo'
        }
        if (allowedPermissionModes?.includes('bypassPermissions')) {
            return 'bypassPermissions'
        }
        throw new Error(`Agent adapter ${opts.agentType} does not declare a YOLO-compatible permission mode.`)
    }
    const permissionMode = opts.permissionMode ?? resolveYoloPermissionMode()
    if (permissionMode && allowedPermissionModes && !allowedPermissionModes.includes(permissionMode as PermissionMode)) {
        await manager.dispose()
        throw new Error(`Permission mode ${permissionMode} is not available for agent ${opts.agentType}.`)
    }

    AgentRegistry.register(opts.agentType, factory)
    try {
        await runAgentSession({
            agentType: opts.agentType,
            startedBy: opts.startedBy,
            permissionMode,
            allowedPermissionModes,
            model: opts.model
        })
    } finally {
        await manager.dispose()
    }
}

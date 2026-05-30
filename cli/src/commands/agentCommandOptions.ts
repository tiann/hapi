import type { PermissionMode } from '@hapi/protocol/types'

export type RemoteAgentCommandOptions<TPermissionMode extends PermissionMode> = {
    startedBy?: 'runner' | 'terminal'
    startingMode?: 'local' | 'remote'
    permissionMode?: TPermissionMode
    model?: string
    modelReasoningEffort?: string
    resumeSessionId?: string
}

export function parseRemoteAgentCommandOptions<TPermissionMode extends PermissionMode>(
    args: string[],
    allowedPermissionModes: readonly TPermissionMode[]
): RemoteAgentCommandOptions<TPermissionMode> {
    const options: RemoteAgentCommandOptions<TPermissionMode> = {}
    let hasExplicitPermissionMode = false

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (arg === '--started-by') {
            options.startedBy = args[++i] as 'runner' | 'terminal'
        } else if (arg === '--hapi-starting-mode') {
            const value = args[++i]
            if (value === 'local' || value === 'remote') {
                options.startingMode = value
            } else {
                throw new Error('Invalid --hapi-starting-mode (expected local or remote)')
            }
        } else if (arg === '--permission-mode') {
            const mode = args[++i]
            if (!mode || !(allowedPermissionModes as readonly string[]).includes(mode)) {
                throw new Error(`Invalid --permission-mode value: ${mode ?? '(missing)'}`)
            }
            options.permissionMode = mode as TPermissionMode
            hasExplicitPermissionMode = true
        } else if (arg === '--yolo' && !hasExplicitPermissionMode) {
            options.permissionMode = 'yolo' as TPermissionMode
        } else if (arg === '--resume') {
            const sessionId = args[++i]
            if (!sessionId) {
                throw new Error('Missing --resume value')
            }
            options.resumeSessionId = sessionId
        } else if (arg === '--model') {
            const model = args[++i]
            if (!model) {
                throw new Error('Missing --model value')
            }
            options.model = model
        } else if (arg === '--model-reasoning-effort') {
            const modelReasoningEffort = args[++i]
            if (!modelReasoningEffort) {
                throw new Error('Missing --model-reasoning-effort value')
            }
            options.modelReasoningEffort = modelReasoningEffort
        }
    }

    return options
}

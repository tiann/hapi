import type { PermissionMode } from '@hapi/protocol/types'

export type RemoteAgentCommandOptions<TPermissionMode extends PermissionMode> = {
    startedBy?: 'runner' | 'terminal'
    // Control mode: who drives the session (terminal vs web). Orthogonal to
    // flavor and to how the agent process is launched.
    startingMode?: 'local' | 'remote'
    // Launch axis: run the agent as an interactive PTY terminal. Only pty-capable
    // flavors (claude has its own parser; agy) act on this; the rest ignore it.
    // Kept separate from `startingMode` so non-pty flavors never have to know
    // about pty (it always collapses to remote-controlled at the session level).
    interactive?: boolean
    permissionMode?: TPermissionMode
    model?: string
    effort?: string
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
            } else if (value === 'pty') {
                // pty is a launch flag, not a control mode — split it out so the
                // control axis stays 'local' | 'remote' (default) and only
                // pty-capable flavors read `interactive`.
                options.interactive = true
            } else {
                throw new Error('Invalid --hapi-starting-mode (expected local, remote, or pty)')
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
        } else if (arg === '-s' || arg === '--session') {
            // OpenCode-native resume flags (hapi opencode -s / --session <id>)
            const sessionId = args[++i]
            if (!sessionId) {
                throw new Error(`Missing ${arg} value`)
            }
            options.resumeSessionId = sessionId
        } else if (arg === '--session-id') {
            // Pi uses --session-id for exact session resume (RPC mode)
            const sessionId = args[++i]
            if (!sessionId) {
                throw new Error('Missing --session-id value')
            }
            options.resumeSessionId = sessionId
        } else if (arg === '--model') {
            const model = args[++i]
            if (!model) {
                throw new Error('Missing --model value')
            }
            options.model = model
        } else if (arg === '--effort') {
            const effort = args[++i]
            if (!effort) {
                throw new Error('Missing --effort value')
            }
            options.effort = effort
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

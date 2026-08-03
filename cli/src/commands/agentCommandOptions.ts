import type { PermissionMode } from '@hapi/protocol/types'

export type RemoteAgentCommandOptions<
    TPermissionMode extends PermissionMode,
    TStartingMode extends 'local' | 'remote' | 'pty' = 'local' | 'remote',
> = {
    startedBy?: 'runner' | 'terminal'
    startingMode?: TStartingMode
    permissionMode?: TPermissionMode
    model?: string
    effort?: string
    modelReasoningEffort?: string
    resumeSessionId?: string
    existingSessionId?: string
}

export function parseRemoteAgentCommandOptions<
    TPermissionMode extends PermissionMode,
    TStartingMode extends 'local' | 'remote' | 'pty' = 'local' | 'remote',
>(
    args: string[],
    allowedPermissionModes: readonly TPermissionMode[],
    allowedStartingModes?: readonly TStartingMode[],
): RemoteAgentCommandOptions<TPermissionMode, TStartingMode> {
    const options: RemoteAgentCommandOptions<TPermissionMode, TStartingMode> = {}
    const startingModes: readonly string[] = allowedStartingModes ?? ['local', 'remote']
    let hasExplicitPermissionMode = false

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (arg === '--started-by') {
            options.startedBy = args[++i] as 'runner' | 'terminal'
        } else if (arg === '--hapi-starting-mode') {
            const value = args[++i]
            if (startingModes.includes(value)) {
                options.startingMode = value as TStartingMode
            } else {
                throw new Error('Invalid --hapi-starting-mode (expected local, remote, or pty)')
            }
        } else if (arg === '--existing-session-id') {
            const sessionId = args[++i]
            if (!sessionId || sessionId.startsWith('-')) {
                throw new Error('Missing --existing-session-id value')
            }
            options.existingSessionId = sessionId
        } else if (arg === '--permission-mode') {
            const mode = args[++i]
            if (!mode || !(allowedPermissionModes as readonly string[]).includes(mode)) {
                throw new Error(`Invalid --permission-mode value: ${mode ?? '(missing)'}`)
            }
            options.permissionMode = mode as TPermissionMode
            hasExplicitPermissionMode = true
        } else if (arg === '--yolo' && !hasExplicitPermissionMode) {
            // --yolo means "auto-approve everything", but flavors name that mode
            // differently (opencode/gemini: 'yolo', agy: 'always-proceed'). Pick
            // whichever auto-approve mode this flavor actually allows instead of
            // hardcoding 'yolo' — otherwise agy gets a mode that isn't in its set
            // (AGY_PERMISSION_MODES) and downstream flavor validation rejects it.
            const yoloEquivalent = (['yolo', 'always-proceed', 'bypassPermissions'] as const)
                .find((m) => (allowedPermissionModes as readonly string[]).includes(m))
            if (yoloEquivalent) {
                options.permissionMode = yoloEquivalent as TPermissionMode
            }
        } else if (arg === '--hapi-session-id') {
            // Hub row to reuse on reopen/resume of a pty session (agy), so the id
            // stays stable instead of spawn-new + merge-delete (+ the 404 flash).
            // The runner only emits this for pty flavors whose parser consumes it.
            const id = args[++i]
            if (!id) {
                throw new Error('Missing --hapi-session-id value')
            }
            options.existingSessionId = id
        } else if (arg === '--resume') {
            const sessionId = args[++i]
            if (!sessionId) {
                throw new Error('Missing --resume value')
            }
            options.resumeSessionId = sessionId
        } else if (arg === '--existing-session-id') {
            const sessionId = args[++i]
            if (!sessionId || sessionId.startsWith('-')) {
                throw new Error('Missing --existing-session-id value')
            }
            options.existingSessionId = sessionId
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

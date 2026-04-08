import type { SessionProfile } from '@hapi/protocol'
import type {
    CodexCollaborationMode,
    CodexPermissionMode,
    CodexReasoningEffort,
    SessionType
} from './types'

export type CodexLaunchState = {
    model: string
    modelReasoningEffort: CodexReasoningEffort
    permissionMode: CodexPermissionMode
    collaborationMode: CodexCollaborationMode
    sessionType: SessionType
}

export function getBaseCodexLaunchState(): CodexLaunchState {
    return {
        model: 'auto',
        modelReasoningEffort: 'default',
        permissionMode: 'default',
        collaborationMode: 'default',
        sessionType: 'simple'
    }
}

export function applyCodexProfile(
    base: CodexLaunchState,
    profile: SessionProfile | null
): CodexLaunchState {
    if (!profile) {
        return { ...base }
    }

    return {
        model: profile.defaults.model ?? base.model,
        modelReasoningEffort: profile.defaults.modelReasoningEffort === 'minimal'
            ? 'default'
            : profile.defaults.modelReasoningEffort ?? base.modelReasoningEffort,
        permissionMode: profile.defaults.permissionMode ?? base.permissionMode,
        collaborationMode: profile.defaults.collaborationMode ?? base.collaborationMode,
        sessionType: profile.defaults.sessionType ?? base.sessionType
    }
}

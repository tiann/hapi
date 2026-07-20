import {
    CREATABLE_AGENT_FLAVORS,
    GROK_PERMISSION_MODES,
    type GrokPermissionMode
} from '@hapi/protocol'
import type { AgentType, LaunchEffort, CodexReasoningEffort, SessionType } from './types'

const DRAFT_STORAGE_KEY = 'hapi:new-session-form-draft'

export type NewSessionFormDraft = {
    agent: AgentType
    model: string
    cursorSelectedBase: string
    machineId: string | null
    effort: LaunchEffort
    modelReasoningEffort: CodexReasoningEffort
    yoloMode: boolean
    grokPermissionMode: GrokPermissionMode
    sessionType: SessionType
    worktreeName: string
}

export function saveNewSessionFormDraft(draft: NewSessionFormDraft): void {
    try {
        sessionStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft))
    } catch {
        // sessionStorage may be unavailable (private mode, quota)
    }
}

export function loadNewSessionFormDraft(): NewSessionFormDraft | null {
    try {
        const raw = sessionStorage.getItem(DRAFT_STORAGE_KEY)
        if (!raw) {
            return null
        }
        const parsed = JSON.parse(raw) as Partial<NewSessionFormDraft>
        if (typeof parsed.agent !== 'string' || typeof parsed.model !== 'string') {
            return null
        }
        // Coerce a stale/uncreatable agent (e.g. a pre-removal 'gemini' draft)
        // back to a launchable default. When the agent is coerced, also drop the
        // agent-dependent fields (model / cursor base / effort) so a Gemini
        // draft does not carry a Gemini model into the Claude fallback.
        const restoredAgent: AgentType = (CREATABLE_AGENT_FLAVORS as readonly string[]).includes(parsed.agent)
            ? (parsed.agent as AgentType)
            : 'claude'
        const agentPreserved = restoredAgent === parsed.agent
        return {
            agent: restoredAgent,
            model: agentPreserved ? parsed.model : 'auto',
            cursorSelectedBase: agentPreserved && typeof parsed.cursorSelectedBase === 'string'
                ? parsed.cursorSelectedBase
                : 'auto',
            machineId: typeof parsed.machineId === 'string' ? parsed.machineId : null,
            effort: agentPreserved ? ((parsed.effort as LaunchEffort | undefined) ?? 'auto') : 'auto',
            modelReasoningEffort: agentPreserved
                ? ((parsed.modelReasoningEffort as CodexReasoningEffort | undefined) ?? 'default')
                : 'default',
            yoloMode: Boolean(parsed.yoloMode),
            grokPermissionMode: agentPreserved
                && GROK_PERMISSION_MODES.includes(parsed.grokPermissionMode as GrokPermissionMode)
                ? parsed.grokPermissionMode as GrokPermissionMode
                : 'default',
            sessionType: (parsed.sessionType as SessionType | undefined) ?? 'simple',
            worktreeName: typeof parsed.worktreeName === 'string' ? parsed.worktreeName : ''
        }
    } catch {
        return null
    }
}

export function clearNewSessionFormDraft(): void {
    try {
        sessionStorage.removeItem(DRAFT_STORAGE_KEY)
    } catch {
        // ignore
    }
}

/** Restore draft after Browse → /sessions/new?directory=… remount. */
export function shouldRestoreNewSessionFormDraft(args: {
    initialDirectory?: string
    initialMachineId?: string
}): boolean {
    return Boolean(args.initialDirectory?.trim())
}

export function newSessionDraftMatchesMachine(
    draft: NewSessionFormDraft,
    machineId: string | null | undefined
): boolean {
    if (!draft.machineId || !machineId) {
        return true
    }
    return draft.machineId === machineId
}

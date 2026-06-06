import type { AgentType, ClaudeEffort, CodexReasoningEffort, SessionType } from './types'

const DRAFT_STORAGE_KEY = 'hapi:new-session-form-draft'

export type NewSessionFormDraft = {
    agent: AgentType
    model: string
    cursorSelectedBase: string
    machineId: string | null
    effort: ClaudeEffort
    modelReasoningEffort: CodexReasoningEffort
    yoloMode: boolean
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
        return {
            agent: parsed.agent as AgentType,
            model: parsed.model,
            cursorSelectedBase: typeof parsed.cursorSelectedBase === 'string' ? parsed.cursorSelectedBase : 'auto',
            machineId: typeof parsed.machineId === 'string' ? parsed.machineId : null,
            effort: (parsed.effort as ClaudeEffort | undefined) ?? 'auto',
            modelReasoningEffort: (parsed.modelReasoningEffort as CodexReasoningEffort | undefined) ?? 'default',
            yoloMode: Boolean(parsed.yoloMode),
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

import type { EditorTab } from '@/hooks/useEditorState'

const STORAGE_KEY = 'hapi-editor-state:v1'
const PAGE_INSTANCE_ID = `${Date.now()}-${Math.random().toString(36).slice(2)}`

export type PersistedEditorState = {
    machineId: string | null
    projectPath: string | null
    tabs: EditorTab[]
    activeTabId: string | null
    activeSessionId: string | null
    isTerminalCollapsed: boolean
}

function isBrowser(): boolean {
    return typeof window !== 'undefined' && typeof sessionStorage !== 'undefined'
}

function isTab(value: unknown): value is EditorTab {
    if (!value || typeof value !== 'object') return false
    const tab = value as Partial<EditorTab>
    if (typeof tab.id !== 'string' || typeof tab.label !== 'string') return false
    if (tab.type !== 'file' && tab.type !== 'terminal') return false
    if (tab.path !== undefined && typeof tab.path !== 'string') return false
    if (tab.shell !== undefined && typeof tab.shell !== 'string') return false
    if (tab.sessionId !== undefined && typeof tab.sessionId !== 'string') return false
    if (tab.machineId !== undefined && typeof tab.machineId !== 'string') return false
    if (tab.cwd !== undefined && typeof tab.cwd !== 'string') return false
    return true
}

function readStringOrNull(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value : null
}

export function loadPersistedEditorState(): PersistedEditorState | null {
    if (!isBrowser()) return null

    try {
        const raw = sessionStorage.getItem(STORAGE_KEY)
        if (!raw) return null
        const parsed: unknown = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object') return null
        const value = parsed as Partial<PersistedEditorState> & { pageInstanceId?: unknown }
        if (value.pageInstanceId !== PAGE_INSTANCE_ID) {
            sessionStorage.removeItem(STORAGE_KEY)
            return null
        }
        const tabs = Array.isArray(value.tabs) ? value.tabs.filter(isTab).map(tab => ({ ...tab, dirty: false })) : []
        const activeTabId = readStringOrNull(value.activeTabId)
        const activeSessionId = readStringOrNull(value.activeSessionId)
        return {
            machineId: readStringOrNull(value.machineId),
            projectPath: readStringOrNull(value.projectPath),
            tabs,
            activeTabId: activeTabId && tabs.some(tab => tab.id === activeTabId) ? activeTabId : tabs[0]?.id ?? null,
            activeSessionId,
            isTerminalCollapsed: value.isTerminalCollapsed === true,
        }
    } catch {
        return null
    }
}

export function savePersistedEditorState(state: PersistedEditorState): void {
    if (!isBrowser()) return

    try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
            ...state,
            pageInstanceId: PAGE_INSTANCE_ID,
            tabs: state.tabs.map(tab => ({ ...tab, dirty: false })),
        }))
    } catch {
        // Ignore storage errors.
    }
}

export function clearPersistedEditorState(): void {
    if (!isBrowser()) return

    try {
        sessionStorage.removeItem(STORAGE_KEY)
    } catch {
        // Ignore storage errors.
    }
}

import { useCallback, useRef, useState } from 'react'
import type { EditorTreeItem } from '@/types/editor'

export type EditorTab = {
    id: string
    type: 'file' | 'terminal'
    path?: string
    label: string
    shell?: string
    sessionId?: string
    machineId?: string
    cwd?: string
    dirty?: boolean
}

export type OpenTerminalOptions = {
    shell?: string
    sessionId?: string
    machineId?: string
    cwd?: string
}

export type EditorState = {
    machineId: string | null
    projectPath: string | null
    tabs: EditorTab[]
    activeTabId: string | null
    activeSessionId: string | null
    contextMenuFile: string | null
    contextMenuItems: EditorTreeItem[]
    contextMenuPosition: { x: number; y: number } | null
}

export type UseEditorStateResult = EditorState & {
    selectMachine: (id: string) => void
    selectProject: (path: string) => void
    setActiveSessionId: (sessionId: string | null) => void
    openFile: (filePath: string) => void
    openTerminal: (options?: string | OpenTerminalOptions) => void
    closeTab: (tabId: string) => void
    setTabDirty: (tabId: string, dirty: boolean) => void
    setActiveTabId: (tabId: string | null) => void
    showContextMenu: (filePath: string, x: number, y: number, items?: EditorTreeItem[]) => void
    hideContextMenu: () => void
}

function generateTabId(): string {
    return `tab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function getFileName(filePath: string): string {
    return filePath.split('/').filter(Boolean).pop() || filePath
}

export type InitialEditorState = {
    machineId?: string | null
    projectPath?: string | null
    tabs?: EditorTab[]
    activeTabId?: string | null
    activeSessionId?: string | null
}

export function useEditorState(initialMachine?: string, initialProject?: string, initialState?: InitialEditorState): UseEditorStateResult {
    const initialTabs = initialState?.tabs ?? []
    const initialActiveTabId = initialState?.activeTabId && initialTabs.some(tab => tab.id === initialState.activeTabId)
        ? initialState.activeTabId
        : initialTabs[0]?.id ?? null
    const [machineId, setMachineId] = useState<string | null>(initialMachine ?? initialState?.machineId ?? null)
    const [projectPath, setProjectPath] = useState<string | null>(initialProject ?? initialState?.projectPath ?? null)
    const [tabs, setTabsState] = useState<EditorTab[]>(initialTabs)
    const [activeTabId, setActiveTabIdState] = useState<string | null>(initialActiveTabId)
    const [activeSessionId, setActiveSessionId] = useState<string | null>(initialState?.activeSessionId ?? null)
    const [contextMenuFile, setContextMenuFile] = useState<string | null>(null)
    const [contextMenuItems, setContextMenuItems] = useState<EditorTreeItem[]>([])
    const [contextMenuPosition, setContextMenuPosition] = useState<{ x: number; y: number } | null>(null)

    const tabsRef = useRef<EditorTab[]>(initialTabs)
    const activeTabIdRef = useRef<string | null>(initialActiveTabId)

    const setTabs = useCallback((nextTabs: EditorTab[]) => {
        tabsRef.current = nextTabs
        setTabsState(nextTabs)
    }, [])

    const setActiveTabId = useCallback((tabId: string | null) => {
        activeTabIdRef.current = tabId
        setActiveTabIdState(tabId)
    }, [])

    const openFile = useCallback((filePath: string) => {
        const existingTab = tabsRef.current.find((tab) => tab.type === 'file' && tab.path === filePath)
        if (existingTab) {
            setActiveTabId(existingTab.id)
            return
        }

        const newTab: EditorTab = {
            id: generateTabId(),
            type: 'file',
            path: filePath,
            label: getFileName(filePath)
        }
        setTabs([...tabsRef.current, newTab])
        setActiveTabId(newTab.id)
    }, [setActiveTabId, setTabs])

    const openTerminal = useCallback((options?: string | OpenTerminalOptions) => {
        const shellCandidate = typeof options === 'string' ? options : options?.shell
        const shellName = typeof shellCandidate === 'string' && shellCandidate.trim() ? shellCandidate : 'bash'
        const sessionId = options && typeof options === 'object' && typeof options.sessionId === 'string' && options.sessionId.trim()
            ? options.sessionId
            : undefined
        const machineId = options && typeof options === 'object' && typeof options.machineId === 'string' && options.machineId.trim()
            ? options.machineId
            : undefined
        const cwd = options && typeof options === 'object' && typeof options.cwd === 'string' && options.cwd.trim()
            ? options.cwd
            : undefined
        const terminalCount = tabsRef.current.filter((tab) => tab.type === 'terminal').length
        const newTab: EditorTab = {
            id: generateTabId(),
            type: 'terminal',
            label: `Terminal: ${shellName}${terminalCount > 0 ? ` (${terminalCount + 1})` : ''}`,
            shell: shellName,
            sessionId,
            machineId,
            cwd
        }
        setTabs([...tabsRef.current, newTab])
        setActiveTabId(newTab.id)
    }, [setActiveTabId, setTabs])

    const closeTab = useCallback((tabId: string) => {
        const previousTabs = tabsRef.current
        const nextTabs = previousTabs.filter((tab) => tab.id !== tabId)

        if (activeTabIdRef.current === tabId) {
            if (nextTabs.length > 0) {
                const closedIndex = previousTabs.findIndex((tab) => tab.id === tabId)
                const nextIndex = Math.min(Math.max(closedIndex, 0), nextTabs.length - 1)
                setActiveTabId(nextTabs[nextIndex].id)
            } else {
                setActiveTabId(null)
            }
        }

        setTabs(nextTabs)
    }, [setActiveTabId, setTabs])

    const setTabDirty = useCallback((tabId: string, dirty: boolean) => {
        setTabs(tabsRef.current.map((tab) => (
            tab.id === tabId ? { ...tab, dirty } : tab
        )))
    }, [setTabs])

    const showContextMenu = useCallback((filePath: string, x: number, y: number, items?: EditorTreeItem[]) => {
        setContextMenuFile(filePath)
        setContextMenuItems(items && items.length > 0 ? items : [{ path: filePath, type: 'file' }])
        setContextMenuPosition({ x, y })
    }, [])

    const hideContextMenu = useCallback(() => {
        setContextMenuFile(null)
        setContextMenuItems([])
        setContextMenuPosition(null)
    }, [])

    const selectMachine = useCallback((id: string) => {
        setMachineId(id)
        setProjectPath(null)
        setTabs([])
        setActiveTabId(null)
    }, [setActiveTabId, setTabs])

    const selectProject = useCallback((path: string) => {
        if (projectPath !== path) {
            setTabs([])
            setActiveTabId(null)
            setActiveSessionId(null)
        }
        setProjectPath(path)
    }, [projectPath, setActiveTabId, setTabs])

    return {
        machineId,
        projectPath,
        tabs,
        activeTabId,
        activeSessionId,
        contextMenuFile,
        contextMenuItems,
        contextMenuPosition,
        selectMachine,
        selectProject,
        setActiveSessionId,
        openFile,
        openTerminal,
        closeTab,
        setTabDirty,
        setActiveTabId,
        showContextMenu,
        hideContextMenu
    }
}

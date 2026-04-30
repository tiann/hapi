import { useCallback, useRef, useState } from 'react'

export type EditorTab = {
    id: string
    type: 'file' | 'terminal'
    path?: string
    label: string
    shell?: string
    dirty?: boolean
}

export type EditorState = {
    machineId: string | null
    projectPath: string | null
    tabs: EditorTab[]
    activeTabId: string | null
    activeSessionId: string | null
    contextMenuFile: string | null
    contextMenuPosition: { x: number; y: number } | null
}

export type UseEditorStateResult = EditorState & {
    selectMachine: (id: string) => void
    selectProject: (path: string) => void
    setActiveSessionId: (sessionId: string | null) => void
    openFile: (filePath: string) => void
    openTerminal: (shell?: string) => void
    closeTab: (tabId: string) => void
    setTabDirty: (tabId: string, dirty: boolean) => void
    setActiveTabId: (tabId: string | null) => void
    showContextMenu: (filePath: string, x: number, y: number) => void
    hideContextMenu: () => void
}

function generateTabId(): string {
    return `tab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function getFileName(filePath: string): string {
    return filePath.split('/').filter(Boolean).pop() || filePath
}

export function useEditorState(initialMachine?: string, initialProject?: string): UseEditorStateResult {
    const [machineId, setMachineId] = useState<string | null>(initialMachine ?? null)
    const [projectPath, setProjectPath] = useState<string | null>(initialProject ?? null)
    const [tabs, setTabsState] = useState<EditorTab[]>([])
    const [activeTabId, setActiveTabIdState] = useState<string | null>(null)
    const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
    const [contextMenuFile, setContextMenuFile] = useState<string | null>(null)
    const [contextMenuPosition, setContextMenuPosition] = useState<{ x: number; y: number } | null>(null)

    const tabsRef = useRef<EditorTab[]>([])
    const activeTabIdRef = useRef<string | null>(null)

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

    const openTerminal = useCallback((shell?: string) => {
        const shellName = typeof shell === 'string' && shell.trim() ? shell : 'bash'
        const terminalCount = tabsRef.current.filter((tab) => tab.type === 'terminal').length
        const newTab: EditorTab = {
            id: generateTabId(),
            type: 'terminal',
            label: `Terminal: ${shellName}${terminalCount > 0 ? ` (${terminalCount + 1})` : ''}`,
            shell: shellName
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

    const showContextMenu = useCallback((filePath: string, x: number, y: number) => {
        setContextMenuFile(filePath)
        setContextMenuPosition({ x, y })
    }, [])

    const hideContextMenu = useCallback(() => {
        setContextMenuFile(null)
        setContextMenuPosition(null)
    }, [])

    const selectMachine = useCallback((id: string) => {
        setMachineId(id)
        setProjectPath(null)
        setTabs([])
        setActiveTabId(null)
    }, [setActiveTabId, setTabs])

    const selectProject = useCallback((path: string) => {
        setProjectPath(path)
    }, [])

    return {
        machineId,
        projectPath,
        tabs,
        activeTabId,
        activeSessionId,
        contextMenuFile,
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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { EditorTreeItem } from '@/types/editor'
import { appendEditorChatDraft, appendEditorChatDraftWithSelection, buildAddSelectionToChatText, expandSelectionRefs } from '@/lib/editor-chat-draft'
import { queryKeys } from '@/lib/query-keys'
import { useEditorPaneResize } from '@/hooks/useEditorPaneResize'
import { useEditorState } from '@/hooks/useEditorState'
import { useEditorNewSession } from '@/hooks/mutations/useEditorNewSession'
import { EditorChatPanel } from './EditorChatPanel'
import { EditorContextMenu } from './EditorContextMenu'
import { EditorFileTree } from './EditorFileTree'
import { EditorHeader } from './EditorHeader'
import { EditorSessionList } from './EditorSessionList'
import { EditorTabs } from './EditorTabs'
import { EditorTerminal } from './EditorTerminal'

function joinPath(base: string, name: string): string {
    return base.endsWith('/') ? `${base}${name}` : `${base}/${name}`
}

function getParentPath(filePath: string): string {
    const normalized = filePath.replace(/\/+$/, '')
    const index = normalized.lastIndexOf('/')
    if (index <= 0) return '/'
    return normalized.slice(0, index)
}

function getRelativePath(rootPath: string | null, filePath: string): string {
    if (!rootPath) {
        return filePath.replace(/^\/+/, '')
    }

    const root = rootPath.replace(/\/+$/, '')
    if (filePath === root) {
        return filePath.split('/').filter(Boolean).pop() || filePath
    }
    if (filePath.startsWith(`${root}/`)) {
        return filePath.slice(root.length + 1)
    }
    return filePath.replace(/^\/+/, '')
}

function uniqueItems(items: EditorTreeItem[]): EditorTreeItem[] {
    const seen = new Set<string>()
    const result: EditorTreeItem[] = []
    for (const item of items) {
        if (seen.has(item.path)) continue
        seen.add(item.path)
        result.push(item)
    }
    return result
}

function isPathInsideDirectory(path: string, directoryPath: string): boolean {
    const normalizedPath = path.replace(/\/+$/, '')
    const normalizedDirectory = directoryPath.replace(/\/+$/, '')
    return normalizedPath === normalizedDirectory || normalizedPath.startsWith(`${normalizedDirectory}/`)
}

function pruneDeleteItems(items: EditorTreeItem[]): EditorTreeItem[] {
    const unique = uniqueItems(items)
    const directories = unique.filter((item) => item.type === 'directory')
    return unique.filter((item) => {
        if (item.type === 'directory') {
            return !directories.some((directory) => (
                directory.path !== item.path && isPathInsideDirectory(item.path, directory.path)
            ))
        }
        return !directories.some((directory) => isPathInsideDirectory(item.path, directory.path))
    })
}

function DeleteConfirmModal(props: {
    items: EditorTreeItem[]
    projectPath: string | null
    isDeleting: boolean
    error: string | null
    onCancel: () => void
    onConfirm: () => void
}) {
    if (props.items.length === 0) return null

    const title = props.items.length === 1
        ? `Delete ${getRelativePath(props.projectPath, props.items[0].path)}?`
        : `Delete ${props.items.length} items?`
    const visibleItems = props.items.slice(0, 5)
    const hiddenCount = props.items.length - visibleItems.length

    return (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4">
            <div
                role="dialog"
                aria-modal="true"
                aria-label={title}
                className="w-full max-w-md rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-4 text-sm text-[var(--app-fg)] shadow-xl"
            >
                <h2 className="text-base font-semibold">{title}</h2>
                <p className="mt-2 text-xs text-[var(--app-hint)]">
                    This will permanently delete the selected file/folder items.
                </p>
                <ul className="mt-3 max-h-40 overflow-auto rounded border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-2 text-xs">
                    {visibleItems.map((item) => (
                        <li key={item.path} className="truncate">
                            {getRelativePath(props.projectPath, item.path)}
                        </li>
                    ))}
                    {hiddenCount > 0 ? (
                        <li className="text-[var(--app-hint)]">and {hiddenCount} more…</li>
                    ) : null}
                </ul>
                {props.error ? (
                    <div className="mt-3 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs text-red-500">
                        {props.error}
                    </div>
                ) : null}
                <div className="mt-4 flex justify-end gap-2">
                    <button
                        type="button"
                        className="rounded border border-[var(--app-border)] px-3 py-1.5 text-xs hover:bg-[var(--app-subtle-bg)]"
                        disabled={props.isDeleting}
                        onClick={props.onCancel}
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        className="rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-60"
                        disabled={props.isDeleting}
                        onClick={props.onConfirm}
                    >
                        {props.isDeleting ? 'Deleting…' : 'Delete'}
                    </button>
                </div>
            </div>
        </div>
    )
}

export function EditorLayout(props: {
    api: ApiClient | null
    initialMachineId?: string
    initialProjectPath?: string
}) {
    const editor = useEditorState(props.initialMachineId, props.initialProjectPath)
    const panes = useEditorPaneResize()
    const queryClient = useQueryClient()
    const [pendingDraftText, setPendingDraftText] = useState<string | undefined>(undefined)
    const [newFileTargetPath, setNewFileTargetPath] = useState<string | null>(null)
    const [isTerminalCollapsed, setIsTerminalCollapsed] = useState(true)
    const [deleteItems, setDeleteItems] = useState<EditorTreeItem[]>([])
    const [isDeletingItems, setIsDeletingItems] = useState(false)
    const [deleteError, setDeleteError] = useState<string | null>(null)
    const pendingFileAfterSessionRef = useRef<string[] | null>(null)
    const selectionMapRef = useRef<Map<string, { path: string; start: number; end: number; content: string }>>(new Map())
    const lastActiveTerminalTabIdRef = useRef<string | null>(null)

    const fileTabs = useMemo(
        () => editor.tabs.filter((tab) => tab.type === 'file'),
        [editor.tabs]
    )
    const terminalTabs = useMemo(
        () => editor.tabs.filter((tab) => tab.type === 'terminal'),
        [editor.tabs]
    )
    const activeFileTab = useMemo(
        () => fileTabs.find((tab) => tab.id === editor.activeTabId) ?? fileTabs[fileTabs.length - 1] ?? null,
        [editor.activeTabId, fileTabs]
    )
    // Track last active terminal tab so fallback preserves user's selection
    useEffect(() => {
        if (editor.activeTabId && terminalTabs.some(t => t.id === editor.activeTabId)) {
            lastActiveTerminalTabIdRef.current = editor.activeTabId
        }
    }, [editor.activeTabId, terminalTabs])

    const activeTerminalTab = useMemo(
        () => terminalTabs.find((tab) => tab.id === editor.activeTabId)
            ?? terminalTabs.find(t => t.id === lastActiveTerminalTabIdRef.current)
            ?? terminalTabs[terminalTabs.length - 1]
            ?? null,
        [editor.activeTabId, terminalTabs]
    )
    const activeFilePath = activeFileTab?.path ?? null

    const newSession = useEditorNewSession({
        api: props.api,
        machineId: editor.machineId,
        projectPath: editor.projectPath,
        onCreated: (sessionId) => {
            editor.setActiveSessionId(sessionId)
            const pendingFiles = pendingFileAfterSessionRef.current
            if (pendingFiles?.length) {
                setPendingDraftText(pendingFiles.reduce((draft, filePath) => appendEditorChatDraft(draft, filePath), ''))
                pendingFileAfterSessionRef.current = null
            }
        }
    })

    const handleCopyPath = useCallback(async (items: EditorTreeItem[]) => {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(uniqueItems(items).map((item) => item.path).join('\n'))
        }
    }, [])

    const handleCopyRelativePath = useCallback(async (items: EditorTreeItem[]) => {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(uniqueItems(items).map((item) => getRelativePath(editor.projectPath, item.path)).join('\n'))
        }
    }, [editor.projectPath])

    const handleRefreshPath = useCallback((items: EditorTreeItem[]) => {
        if (!editor.machineId) return

        for (const item of uniqueItems(items)) {
            void queryClient.invalidateQueries({
                queryKey: queryKeys.editorDirectory(editor.machineId, getParentPath(item.path))
            })
            void queryClient.invalidateQueries({
                queryKey: queryKeys.editorDirectory(editor.machineId, item.path)
            })
        }
    }, [editor.machineId, queryClient])

    const handleRequestDelete = useCallback((items: EditorTreeItem[]) => {
        setDeleteError(null)
        setDeleteItems(pruneDeleteItems(items))
    }, [])

    const handleConfirmDelete = useCallback(async () => {
        if (!props.api || !editor.machineId || deleteItems.length === 0) return

        setIsDeletingItems(true)
        setDeleteError(null)
        try {
            for (const item of deleteItems) {
                const response = await props.api.deleteEditorFile(editor.machineId, item.path)
                if (!response.success) {
                    setDeleteError(response.error ?? `Failed to delete ${getRelativePath(editor.projectPath, item.path)}`)
                    return
                }
            }

            for (const item of deleteItems) {
                void queryClient.invalidateQueries({
                    queryKey: queryKeys.editorDirectory(editor.machineId, getParentPath(item.path))
                })
                void queryClient.invalidateQueries({
                    queryKey: queryKeys.editorDirectory(editor.machineId, item.path)
                })
            }
            for (const tab of editor.tabs) {
                if (!tab.path) continue
                if (deleteItems.some((item) => (
                    item.type === 'directory'
                        ? isPathInsideDirectory(tab.path!, item.path)
                        : tab.path === item.path
                ))) {
                    editor.closeTab(tab.id)
                }
            }
            setDeleteItems([])
        } finally {
            setIsDeletingItems(false)
        }
    }, [deleteItems, editor, props.api, queryClient])

    const handleAddToChat = useCallback((items: EditorTreeItem[]) => {
        const paths = uniqueItems(items).map((item) => item.path)
        if (editor.activeSessionId) {
            setPendingDraftText((current) => paths.reduce((draft, filePath) => appendEditorChatDraft(draft, filePath), current ?? ''))
            return
        }

        pendingFileAfterSessionRef.current = paths
        newSession.createSession()
    }, [editor.activeSessionId, newSession])

    const handleAddSelectionToChat = useCallback((filePath: string, startLine: number, endLine: number, content: string) => {
        const refKey = buildAddSelectionToChatText(filePath, startLine, endLine)
        selectionMapRef.current.set(refKey, { path: filePath, start: startLine, end: endLine, content })

        if (editor.activeSessionId) {
            setPendingDraftText((current) => appendEditorChatDraftWithSelection(current ?? '', filePath, startLine, endLine))
            return
        }

        // No session yet: just append to draft, selection map persists
        setPendingDraftText((current) => appendEditorChatDraftWithSelection(current ?? '', filePath, startLine, endLine))
    }, [editor.activeSessionId])

    const handleAddTerminalToChat = useCallback((text: string) => {
        if (!text) return
        if (editor.activeSessionId) {
            setPendingDraftText((current) => {
                const draft = (current ?? '').trimEnd()
                if (draft.length === 0) return text
                return `${draft}\n${text}`
            })
            return
        }
        setPendingDraftText((current) => {
            const draft = (current ?? '').trimEnd()
            if (draft.length === 0) return text
            return `${draft}\n${text}`
        })
    }, [editor.activeSessionId])

    const handleExpandDraft = useCallback((text: string): string => {
        return expandSelectionRefs(text, selectionMapRef.current)
    }, [])

    const handleOpenItems = useCallback((items: EditorTreeItem[]) => {
        for (const item of uniqueItems(items)) {
            if (item.type === 'file') {
                editor.openFile(item.path)
            }
        }
    }, [editor])

    const handleNewFile = useCallback((targetPath: string) => {
        setNewFileTargetPath(targetPath)
    }, [])

    const handleNewFileFromTabs = useCallback(() => {
        setNewFileTargetPath(activeFilePath ?? editor.projectPath)
    }, [activeFilePath, editor.projectPath])

    const handleOpenTerminal = useCallback(() => {
        if (editor.machineId && editor.projectPath) {
            editor.openTerminal({ machineId: editor.machineId, cwd: editor.projectPath })
            setIsTerminalCollapsed(false)
            return
        }
    }, [editor])

    const handleCancelNewFile = useCallback(() => {
        setNewFileTargetPath(null)
    }, [])

    const handleCreateFile = useCallback(async (parentPath: string, fileName: string) => {
        if (!props.api || !editor.machineId) {
            return { success: false, error: 'Select a machine before creating files' }
        }

        const targetPath = joinPath(parentPath, fileName)
        const response = await props.api.createEditorFile(editor.machineId, targetPath, '')
        if (!response.success) {
            return { success: false, error: response.error ?? 'Failed to create file' }
        }

        const createdPath = response.path ?? targetPath
        await queryClient.invalidateQueries({
            queryKey: queryKeys.editorDirectory(editor.machineId, parentPath)
        })
        setNewFileTargetPath(null)
        editor.openFile(createdPath)
        return { success: true, path: createdPath }
    }, [editor, props.api, queryClient])

    const handleSelectSession = useCallback((sessionId: string) => {
        editor.setActiveSessionId(sessionId)
    }, [editor])

    const handleSelectMachine = useCallback((machineId: string) => {
        setPendingDraftText(undefined)
        pendingFileAfterSessionRef.current = null
        editor.selectMachine(machineId)
    }, [editor])

    const handleSelectProject = useCallback((projectPath: string) => {
        setPendingDraftText(undefined)
        pendingFileAfterSessionRef.current = null
        editor.selectProject(projectPath)
    }, [editor])

    if (!props.api) {
        return (
            <div className="flex h-full items-center justify-center p-4 text-sm text-red-500">
                Editor unavailable: API not connected
            </div>
        )
    }

    return (
        <div data-testid="editor-layout-root" className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--app-bg)] text-[var(--app-fg)]">
            <EditorHeader
                api={props.api}
                machineId={editor.machineId}
                projectPath={editor.projectPath}
                onSelectMachine={handleSelectMachine}
                onSelectProject={handleSelectProject}
            />

            <div data-testid="editor-layout-body" className="flex min-h-0 flex-1 overflow-hidden">
                <aside className="min-h-0 shrink-0 overflow-hidden border-r border-[var(--app-border)]" style={{ width: panes.leftWidth }}>
                    <EditorFileTree
                        api={props.api}
                        machineId={editor.machineId}
                        projectPath={editor.projectPath}
                        onOpenFile={editor.openFile}
                        onContextMenu={editor.showContextMenu}
                        activeFilePath={activeFilePath}
                        newFileTargetPath={newFileTargetPath}
                        onCreateFile={handleCreateFile}
                        onCancelNewFile={handleCancelNewFile}
                    />
                </aside>
                <div
                    role="separator"
                    aria-label="Resize file tree"
                    className="w-1 shrink-0 cursor-col-resize hover:bg-[var(--app-border)]"
                    onPointerDown={panes.onLeftResizePointerDown}
                />

                <main data-testid="editor-main-pane" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                    <div data-testid="editor-tabs-region" className="min-h-0 flex-1 overflow-hidden">
                        <EditorTabs
                            api={props.api}
                            machineId={editor.machineId}
                            tabs={fileTabs}
                            activeTabId={activeFileTab?.id ?? null}
                            onSelectTab={editor.setActiveTabId}
                            onCloseTab={editor.closeTab}
                            onNewFile={handleNewFileFromTabs}
                            onDirtyChange={editor.setTabDirty}
                            onAddSelectionToChat={handleAddSelectionToChat}
                        />
                    </div>
                    {!isTerminalCollapsed && (
                        <div
                            role="separator"
                            aria-label="Resize terminal panel"
                            className="h-1 shrink-0 cursor-row-resize hover:bg-[var(--app-border)]"
                            onPointerDown={panes.onTerminalResizePointerDown}
                        />
                    )}
                    <div className="shrink-0" style={{ height: isTerminalCollapsed ? 32 : panes.terminalHeight }}>
                        <EditorTerminal
                            api={props.api}
                            tabs={terminalTabs}
                            activeTabId={activeTerminalTab?.id ?? null}
                            isCollapsed={isTerminalCollapsed}
                            onSelectTab={editor.setActiveTabId}
                            onCloseTab={editor.closeTab}
                            onOpenTerminal={handleOpenTerminal}
                            onToggleCollapsed={() => setIsTerminalCollapsed((current) => !current)}
                            onAddToChat={handleAddTerminalToChat}
                        />
                    </div>
                </main>

                <div
                    role="separator"
                    aria-label="Resize sessions panel"
                    className="w-1 shrink-0 cursor-col-resize hover:bg-[var(--app-border)]"
                    onPointerDown={panes.onRightResizePointerDown}
                />
                <aside className="flex min-h-0 shrink-0 flex-col border-l border-[var(--app-border)]" style={{ width: panes.rightWidth }}>
                    <div className="min-h-0 flex-[0_0_220px]">
                        <EditorSessionList
                            api={props.api}
                            machineId={editor.machineId}
                            projectPath={editor.projectPath}
                            activeSessionId={editor.activeSessionId}
                            onSelectSession={handleSelectSession}
                            onNewSession={newSession.createSession}
                        />
                    </div>
                    {newSession.error ? (
                        <div className="border-b border-[var(--app-border)] px-3 py-2 text-xs text-red-500">
                            {newSession.error}
                        </div>
                    ) : null}
                    <div className="min-h-0 flex-1">
                        <EditorChatPanel
                            api={props.api}
                            sessionId={editor.activeSessionId}
                            pendingDraftText={pendingDraftText}
                            onDraftConsumed={() => setPendingDraftText(undefined)}
                            onExpandDraft={handleExpandDraft}
                        />
                    </div>
                </aside>
            </div>

            <EditorContextMenu
                filePath={editor.contextMenuFile}
                position={editor.contextMenuPosition}
                items={editor.contextMenuItems}
                onOpen={handleOpenItems}
                onNewFile={handleNewFile}
                onAddToChat={handleAddToChat}
                onCopyPath={handleCopyPath}
                onCopyRelativePath={handleCopyRelativePath}
                onRefresh={handleRefreshPath}
                onDelete={handleRequestDelete}
                onClose={editor.hideContextMenu}
            />
            <DeleteConfirmModal
                items={deleteItems}
                projectPath={editor.projectPath}
                isDeleting={isDeletingItems}
                error={deleteError}
                onCancel={() => {
                    setDeleteItems([])
                    setDeleteError(null)
                }}
                onConfirm={() => { void handleConfirmDelete() }}
            />
        </div>
    )
}

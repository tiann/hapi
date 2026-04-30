import { useCallback, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { appendEditorChatDraft } from '@/lib/editor-chat-draft'
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
    const [isTerminalCollapsed, setIsTerminalCollapsed] = useState(false)
    const pendingFileAfterSessionRef = useRef<string | null>(null)
    const activeFilePath = editor.tabs.find((tab) => (
        tab.id === editor.activeTabId && tab.type === 'file'
    ))?.path ?? null

    const newSession = useEditorNewSession({
        api: props.api,
        machineId: editor.machineId,
        projectPath: editor.projectPath,
        onCreated: (sessionId) => {
            editor.setActiveSessionId(sessionId)
            const pendingFile = pendingFileAfterSessionRef.current
            if (pendingFile) {
                setPendingDraftText(appendEditorChatDraft('', pendingFile))
                pendingFileAfterSessionRef.current = null
            }
        }
    })

    const handleCopyPath = useCallback(async (filePath: string) => {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(filePath)
        }
    }, [])

    const handleAddToChat = useCallback((filePath: string) => {
        if (editor.activeSessionId) {
            setPendingDraftText((current) => appendEditorChatDraft(current ?? '', filePath))
            return
        }

        pendingFileAfterSessionRef.current = filePath
        newSession.createSession()
    }, [editor.activeSessionId, newSession])

    const handleNewFile = useCallback((targetPath: string) => {
        setNewFileTargetPath(targetPath)
    }, [])

    const handleNewFileFromTabs = useCallback(() => {
        setNewFileTargetPath(activeFilePath ?? editor.projectPath)
    }, [activeFilePath, editor.projectPath])

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
                            tabs={editor.tabs}
                            activeTabId={editor.activeTabId}
                            onSelectTab={editor.setActiveTabId}
                            onCloseTab={editor.closeTab}
                            onNewFile={handleNewFileFromTabs}
                            onDirtyChange={editor.setTabDirty}
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
                            tabs={editor.tabs}
                            activeTabId={editor.activeTabId}
                            isCollapsed={isTerminalCollapsed}
                            onSelectTab={editor.setActiveTabId}
                            onCloseTab={editor.closeTab}
                            onOpenTerminal={editor.openTerminal}
                            onToggleCollapsed={() => setIsTerminalCollapsed((current) => !current)}
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
                        />
                    </div>
                </aside>
            </div>

            <EditorContextMenu
                filePath={editor.contextMenuFile}
                position={editor.contextMenuPosition}
                onOpen={editor.openFile}
                onNewFile={handleNewFile}
                onAddToChat={handleAddToChat}
                onCopyPath={handleCopyPath}
                onClose={editor.hideContextMenu}
            />
        </div>
    )
}

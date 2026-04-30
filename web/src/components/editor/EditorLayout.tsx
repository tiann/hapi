import { useCallback, useRef, useState } from 'react'
import type { ApiClient } from '@/api/client'
import { appendEditorChatDraft } from '@/lib/editor-chat-draft'
import { useEditorState } from '@/hooks/useEditorState'
import { useEditorNewSession } from '@/hooks/mutations/useEditorNewSession'
import { EditorChatPanel } from './EditorChatPanel'
import { EditorContextMenu } from './EditorContextMenu'
import { EditorFileTree } from './EditorFileTree'
import { EditorHeader } from './EditorHeader'
import { EditorSessionList } from './EditorSessionList'
import { EditorTabs } from './EditorTabs'
import { EditorTerminal } from './EditorTerminal'

export function EditorLayout(props: {
    api: ApiClient | null
    initialMachineId?: string
    initialProjectPath?: string
}) {
    const editor = useEditorState(props.initialMachineId, props.initialProjectPath)
    const [pendingDraftText, setPendingDraftText] = useState<string | undefined>(undefined)
    const pendingFileAfterSessionRef = useRef<string | null>(null)

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
        <div className="flex h-full min-h-0 flex-col bg-[var(--app-bg)] text-[var(--app-fg)]">
            <EditorHeader
                api={props.api}
                machineId={editor.machineId}
                projectPath={editor.projectPath}
                onSelectMachine={handleSelectMachine}
                onSelectProject={handleSelectProject}
            />

            <div className="flex min-h-0 flex-1">
                <aside className="min-h-0 shrink-0 border-r border-[var(--app-border)]" style={{ width: 260 }}>
                    <EditorFileTree
                        api={props.api}
                        machineId={editor.machineId}
                        projectPath={editor.projectPath}
                        onOpenFile={editor.openFile}
                        onContextMenu={editor.showContextMenu}
                    />
                </aside>

                <main className="flex min-w-0 flex-1 flex-col">
                    <div className="min-h-0 flex-1">
                        <EditorTabs
                            api={props.api}
                            machineId={editor.machineId}
                            tabs={editor.tabs}
                            activeTabId={editor.activeTabId}
                            onSelectTab={editor.setActiveTabId}
                            onCloseTab={editor.closeTab}
                            onOpenTerminal={editor.openTerminal}
                        />
                    </div>
                    <div className="shrink-0" style={{ height: 160 }}>
                        <EditorTerminal
                            tabs={editor.tabs}
                            activeTabId={editor.activeTabId}
                            onSelectTab={editor.setActiveTabId}
                            onCloseTab={editor.closeTab}
                            onOpenTerminal={editor.openTerminal}
                        />
                    </div>
                </main>

                <aside className="flex min-h-0 shrink-0 flex-col border-l border-[var(--app-border)]" style={{ width: 380 }}>
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
                onAddToChat={handleAddToChat}
                onCopyPath={handleCopyPath}
                onClose={editor.hideContextMenu}
            />
        </div>
    )
}

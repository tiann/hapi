import { useEffect, useMemo, useRef } from 'react'
import { basicSetup, EditorView } from 'codemirror'
import { oneDark } from '@codemirror/theme-one-dark'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { go } from '@codemirror/lang-go'
import type { EditorTab } from '@/hooks/useEditorState'
import type { ApiClient } from '@/api/client'
import { FileIcon } from '@/components/FileIcon'
import { useEditorFile } from '@/hooks/queries/useEditorFile'

const editorScrollTheme = EditorView.theme({
    '&': {
        height: '100%'
    },
    '.cm-scroller': {
        overflow: 'auto'
    }
})

type LanguageExtension =
    | ReturnType<typeof javascript>
    | ReturnType<typeof json>
    | ReturnType<typeof css>
    | ReturnType<typeof html>
    | ReturnType<typeof markdown>
    | ReturnType<typeof python>
    | ReturnType<typeof rust>
    | ReturnType<typeof go>

function getLanguageExtension(filePath: string): LanguageExtension | null {
    const ext = filePath.split('.').pop()?.toLowerCase()
    switch (ext) {
        case 'js':
        case 'jsx':
        case 'mjs':
        case 'cjs':
            return javascript({ jsx: true, typescript: false })
        case 'ts':
        case 'tsx':
        case 'mts':
        case 'cts':
            return javascript({ jsx: true, typescript: true })
        case 'json':
            return json()
        case 'css':
        case 'scss':
        case 'less':
            return css()
        case 'html':
        case 'htm':
            return html()
        case 'md':
        case 'mdx':
            return markdown()
        case 'py':
            return python()
        case 'rs':
            return rust()
        case 'go':
            return go()
        default:
            return null
    }
}

function getFileExtensionLabel(filePath: string): string {
    const ext = filePath.split('.').pop()
    return ext ? ext.toUpperCase() : 'TEXT'
}

function useCodeMirror(
    containerRef: React.RefObject<HTMLDivElement | null>,
    content: string | null,
    filePath: string | null
): void {
    const viewRef = useRef<EditorView | null>(null)
    const contentReady = content !== null

    useEffect(() => {
        const container = containerRef.current
        if (!container || !contentReady) return

        if (viewRef.current) {
            viewRef.current.destroy()
            viewRef.current = null
        }

        const langExt = filePath ? getLanguageExtension(filePath) : null
        const extensions = [
            basicSetup,
            oneDark,
            editorScrollTheme,
            EditorView.editable.of(false),
        ]
        if (langExt) {
            extensions.push(langExt)
        }

        const view = new EditorView({
            doc: content ?? '',
            extensions,
            parent: container,
        })
        viewRef.current = view
        container.style.height = '100%'

        return () => {
            view.destroy()
            if (viewRef.current === view) {
                viewRef.current = null
            }
        }
    }, [containerRef, filePath, contentReady])

    useEffect(() => {
        const view = viewRef.current
        if (!view || content === null) return
        const currentContent = view.state.doc.toString()
        if (currentContent !== content) {
            view.dispatch({
                changes: {
                    from: 0,
                    to: view.state.doc.length,
                    insert: content
                }
            })
        }
    }, [content])
}

function FileTabContent(props: {
    api: ApiClient | null
    machineId: string | null
    filePath: string
}) {
    const containerRef = useRef<HTMLDivElement>(null)
    const { content, isLoading, error } = useEditorFile(props.api, props.machineId, props.filePath)
    useCodeMirror(containerRef, content, props.filePath)

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-full text-xs text-[var(--app-hint)]">
                Loading...
            </div>
        )
    }

    if (error) {
        return (
            <div className="flex items-center justify-center h-full text-xs text-red-500 p-4">
                {error}
            </div>
        )
    }

    return <div ref={containerRef} data-testid="codemirror-host" className="h-full min-h-0 w-full overflow-hidden" />
}

export function EditorTabs(props: {
    api: ApiClient | null
    machineId: string | null
    tabs: EditorTab[]
    activeTabId: string | null
    onSelectTab: (tabId: string) => void
    onCloseTab: (tabId: string) => void
    onOpenTerminal: () => void
}) {
    const activeTab = useMemo(
        () => props.tabs.find((tab) => tab.id === props.activeTabId) ?? null,
        [props.activeTabId, props.tabs]
    )

    return (
        <div data-testid="editor-tabs-root" className="flex h-full min-h-0 flex-col overflow-hidden">
            <div className="flex items-center bg-[var(--app-subtle-bg)] border-b border-[var(--app-border)] overflow-x-auto shrink-0">
                {props.tabs.map((tab) => {
                    const isActive = tab.id === props.activeTabId
                    return (
                        <div
                            key={tab.id}
                            role="button"
                            tabIndex={0}
                            aria-label={`Select tab ${tab.label}`}
                            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs border-r border-[var(--app-border)] whitespace-nowrap cursor-pointer transition-colors ${
                                isActive
                                    ? 'bg-[var(--app-bg)] border-b-2 border-b-[#6366f1] text-[var(--app-fg)]'
                                    : 'text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]'
                            }`}
                            onClick={() => props.onSelectTab(tab.id)}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault()
                                    props.onSelectTab(tab.id)
                                }
                            }}
                        >
                            {tab.type === 'file' && tab.path && <FileIcon fileName={tab.path} size={13} />}
                            {tab.type === 'terminal' && <span aria-hidden="true">💻</span>}
                            <span className="truncate max-w-[160px]">{tab.label}</span>
                            <button
                                type="button"
                                aria-label={`Close tab ${tab.label}`}
                                className="ml-1 hover:text-[var(--app-fg)] text-[10px] leading-none"
                                onClick={(event) => {
                                    event.stopPropagation()
                                    props.onCloseTab(tab.id)
                                }}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter' || event.key === ' ') {
                                        event.preventDefault()
                                        event.stopPropagation()
                                        props.onCloseTab(tab.id)
                                    }
                                }}
                            >
                                ✕
                            </button>
                        </div>
                    )
                })}
                <button
                    type="button"
                    aria-label="New Terminal"
                    className="px-2.5 py-1.5 text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors text-sm font-light"
                    onClick={props.onOpenTerminal}
                    title="New Terminal"
                >
                    +
                </button>
                <span className="flex-1" />
                {activeTab?.type === 'file' && activeTab.path && (
                    <div className="flex items-center gap-2 px-3 text-[10px] text-[var(--app-hint)] border-l border-[var(--app-border)]">
                        {getFileExtensionLabel(activeTab.path)}
                    </div>
                )}
            </div>

            <div data-testid="editor-tabs-content" className="min-h-0 flex-1 overflow-hidden">
                {activeTab?.type === 'file' && activeTab.path && props.machineId && (
                    <FileTabContent
                        api={props.api}
                        machineId={props.machineId}
                        filePath={activeTab.path}
                    />
                )}
                {activeTab?.type === 'file' && !props.machineId && (
                    <div className="flex items-center justify-center h-full text-xs text-[var(--app-hint)]">
                        Select a machine to read files
                    </div>
                )}
                {activeTab?.type === 'terminal' && (
                    <div className="flex items-center justify-center h-full text-xs text-[var(--app-hint)]">
                        Terminal panel below
                    </div>
                )}
                {!activeTab && (
                    <div className="flex flex-col items-center justify-center h-full text-[var(--app-hint)] gap-2">
                        <div className="text-4xl opacity-30">📂</div>
                        <div className="text-sm">Open a file from the explorer</div>
                        <div className="text-xs">
                            or press <kbd className="px-1.5 py-0.5 rounded bg-[var(--app-subtle-bg)] border border-[var(--app-border)]">+</kbd> to open a terminal
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}

import { useMemo } from 'react'
import type { EditorTab } from '@/hooks/useEditorState'

export function EditorTerminal(props: {
    tabs: EditorTab[]
    activeTabId: string | null
    isCollapsed: boolean
    onSelectTab: (tabId: string) => void
    onCloseTab: (tabId: string) => void
    onOpenTerminal: () => void
    onToggleCollapsed: () => void
}) {
    const terminalTabs = useMemo(
        () => props.tabs.filter((tab) => tab.type === 'terminal'),
        [props.tabs]
    )
    const activeTerminal = terminalTabs.find((tab) => tab.id === props.activeTabId) ?? terminalTabs[0] ?? null

    return (
        <div className="flex h-full min-h-0 flex-col border-t border-[var(--app-border)] bg-[var(--app-bg)]">
            <div className="flex h-8 shrink-0 items-center border-b border-[var(--app-border)] bg-[var(--app-subtle-bg)]">
                <button
                    type="button"
                    aria-label={props.isCollapsed ? 'Expand terminal' : 'Collapse terminal'}
                    className="flex h-full w-7 items-center justify-center text-xs text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                    onClick={() => props.onToggleCollapsed()}
                    title={props.isCollapsed ? 'Expand terminal' : 'Collapse terminal'}
                >
                    {props.isCollapsed ? '›' : '⌄'}
                </button>
                <div className="px-2 text-xs font-medium text-[var(--app-hint)]">Terminal</div>
                <div className="flex min-w-0 flex-1 items-center overflow-x-auto">
                    {terminalTabs.map((tab) => {
                        const isActive = tab.id === activeTerminal?.id
                        return (
                            <div
                                key={tab.id}
                                className={`flex items-center gap-1 border-l border-[var(--app-border)] px-2 py-1 text-xs ${
                                    isActive ? 'bg-[var(--app-bg)] text-[var(--app-fg)]' : 'text-[var(--app-hint)]'
                                }`}
                            >
                                <button
                                    type="button"
                                    aria-label={`Select terminal ${tab.label}`}
                                    className="max-w-[140px] truncate hover:text-[var(--app-fg)]"
                                    onClick={() => props.onSelectTab(tab.id)}
                                >
                                    {tab.label}
                                </button>
                                <button
                                    type="button"
                                    aria-label={`Close terminal ${tab.label}`}
                                    className="text-[10px] hover:text-[var(--app-fg)]"
                                    onClick={() => props.onCloseTab(tab.id)}
                                >
                                    ✕
                                </button>
                            </div>
                        )
                    })}
                </div>
                <button
                    type="button"
                    aria-label="Open terminal"
                    className="h-full px-3 text-sm text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                    onClick={() => props.onOpenTerminal()}
                    title="Open terminal"
                >
                    +
                </button>
            </div>

            {!props.isCollapsed && (
                <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-xs text-[var(--app-hint)]">
                    {activeTerminal ? (
                        <div className="text-center">
                            <div className="mb-1 font-medium text-[var(--app-fg)]">{activeTerminal.label}</div>
                            <div>Machine terminal placeholder for {activeTerminal.shell ?? 'bash'}</div>
                        </div>
                    ) : (
                        <div>No terminal open</div>
                    )}
                </div>
            )}
        </div>
    )
}

import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import { Autocomplete } from '@/components/ChatInput/Autocomplete'
import { FloatingOverlay } from '@/components/ChatInput/FloatingOverlay'
import { useTranslation } from '@/lib/use-translation'


function CodexImportIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            {/* 中文注释：导入 Codex 历史依赖当前目录，放在 Browse 后面表达“选目录后导入”。 */}
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 3v6h-6" />
        </svg>
    )
}

function FolderIcon(props: { className?: string }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
    )
}

export function DirectorySection(props: {
    directory: string
    suggestions: readonly Suggestion[]
    selectedIndex: number
    isDisabled: boolean
    recentPaths: string[]
    statusMessage?: string | null
    statusTone?: 'warning' | 'error' | null
    onDirectoryChange: (value: string) => void
    onDirectoryFocus: () => void
    onDirectoryBlur: () => void
    onDirectoryKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void
    onSuggestionSelect: (index: number) => void
    onPathClick: (path: string) => void
    onChooseFolder?: () => void
    onImportCodexHistory?: () => void
    isImportingCodexHistory?: boolean
}) {
    const { t } = useTranslation()

    return (
        <div className="flex flex-col gap-1.5 px-3 py-3">
            <label className="text-xs font-medium text-[var(--app-hint)]">
                {t('newSession.directory')}
            </label>
            <div className="flex items-start gap-2">
                <div className="relative flex-1 min-w-0">
                    <input
                        type="text"
                        placeholder={t('newSession.placeholder')}
                        value={props.directory}
                        onChange={(event) => props.onDirectoryChange(event.target.value)}
                        onKeyDown={props.onDirectoryKeyDown}
                        onFocus={props.onDirectoryFocus}
                        onBlur={props.onDirectoryBlur}
                        disabled={props.isDisabled}
                        className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
                    />
                    {props.suggestions.length > 0 && (
                        <div className="absolute top-full left-0 right-0 z-10 mt-1">
                            <FloatingOverlay maxHeight={200}>
                                <Autocomplete
                                    suggestions={props.suggestions}
                                    selectedIndex={props.selectedIndex}
                                    onSelect={props.onSuggestionSelect}
                                />
                            </FloatingOverlay>
                        </div>
                    )}
                </div>
                {props.onChooseFolder && (
                    <button
                        type="button"
                        onClick={props.onChooseFolder}
                        disabled={props.isDisabled}
                        className="shrink-0 flex items-center gap-1 rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-2 text-xs text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)] transition-colors disabled:opacity-50"
                        title={t('newSession.browse')}
                    >
                        <FolderIcon className="h-3.5 w-3.5" />
                        {t('newSession.browse')}
                    </button>
                )}

                {props.onImportCodexHistory ? (
                    <button
                        type="button"
                        onClick={props.onImportCodexHistory}
                        disabled={props.isDisabled || props.isImportingCodexHistory}
                        aria-label={t('codexSync.tooltip')}
                        aria-busy={props.isImportingCodexHistory}
                        className="shrink-0 flex items-center gap-1 rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-2 text-xs text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)] transition-colors disabled:opacity-50"
                        title={t('codexSync.tooltip')}
                    >
                        <CodexImportIcon className={`h-3.5 w-3.5 ${props.isImportingCodexHistory ? 'animate-spin' : ''}`} />
                        {t('codexSync.newSessionAction')}
                    </button>
                ) : null}
            </div>

            {props.recentPaths.length > 0 && (
                <div className="flex flex-col gap-1 mt-1">
                    <span className="text-xs text-[var(--app-hint)]">{t('newSession.recent')}:</span>
                    <div className="flex flex-wrap gap-1">
                        {props.recentPaths.map((path) => (
                            <button
                                key={path}
                                type="button"
                                onClick={() => props.onPathClick(path)}
                                disabled={props.isDisabled}
                                className="rounded bg-[var(--app-subtle-bg)] px-2 py-1 text-xs text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)] transition-colors truncate max-w-[200px] disabled:opacity-50"
                                title={path}
                            >
                                {path}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {props.statusMessage ? (
                <div
                    className={`mt-1 rounded-md px-2 py-1 text-xs ${
                        props.statusTone === 'error'
                            ? 'bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400'
                            : 'bg-amber-500/10 text-[var(--app-hint)]'
                    }`}
                >
                    {props.statusMessage}
                </div>
            ) : null}
        </div>
    )
}

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { Machine, MachineDirectoryEntry } from '@/types/api'
import { useTranslation } from '@/lib/use-translation'

const WORKSPACE_STORAGE_KEY = 'hapi:workspacePaths'
const MAX_WORKSPACE_PATHS = 10

function loadWorkspacePaths(): string[] {
    try {
        const stored = localStorage.getItem(WORKSPACE_STORAGE_KEY)
        return stored ? JSON.parse(stored) : []
    } catch {
        return []
    }
}

function saveWorkspacePaths(paths: string[]): void {
    try {
        localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(paths))
    } catch {
        // Ignore storage errors
    }
}

function FolderIcon(props: { className?: string }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
    )
}

function GitIcon(props: { className?: string }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <circle cx="12" cy="18" r="3" />
            <circle cx="6" cy="6" r="3" />
            <circle cx="18" cy="6" r="3" />
            <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
            <path d="M12 12v3" />
        </svg>
    )
}

function FileIcon(props: { className?: string }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
            <polyline points="14 2 14 8 20 8" />
        </svg>
    )
}

function ChevronLeftIcon(props: { className?: string }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <polyline points="15 18 9 12 15 6" />
        </svg>
    )
}

function MachineIcon(props: { className?: string }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <line x1="8" y1="21" x2="16" y2="21" />
            <line x1="12" y1="17" x2="12" y2="21" />
        </svg>
    )
}

function RefreshIcon(props: { className?: string }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
        </svg>
    )
}

function TrashIcon(props: { className?: string }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
    )
}

function PlusIcon(props: { className?: string }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
    )
}

function getMachineTitle(machine: Machine): string {
    if (machine.metadata?.displayName) return machine.metadata.displayName
    if (machine.metadata?.host) return machine.metadata.host
    return machine.id.slice(0, 8)
}

export function WorkspaceBrowser(props: {
    api: ApiClient
    machines: Machine[]
    machinesLoading: boolean
    onStartSession: (machineId: string, directory: string) => void
}) {
    const { t } = useTranslation()
    const { api, machines, machinesLoading } = props

    const [machineId, setMachineId] = useState<string | null>(null)
    const [currentPath, setCurrentPath] = useState<string | null>(null)
    const [entries, setEntries] = useState<MachineDirectoryEntry[]>([])
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [workspacePaths, setWorkspacePaths] = useState<string[]>(loadWorkspacePaths)
    const [newPathInput, setNewPathInput] = useState('')
    const [showAddPath, setShowAddPath] = useState(false)

    // Auto-select machine
    useEffect(() => {
        if (machines.length === 0) return
        if (machineId && machines.find(m => m.id === machineId)) return
        try {
            const lastUsed = localStorage.getItem('hapi:lastMachineId')
            const found = lastUsed ? machines.find(m => m.id === lastUsed) : null
            setMachineId(found ? found.id : machines[0].id)
        } catch {
            setMachineId(machines[0].id)
        }
    }, [machines, machineId])

    const selectedMachine = useMemo(
        () => machineId ? machines.find(m => m.id === machineId) ?? null : null,
        [machineId, machines]
    )

    const loadDirectory = useCallback(async (path: string) => {
        if (!machineId) return
        setIsLoading(true)
        setError(null)
        try {
            const result = await api.listMachineDirectory(machineId, path)
            if (result.success && result.entries) {
                setEntries(result.entries)
                setCurrentPath(path)
            } else {
                setError(result.error ?? 'Failed to list directory')
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to list directory')
        } finally {
            setIsLoading(false)
        }
    }, [api, machineId])

    const handleEntryClick = useCallback((entry: MachineDirectoryEntry) => {
        if (entry.type !== 'directory' || !currentPath) return
        const newPath = currentPath.endsWith('/') ? currentPath + entry.name : currentPath + '/' + entry.name
        void loadDirectory(newPath)
    }, [currentPath, loadDirectory])

    const handleGoUp = useCallback(() => {
        if (!currentPath) return
        const parts = currentPath.split('/')
        if (parts.length <= 2) {
            // Going back to workspace root selection
            setCurrentPath(null)
            setEntries([])
            return
        }
        parts.pop()
        void loadDirectory(parts.join('/'))
    }, [currentPath, loadDirectory])

    const handleWorkspaceClick = useCallback((path: string) => {
        void loadDirectory(path)
    }, [loadDirectory])

    const handleAddWorkspace = useCallback(() => {
        const trimmed = newPathInput.trim()
        if (!trimmed) return
        const updated = [trimmed, ...workspacePaths.filter(p => p !== trimmed)].slice(0, MAX_WORKSPACE_PATHS)
        setWorkspacePaths(updated)
        saveWorkspacePaths(updated)
        setNewPathInput('')
        setShowAddPath(false)
        void loadDirectory(trimmed)
    }, [newPathInput, workspacePaths, loadDirectory])

    const handleRemoveWorkspace = useCallback((path: string, e: React.MouseEvent) => {
        e.stopPropagation()
        const updated = workspacePaths.filter(p => p !== path)
        setWorkspacePaths(updated)
        saveWorkspacePaths(updated)
    }, [workspacePaths])

    const handleRefresh = useCallback(() => {
        if (currentPath) {
            void loadDirectory(currentPath)
        }
    }, [currentPath, loadDirectory])

    const handleStartSession = useCallback(() => {
        if (!machineId || !currentPath) return
        props.onStartSession(machineId, currentPath)
    }, [machineId, currentPath, props])

    const handleAddPathKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            handleAddWorkspace()
        }
        if (e.key === 'Escape') {
            setShowAddPath(false)
            setNewPathInput('')
        }
    }, [handleAddWorkspace])

    // Breadcrumb parts from current path
    const breadcrumbs = useMemo(() => {
        if (!currentPath) return []
        const parts = currentPath.split('/').filter(Boolean)
        const crumbs: { label: string; path: string }[] = []
        for (let i = 0; i < parts.length; i++) {
            crumbs.push({
                label: parts[i],
                path: '/' + parts.slice(0, i + 1).join('/')
            })
        }
        return crumbs
    }, [currentPath])

    const directories = useMemo(() => entries.filter(e => e.type === 'directory'), [entries])

    // If not browsing a directory, show workspace root view
    if (!currentPath) {
        return (
            <div className="flex flex-col h-full">
                {/* Machine selector */}
                <div className="px-3 py-2 border-b border-[var(--app-divider)]">
                    <div className="flex items-center gap-2">
                        <MachineIcon className="h-4 w-4 text-[var(--app-hint)] shrink-0" />
                        <select
                            value={machineId ?? ''}
                            onChange={e => setMachineId(e.target.value || null)}
                            disabled={machinesLoading}
                            className="flex-1 bg-transparent text-sm text-[var(--app-fg)] outline-none"
                        >
                            {machines.map(m => (
                                <option key={m.id} value={m.id}>{getMachineTitle(m)}</option>
                            ))}
                            {machines.length === 0 && (
                                <option value="">{machinesLoading ? t('loading') : t('misc.noMachines')}</option>
                            )}
                        </select>
                    </div>
                </div>

                {/* Workspace list */}
                <div className="flex-1 app-scroll-y">
                    <div className="px-3 py-2">
                        <div className="flex items-center justify-between mb-2">
                            <span className="text-xs font-medium text-[var(--app-hint)] uppercase tracking-wider">{t('browse.workspaces')}</span>
                            <button
                                type="button"
                                onClick={() => setShowAddPath(!showAddPath)}
                                className="p-1 rounded text-[var(--app-link)] hover:bg-[var(--app-subtle-bg)] transition-colors"
                                title={t('browse.addWorkspace')}
                            >
                                <PlusIcon className="h-4 w-4" />
                            </button>
                        </div>

                        {showAddPath && (
                            <div className="flex gap-2 mb-3">
                                <input
                                    type="text"
                                    value={newPathInput}
                                    onChange={e => setNewPathInput(e.target.value)}
                                    onKeyDown={handleAddPathKeyDown}
                                    placeholder={t('browse.pathPlaceholder')}
                                    className="flex-1 px-2 py-1.5 text-sm rounded bg-[var(--app-secondary-bg)] text-[var(--app-fg)] placeholder:text-[var(--app-hint)] border border-[var(--app-border)] outline-none focus:ring-1 focus:ring-[var(--app-link)]"
                                    autoFocus
                                />
                                <button
                                    type="button"
                                    onClick={handleAddWorkspace}
                                    disabled={!newPathInput.trim()}
                                    className="px-3 py-1.5 text-sm rounded bg-[var(--app-link)] text-white disabled:opacity-50 transition-colors"
                                >
                                    {t('browse.add')}
                                </button>
                            </div>
                        )}

                        {workspacePaths.length === 0 && !showAddPath ? (
                            <div className="py-8 text-center text-sm text-[var(--app-hint)]">
                                {t('browse.noWorkspaces')}
                            </div>
                        ) : (
                            <div className="flex flex-col gap-1">
                                {workspacePaths.map(path => (
                                    <div
                                        key={path}
                                        className="group flex items-center gap-2 px-2 py-2 rounded-lg cursor-pointer hover:bg-[var(--app-subtle-bg)] transition-colors"
                                        onClick={() => handleWorkspaceClick(path)}
                                    >
                                        <FolderIcon className="h-4 w-4 text-[var(--app-link)] shrink-0" />
                                        <span className="flex-1 text-sm text-[var(--app-fg)] truncate">{path}</span>
                                        <button
                                            type="button"
                                            onClick={(e) => handleRemoveWorkspace(path, e)}
                                            className="p-1 rounded text-[var(--app-hint)] hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                                            title={t('browse.removeWorkspace')}
                                        >
                                            <TrashIcon className="h-3.5 w-3.5" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Quick path input */}
                    <div className="px-3 py-2 border-t border-[var(--app-divider)]">
                        <div className="text-xs font-medium text-[var(--app-hint)] uppercase tracking-wider mb-2">{t('browse.goToPath')}</div>
                        <div className="flex gap-2">
                            <input
                                type="text"
                                value={newPathInput}
                                onChange={e => setNewPathInput(e.target.value)}
                                onKeyDown={e => {
                                    if (e.key === 'Enter' && newPathInput.trim()) {
                                        void loadDirectory(newPathInput.trim())
                                    }
                                }}
                                placeholder={t('browse.pathPlaceholder')}
                                className="flex-1 px-2 py-1.5 text-sm rounded bg-[var(--app-secondary-bg)] text-[var(--app-fg)] placeholder:text-[var(--app-hint)] border border-[var(--app-border)] outline-none focus:ring-1 focus:ring-[var(--app-link)]"
                            />
                            <button
                                type="button"
                                onClick={() => {
                                    if (newPathInput.trim()) void loadDirectory(newPathInput.trim())
                                }}
                                disabled={!newPathInput.trim() || !machineId}
                                className="px-3 py-1.5 text-sm rounded bg-[var(--app-link)] text-white disabled:opacity-50 transition-colors"
                            >
                                {t('browse.go')}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        )
    }

    // Directory browser view
    return (
        <div className="flex flex-col h-full">
            {/* Header: Machine + breadcrumb */}
            <div className="px-3 py-2 border-b border-[var(--app-divider)]">
                <div className="flex items-center gap-2 mb-1">
                    <MachineIcon className="h-4 w-4 text-[var(--app-hint)] shrink-0" />
                    <select
                        value={machineId ?? ''}
                        onChange={e => {
                            setMachineId(e.target.value || null)
                            setCurrentPath(null)
                            setEntries([])
                        }}
                        className="bg-transparent text-sm text-[var(--app-fg)] outline-none"
                    >
                        {machines.map(m => (
                            <option key={m.id} value={m.id}>{getMachineTitle(m)}</option>
                        ))}
                    </select>
                </div>

                {/* Breadcrumb */}
                <div className="flex items-center gap-1 text-xs overflow-x-auto">
                    <button
                        type="button"
                        onClick={handleGoUp}
                        className="shrink-0 p-0.5 rounded hover:bg-[var(--app-subtle-bg)] text-[var(--app-hint)] hover:text-[var(--app-fg)] transition-colors"
                        title={t('browse.goUp')}
                    >
                        <ChevronLeftIcon className="h-4 w-4" />
                    </button>
                    {breadcrumbs.map((crumb, i) => (
                        <span key={crumb.path} className="flex items-center gap-1 shrink-0">
                            {i > 0 && <span className="text-[var(--app-hint)]">/</span>}
                            <button
                                type="button"
                                onClick={() => void loadDirectory(crumb.path)}
                                className={`hover:underline ${i === breadcrumbs.length - 1 ? 'text-[var(--app-fg)] font-medium' : 'text-[var(--app-hint)]'}`}
                            >
                                {crumb.label}
                            </button>
                        </span>
                    ))}
                    <button
                        type="button"
                        onClick={handleRefresh}
                        disabled={isLoading}
                        className="ml-auto shrink-0 p-0.5 rounded hover:bg-[var(--app-subtle-bg)] text-[var(--app-hint)] hover:text-[var(--app-fg)] transition-colors"
                        title={t('browse.refresh')}
                    >
                        <RefreshIcon className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
                    </button>
                </div>
            </div>

            {/* Error */}
            {error && (
                <div className="px-3 py-2 text-sm text-red-600">{error}</div>
            )}

            {/* Directory listing */}
            <div className="flex-1 app-scroll-y">
                {isLoading && entries.length === 0 ? (
                    <div className="flex items-center justify-center py-8 text-sm text-[var(--app-hint)]">
                        {t('loading')}
                    </div>
                ) : directories.length === 0 ? (
                    <div className="flex items-center justify-center py-8 text-sm text-[var(--app-hint)]">
                        {t('browse.empty')}
                    </div>
                ) : (
                    <div className="flex flex-col px-2 py-1">
                        {directories.map(entry => (
                            <button
                                key={entry.name}
                                type="button"
                                onClick={() => handleEntryClick(entry)}
                                className="flex items-center gap-2 px-2 py-2 rounded-lg text-left hover:bg-[var(--app-subtle-bg)] transition-colors w-full"
                            >
                                {entry.isGitRepo ? (
                                    <GitIcon className="h-4 w-4 text-orange-500 shrink-0" />
                                ) : (
                                    <FolderIcon className="h-4 w-4 text-[var(--app-link)] shrink-0" />
                                )}
                                <span className="flex-1 text-sm text-[var(--app-fg)] truncate">{entry.name}</span>
                                {entry.isGitRepo && (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-500/10 text-orange-500 font-medium shrink-0">git</span>
                                )}
                            </button>
                        ))}
                    </div>
                )}
            </div>

            {/* Bottom action bar */}
            {currentPath && (
                <div className="px-3 py-2 border-t border-[var(--app-divider)]">
                    <div className="flex items-center gap-2">
                        <div className="flex-1 text-xs text-[var(--app-hint)] truncate" title={currentPath}>
                            {currentPath}
                        </div>
                        <button
                            type="button"
                            onClick={handleStartSession}
                            disabled={!machineId || !currentPath}
                            className="px-4 py-1.5 text-sm rounded-lg bg-[var(--app-link)] text-white font-medium disabled:opacity-50 transition-colors hover:opacity-90"
                        >
                            {t('browse.startSession')}
                        </button>
                    </div>
                </div>
            )}
        </div>
    )
}

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { Machine, MachineDirectoryEntry } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { useTranslation } from '@/lib/use-translation'

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

function getMachineTitle(machine: Machine): string {
    if (machine.metadata?.displayName) return machine.metadata.displayName
    if (machine.metadata?.host) return machine.metadata.host
    return machine.id.slice(0, 8)
}

function joinPath(base: string, name: string): string {
    return base.endsWith('/') ? base + name : base + '/' + name
}

function parentPath(path: string): string {
    const stripped = path.replace(/\/+$/, '')
    const idx = stripped.lastIndexOf('/')
    if (idx <= 0) return '/'
    return stripped.slice(0, idx)
}

function isPathWithin(candidate: string, root: string): boolean {
    const c = candidate.replace(/\/+$/, '') || '/'
    const r = root.replace(/\/+$/, '') || '/'
    return c === r || c.startsWith(r + '/')
}

function buildBreadcrumbs(currentPath: string, root: string): { label: string; path: string }[] {
    const rootTrimmed = root.replace(/\/+$/, '')
    const relative = currentPath.slice(rootTrimmed.length).replace(/^\/+/, '')
    const crumbs: { label: string; path: string }[] = [{ label: rootTrimmed.split('/').pop() || '/', path: rootTrimmed || '/' }]
    if (!relative) return crumbs
    const parts = relative.split('/').filter(Boolean)
    let acc = rootTrimmed
    for (const part of parts) {
        acc = acc + '/' + part
        crumbs.push({ label: part, path: acc })
    }
    return crumbs
}

export function WorkspaceBrowser(props: {
    api: ApiClient
    machines: Machine[]
    machinesLoading: boolean
    onStartSession: (machineId: string, directory: string) => void
    initialMachineId?: string
}) {
    const { t } = useTranslation()
    const { api, machines, machinesLoading, initialMachineId } = props
    const queryClient = useQueryClient()

    const [machineId, setMachineId] = useState<string | null>(initialMachineId ?? null)
    const [currentPath, setCurrentPath] = useState<string | null>(null)
    const [entries, setEntries] = useState<MachineDirectoryEntry[]>([])
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        if (machines.length === 0) {
            if (machineId !== null) setMachineId(null)
            return
        }
        if (machineId && machines.find(m => m.id === machineId)) return
        // Honor an explicit initial machine before falling back to the
        // last-used or first-available machine.
        if (initialMachineId && machines.find(m => m.id === initialMachineId)) {
            setMachineId(initialMachineId)
            return
        }
        try {
            const lastUsed = localStorage.getItem('hapi:lastMachineId')
            const found = lastUsed ? machines.find(m => m.id === lastUsed) : null
            setMachineId(found ? found.id : machines[0].id)
        } catch {
            setMachineId(machines[0].id)
        }
    }, [machines, machineId, initialMachineId])

    const selectedMachine = useMemo(
        () => machineId ? machines.find(m => m.id === machineId) ?? null : null,
        [machineId, machines]
    )
    const workspaceRoot = selectedMachine?.metadata?.workspaceRoot ?? null

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
                // CLI may have just pushed new metadata (e.g. a workspaceRoot)
                // that we haven't picked up yet — refetch so the UI can
                // transition out of the no-root state if applicable.
                void queryClient.invalidateQueries({ queryKey: queryKeys.machines })
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to list directory')
            void queryClient.invalidateQueries({ queryKey: queryKeys.machines })
        } finally {
            setIsLoading(false)
        }
    }, [api, machineId, queryClient])

    // Auto-load workspace root when a machine with a root is selected
    useEffect(() => {
        if (!machineId || !workspaceRoot) return
        if (currentPath && isPathWithin(currentPath, workspaceRoot)) return
        void loadDirectory(workspaceRoot)
    }, [machineId, workspaceRoot, currentPath, loadDirectory])

    // If switching machines, reset view
    useEffect(() => {
        setCurrentPath(null)
        setEntries([])
        setError(null)
    }, [machineId])

    const handleEntryClick = useCallback((entry: MachineDirectoryEntry) => {
        if (entry.type !== 'directory' || !currentPath) return
        void loadDirectory(joinPath(currentPath, entry.name))
    }, [currentPath, loadDirectory])

    const handleGoUp = useCallback(() => {
        if (!currentPath || !workspaceRoot) return
        if (currentPath.replace(/\/+$/, '') === workspaceRoot.replace(/\/+$/, '')) return
        const parent = parentPath(currentPath)
        if (!isPathWithin(parent, workspaceRoot)) return
        void loadDirectory(parent)
    }, [currentPath, workspaceRoot, loadDirectory])

    const handleRefresh = useCallback(() => {
        if (currentPath) void loadDirectory(currentPath)
    }, [currentPath, loadDirectory])

    const handleStartSession = useCallback(() => {
        if (!machineId || !currentPath) return
        props.onStartSession(machineId, currentPath)
    }, [machineId, currentPath, props])

    const breadcrumbs = useMemo(() => {
        if (!currentPath || !workspaceRoot) return []
        return buildBreadcrumbs(currentPath, workspaceRoot)
    }, [currentPath, workspaceRoot])

    const directories = useMemo(() => entries.filter(e => e.type === 'directory'), [entries])
    const atRoot = !!(currentPath && workspaceRoot && currentPath.replace(/\/+$/, '') === workspaceRoot.replace(/\/+$/, ''))

    const machineSelector = (
        <div className="flex items-center gap-2">
            <MachineIcon className="h-4 w-4 text-[var(--app-hint)] shrink-0" />
            <select
                value={machineId ?? ''}
                onChange={e => setMachineId(e.target.value || null)}
                disabled={machinesLoading}
                className="flex-1 bg-transparent text-sm text-[var(--app-fg)] outline-none"
            >
                {machines.map(m => (
                    <option key={m.id} value={m.id}>
                        {getMachineTitle(m)}
                        {m.metadata?.workspaceRoot ? ` — ${m.metadata.workspaceRoot}` : ''}
                    </option>
                ))}
                {machines.length === 0 && (
                    <option value="">{machinesLoading ? t('loading') : t('misc.noMachines')}</option>
                )}
            </select>
        </div>
    )

    // No machines connected
    if (machines.length === 0 && !machinesLoading) {
        return (
            <div className="flex flex-col h-full">
                <div className="px-3 py-2 border-b border-[var(--app-divider)]">{machineSelector}</div>
                <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
                    <div className="text-sm text-[var(--app-hint)]">{t('browse.noMachinesConnected')}</div>
                </div>
            </div>
        )
    }

    // Selected machine hasn't reported a workspaceRoot — show an info state.
    // Browsing is opt-in, triggered by `--workspace-root`.
    if (selectedMachine && !workspaceRoot) {
        return (
            <div className="flex flex-col h-full">
                <div className="px-3 py-2 border-b border-[var(--app-divider)]">{machineSelector}</div>
                <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
                    <div className="text-sm text-[var(--app-fg)] font-medium">{t('browse.noRootTitle')}</div>
                    <div className="max-w-md text-sm text-[var(--app-hint)]">{t('browse.noRootHint')}</div>
                    <code className="px-3 py-1.5 text-xs rounded bg-[var(--app-subtle-bg)] text-[var(--app-fg)]">
                        hapi runner start --workspace-root /path/to/folder
                    </code>
                    <div className="text-xs text-[var(--app-hint)] mt-2">
                        {t('browse.noRootFooter')}
                    </div>
                </div>
            </div>
        )
    }

    return (
        <div className="flex flex-col h-full">
            <div className="px-3 py-2 border-b border-[var(--app-divider)]">
                {machineSelector}

                {currentPath && (
                    <div className="mt-2 flex items-center gap-1 text-xs overflow-x-auto">
                        <button
                            type="button"
                            onClick={handleGoUp}
                            disabled={atRoot}
                            className="shrink-0 p-0.5 rounded hover:bg-[var(--app-subtle-bg)] text-[var(--app-hint)] hover:text-[var(--app-fg)] transition-colors disabled:opacity-30"
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
                )}
            </div>

            {error && (
                <div className="px-3 py-2 text-sm text-red-600">{error}</div>
            )}

            <div className="flex-1 app-scroll-y">
                {isLoading && entries.length === 0 ? (
                    <div className="flex items-center justify-center py-8 text-sm text-[var(--app-hint)]">{t('loading')}</div>
                ) : directories.length === 0 ? (
                    <div className="flex items-center justify-center py-8 text-sm text-[var(--app-hint)]">{t('browse.empty')}</div>
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
                            className="px-4 py-1.5 text-sm rounded-lg bg-[var(--app-button)] text-[var(--app-button-text)] font-medium disabled:opacity-50 transition-colors hover:opacity-90"
                        >
                            {t('browse.startSession')}
                        </button>
                    </div>
                </div>
            )}
        </div>
    )
}

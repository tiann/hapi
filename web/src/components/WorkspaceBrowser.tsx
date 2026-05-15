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

function getMachineRootsSummary(machine: Machine): string {
    const roots = machine.metadata?.workspaceRoots ?? []
    if (roots.length === 0) return ''
    if (roots.length === 1) return roots[0]
    return `${roots[0]} (+${roots.length - 1})`
}

function isWindowsStylePath(path: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(path) || path.includes('\\')
}

function getPathSeparator(path: string): '/' | '\\' {
    return isWindowsStylePath(path) ? '\\' : '/'
}

function normalizePathForComparison(path: string): string {
    const normalized = path.replace(/[\\/]+/g, '/')
    if (/^[A-Za-z]:\/$/.test(normalized) || normalized === '/') {
        return normalized
    }
    if (/^[A-Za-z]:$/.test(normalized)) {
        return `${normalized}/`
    }
    return normalized.replace(/\/+$/, '')
}

function denormalizePath(path: string, sample: string): string {
    return getPathSeparator(sample) === '\\'
        ? path.replace(/\//g, '\\')
        : path
}

function joinPath(base: string, name: string): string {
    const normalizedBase = normalizePathForComparison(base)
    const joined = normalizedBase === '/' || /^[A-Za-z]:\/$/.test(normalizedBase)
        ? `${normalizedBase}${name}`
        : `${normalizedBase}/${name}`
    return denormalizePath(joined, base)
}

function parentPath(path: string): string {
    const normalizedPath = normalizePathForComparison(path)
    if (normalizedPath === '/' || /^[A-Za-z]:\/$/.test(normalizedPath)) {
        return denormalizePath(normalizedPath, path)
    }

    const idx = normalizedPath.lastIndexOf('/')
    const parent = idx <= 0 ? '/' : normalizedPath.slice(0, idx)
    const resolvedParent = /^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent
    return denormalizePath(resolvedParent, path)
}

function isPathWithin(candidate: string, root: string): boolean {
    const c = normalizePathForComparison(candidate)
    const r = normalizePathForComparison(root)
    return c === r || c.startsWith(r.endsWith('/') ? r : `${r}/`)
}

function buildBreadcrumbs(currentPath: string, root: string): { label: string; path: string }[] {
    const normalizedRoot = normalizePathForComparison(root)
    const normalizedCurrent = normalizePathForComparison(currentPath)
    const rootLabel = (() => {
        if (normalizedRoot === '/') return '/'
        if (/^[A-Za-z]:\/$/.test(normalizedRoot)) return normalizedRoot.slice(0, 2)
        return normalizedRoot.split('/').pop() || normalizedRoot
    })()
    const relative = normalizedCurrent.slice(normalizedRoot.length).replace(/^\/+/, '')
    const crumbs: { label: string; path: string }[] = [{
        label: rootLabel,
        path: denormalizePath(normalizedRoot, root)
    }]
    if (!relative) return crumbs
    const parts = relative.split('/').filter(Boolean)
    let acc = normalizedRoot
    for (const part of parts) {
        acc = acc === '/' || /^[A-Za-z]:\/$/.test(acc)
            ? `${acc}${part}`
            : `${acc}/${part}`
        crumbs.push({ label: part, path: denormalizePath(acc, root) })
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
    const [selectedRoot, setSelectedRoot] = useState<string | null>(null)
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
    const workspaceRoots = useMemo(
        () => selectedMachine?.metadata?.workspaceRoots ?? [],
        [selectedMachine?.metadata?.workspaceRoots]
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
                // CLI may have just pushed new metadata (e.g. workspaceRoots)
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

    useEffect(() => {
        if (workspaceRoots.length === 0) {
            if (selectedRoot !== null) setSelectedRoot(null)
            return
        }
        if (selectedRoot && workspaceRoots.includes(selectedRoot)) return
        setSelectedRoot(workspaceRoots[0] ?? null)
    }, [workspaceRoots, selectedRoot])

    // Auto-load selected root when a machine/root is selected
    useEffect(() => {
        if (!machineId || !selectedRoot) return
        if (currentPath && isPathWithin(currentPath, selectedRoot)) return
        void loadDirectory(selectedRoot)
    }, [machineId, selectedRoot, currentPath, loadDirectory])

    // 切换机器时才重置浏览状态；workspaceRoots 的刷新由上面的 effect
    // 只做 root 有效性校正，避免 metadata 更新时清空用户当前浏览位置。
    useEffect(() => {
        setSelectedRoot(workspaceRoots[0] ?? null)
        setCurrentPath(null)
        setEntries([])
        setError(null)
    }, [machineId])

    const handleEntryClick = useCallback((entry: MachineDirectoryEntry) => {
        if (entry.type !== 'directory' || !currentPath) return
        void loadDirectory(joinPath(currentPath, entry.name))
    }, [currentPath, loadDirectory])

    const handleGoUp = useCallback(() => {
        if (!currentPath || !selectedRoot) return
        if (normalizePathForComparison(currentPath) === normalizePathForComparison(selectedRoot)) return
        const parent = parentPath(currentPath)
        if (!isPathWithin(parent, selectedRoot)) return
        void loadDirectory(parent)
    }, [currentPath, selectedRoot, loadDirectory])

    const handleRefresh = useCallback(() => {
        if (currentPath) void loadDirectory(currentPath)
    }, [currentPath, loadDirectory])

    const handleStartSession = useCallback(() => {
        if (!machineId || !currentPath) return
        props.onStartSession(machineId, currentPath)
    }, [machineId, currentPath, props])

    const breadcrumbs = useMemo(() => {
        if (!currentPath || !selectedRoot) return []
        return buildBreadcrumbs(currentPath, selectedRoot)
    }, [currentPath, selectedRoot])

    const directories = useMemo(() => entries.filter(e => e.type === 'directory'), [entries])
    const atRoot = !!(currentPath && selectedRoot && normalizePathForComparison(currentPath) === normalizePathForComparison(selectedRoot))

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
                        {getMachineRootsSummary(m) ? ` — ${getMachineRootsSummary(m)}` : ''}
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

    // Selected machine hasn't reported workspace roots — show an info state.
    // Browsing is opt-in, triggered by `--workspace-root`.
    if (selectedMachine && workspaceRoots.length === 0) {
        return (
            <div className="flex flex-col h-full">
                <div className="px-3 py-2 border-b border-[var(--app-divider)]">{machineSelector}</div>
                <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
                    <div className="text-sm text-[var(--app-fg)] font-medium">{t('browse.noRootTitle')}</div>
                    <div className="max-w-md text-sm text-[var(--app-hint)]">{t('browse.noRootHint')}</div>
                    <code className="px-3 py-1.5 text-xs rounded bg-[var(--app-subtle-bg)] text-[var(--app-fg)]">
                        hapi runner start --workspace-root /path/a --workspace-root /path/b
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

                {workspaceRoots.length > 1 && (
                    <div className="mt-2">
                        <select
                            value={selectedRoot ?? ''}
                            onChange={(e) => setSelectedRoot(e.target.value || null)}
                            className="w-full bg-transparent text-xs text-[var(--app-hint)] outline-none"
                        >
                            {workspaceRoots.map((root) => (
                                <option key={root} value={root}>
                                    {root}
                                </option>
                            ))}
                        </select>
                    </div>
                )}

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

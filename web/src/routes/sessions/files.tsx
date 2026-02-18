import { useCallback, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import type { FileSearchItem, GitFileStatus } from '@/types/api'
import { FileIcon } from '@/components/FileIcon'
import { DirectoryTree } from '@/components/SessionFiles/DirectoryTree'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { useGitStatusFiles } from '@/hooks/queries/useGitStatusFiles'
import { useSession } from '@/hooks/queries/useSession'
import { useSessionFileSearch } from '@/hooks/queries/useSessionFileSearch'
import { encodeBase64 } from '@/lib/utils'
import { queryKeys } from '@/lib/query-keys'
import { useQueryClient } from '@tanstack/react-query'

function BackIcon(props: { className?: string }) {
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
            <polyline points="15 18 9 12 15 6" />
        </svg>
    )
}

function RefreshIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M21 12a9 9 0 1 1-3-6.7" />
            <polyline points="21 3 21 9 15 9" />
        </svg>
    )
}

function SearchIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
    )
}

function ChevronIcon(props: { className?: string; collapsed: boolean }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`${props.className ?? ''} transition-transform duration-200 ${props.collapsed ? '' : 'rotate-90'}`}
        >
            <polyline points="9 18 15 12 9 6" />
        </svg>
    )
}

function GitBranchIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <line x1="6" y1="3" x2="6" y2="15" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="6" r="3" />
            <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
    )
}

function FolderIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
    )
}

function StatusBadge(props: { status: GitFileStatus['status'] }) {
    const { label, color } = useMemo(() => {
        switch (props.status) {
            case 'added':
                return { label: 'A', color: 'var(--app-git-staged-color)' }
            case 'deleted':
                return { label: 'D', color: 'var(--app-git-deleted-color)' }
            case 'renamed':
                return { label: 'R', color: 'var(--app-git-renamed-color)' }
            case 'untracked':
                return { label: '?', color: 'var(--app-git-untracked-color)' }
            case 'conflicted':
                return { label: 'U', color: 'var(--app-git-deleted-color)' }
            default:
                return { label: 'M', color: 'var(--app-git-unstaged-color)' }
        }
    }, [props.status])

    return (
        <span
            className="inline-flex items-center justify-center rounded border px-1.5 py-0.5 text-[10px] font-semibold"
            style={{ color, borderColor: color }}
        >
            {label}
        </span>
    )
}

function LineChanges(props: { added: number; removed: number }) {
    if (!props.added && !props.removed) return null

    return (
        <span className="flex items-center gap-1 text-[11px] font-mono">
            {props.added ? (
                <span className="text-[var(--app-diff-added-text)]">+{props.added}</span>
            ) : null}
            {props.removed ? (
                <span className="text-[var(--app-diff-removed-text)]">-{props.removed}</span>
            ) : null}
        </span>
    )
}

type GitChangesTreeNode = {
    name: string
    path: string
    directories: GitChangesTreeNode[]
    files: GitFileStatus[]
}

type MutableGitChangesTreeNode = {
    name: string
    path: string
    directories: Map<string, MutableGitChangesTreeNode>
    files: GitFileStatus[]
}

function createTreeNode(name: string, path: string): MutableGitChangesTreeNode {
    return {
        name,
        path,
        directories: new Map(),
        files: []
    }
}

function buildGitChangesTree(files: GitFileStatus[]): GitChangesTreeNode {
    const root = createTreeNode('', '')

    for (const file of files) {
        const parts = file.fullPath.split('/').filter(Boolean)
        if (!parts.length) {
            root.files.push(file)
            continue
        }

        let current = root
        for (let index = 0; index < parts.length - 1; index += 1) {
            const segment = parts[index]
            if (!segment) continue

            let child = current.directories.get(segment)
            if (!child) {
                const childPath = current.path ? `${current.path}/${segment}` : segment
                child = createTreeNode(segment, childPath)
                current.directories.set(segment, child)
            }
            current = child
        }

        current.files.push(file)
    }

    const normalize = (node: MutableGitChangesTreeNode): GitChangesTreeNode => {
        const directories = Array.from(node.directories.values())
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((child) => normalize(child))
        const sortedFiles = [...node.files].sort((a, b) => a.fullPath.localeCompare(b.fullPath))

        return {
            name: node.name,
            path: node.path,
            directories,
            files: sortedFiles
        }
    }

    return normalize(root)
}

function GitFileRow(props: {
    file: GitFileStatus
    onOpen: () => void
    depth: number
}) {
    const indent = 12 + props.depth * 14

    return (
        <button
            type="button"
            onClick={props.onOpen}
            className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-[var(--app-subtle-bg)] transition-colors"
            style={{ paddingLeft: indent }}
        >
            <span className="h-4 w-4" />
            <FileIcon fileName={props.file.fileName} size={22} />
            <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{props.file.fileName}</div>
                {props.file.oldPath ? (
                    <div className="truncate text-xs text-[var(--app-hint)]">{props.file.oldPath}</div>
                ) : null}
            </div>
            <div className="flex items-center gap-2">
                <LineChanges added={props.file.linesAdded} removed={props.file.linesRemoved} />
                <StatusBadge status={props.file.status} />
            </div>
        </button>
    )
}

function GitChangesDirectoryNode(props: {
    node: GitChangesTreeNode
    depth: number
    expanded: Set<string>
    onToggle: (path: string) => void
    onOpenFile: (file: GitFileStatus) => void
}) {
    const isExpanded = props.expanded.has(props.node.path)
    const indent = 12 + props.depth * 14
    const childDepth = props.depth + 1

    return (
        <div>
            <button
                type="button"
                onClick={() => props.onToggle(props.node.path)}
                className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-[var(--app-subtle-bg)] transition-colors"
                style={{ paddingLeft: indent }}
            >
                <ChevronIcon collapsed={!isExpanded} className="text-[var(--app-hint)]" />
                <FolderIcon className="text-[var(--app-link)]" />
                <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{props.node.name}</div>
                </div>
            </button>

            {isExpanded ? (
                <div>
                    {props.node.directories.map((child) => (
                        <GitChangesDirectoryNode
                            key={child.path}
                            node={child}
                            depth={childDepth}
                            expanded={props.expanded}
                            onToggle={props.onToggle}
                            onOpenFile={props.onOpenFile}
                        />
                    ))}
                    {props.node.files.map((file) => (
                        <GitFileRow
                            key={file.fullPath}
                            file={file}
                            onOpen={() => props.onOpenFile(file)}
                            depth={childDepth}
                        />
                    ))}
                </div>
            ) : null}
        </div>
    )
}

function GitChangesTree(props: {
    files: GitFileStatus[]
    onOpenFile: (file: GitFileStatus) => void
}) {
    const tree = useMemo(() => buildGitChangesTree(props.files), [props.files])
    const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']))

    const handleToggle = useCallback((path: string) => {
        setExpanded((prev) => {
            const next = new Set(prev)
            if (next.has(path)) {
                next.delete(path)
            } else {
                next.add(path)
            }
            return next
        })
    }, [])

    return (
        <div>
            {tree.directories.map((directory) => (
                <GitChangesDirectoryNode
                    key={directory.path}
                    node={directory}
                    depth={0}
                    expanded={expanded}
                    onToggle={handleToggle}
                    onOpenFile={props.onOpenFile}
                />
            ))}
            {tree.files.map((file) => (
                <GitFileRow
                    key={file.fullPath}
                    file={file}
                    onOpen={() => props.onOpenFile(file)}
                    depth={0}
                />
            ))}
        </div>
    )
}

function SearchResultRow(props: {
    file: FileSearchItem
    onOpen: () => void
    showDivider: boolean
}) {
    const subtitle = props.file.filePath || 'project root'
    const icon = props.file.fileType === 'file'
        ? <FileIcon fileName={props.file.fileName} size={22} />
        : <FolderIcon className="text-[var(--app-link)]" />

    return (
        <button
            type="button"
            onClick={props.onOpen}
            className={`flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-[var(--app-subtle-bg)] transition-colors ${props.showDivider ? 'border-b border-[var(--app-divider)]' : ''}`}
        >
            {icon}
            <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{props.file.fileName}</div>
                <div className="truncate text-xs text-[var(--app-hint)]">{subtitle}</div>
            </div>
        </button>
    )
}

function FileListSkeleton(props: { label: string; rows?: number }) {
    const titleWidths = ['w-1/3', 'w-1/2', 'w-2/3', 'w-2/5', 'w-3/5']
    const subtitleWidths = ['w-1/2', 'w-2/3', 'w-3/4', 'w-1/3']
    const rows = props.rows ?? 6

    return (
        <div className="p-3 animate-pulse space-y-3" role="status" aria-live="polite">
            <span className="sr-only">{props.label}</span>
            {Array.from({ length: rows }).map((_, index) => (
                <div key={`skeleton-row-${index}`} className="flex items-center gap-3">
                    <div className="h-6 w-6 rounded bg-[var(--app-subtle-bg)]" />
                    <div className="flex-1 space-y-2">
                        <div className={`h-3 ${titleWidths[index % titleWidths.length]} rounded bg-[var(--app-subtle-bg)]`} />
                        <div className={`h-2 ${subtitleWidths[index % subtitleWidths.length]} rounded bg-[var(--app-subtle-bg)]`} />
                    </div>
                </div>
            ))}
        </div>
    )
}

export default function FilesPage() {
    const { api } = useAppContext()
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const goBack = useAppGoBack()
    const { sessionId } = useParams({ from: '/sessions/$sessionId/files' })
    const search = useSearch({ from: '/sessions/$sessionId/files' })
    const { session } = useSession(api, sessionId)
    const [searchInput, setSearchInput] = useState('')
    const [searchQuery, setSearchQuery] = useState('')

    const initialTab = search.tab === 'directories' ? 'directories' : 'changes'
    const [activeTab, setActiveTab] = useState<'changes' | 'directories'>(initialTab)

    const {
        status: gitStatus,
        error: gitError,
        isLoading: gitLoading,
        refetch: refetchGit
    } = useGitStatusFiles(api, sessionId)

    const shouldSearch = Boolean(searchQuery)

    const searchResults = useSessionFileSearch(api, sessionId, searchQuery, {
        enabled: shouldSearch
    })

    const handleOpenFile = useCallback((path: string, staged?: boolean) => {
        const fileSearch = staged === undefined
            ? (activeTab === 'directories'
                ? { path: encodeBase64(path), tab: 'directories' as const }
                : { path: encodeBase64(path) })
            : (activeTab === 'directories'
                ? { path: encodeBase64(path), staged, tab: 'directories' as const }
                : { path: encodeBase64(path), staged })
        navigate({
            to: '/sessions/$sessionId/file',
            params: { sessionId },
            search: fileSearch
        })
    }, [activeTab, navigate, sessionId])

    const branchLabel = gitStatus?.branch ?? 'detached'
    const subtitle = session?.metadata?.path ?? sessionId
    const showGitErrorBanner = Boolean(gitError)
    const rootLabel = useMemo(() => {
        const base = session?.metadata?.path ?? sessionId
        const parts = base.split(/[/\\]/).filter(Boolean)
        return parts.length ? parts[parts.length - 1] : base
    }, [session?.metadata?.path, sessionId])

    const handleRefresh = useCallback(() => {
        if (searchQuery) {
            void queryClient.invalidateQueries({
                queryKey: queryKeys.sessionFiles(sessionId, searchQuery)
            })
            return
        }

        if (activeTab === 'directories') {
            void queryClient.invalidateQueries({
                queryKey: ['session-directory', sessionId]
            })
            return
        }

        void refetchGit()
    }, [activeTab, queryClient, refetchGit, searchQuery, sessionId])

    const handleSearchSubmit = useCallback((event?: FormEvent<HTMLFormElement>) => {
        event?.preventDefault()
        setSearchQuery(searchInput.trim())
    }, [searchInput])

    const handleTabChange = useCallback((nextTab: 'changes' | 'directories') => {
        setActiveTab(nextTab)
        navigate({
            to: '/sessions/$sessionId/files',
            params: { sessionId },
            search: nextTab === 'changes' ? {} : { tab: nextTab },
            replace: true,
        })
    }, [navigate, sessionId])

    return (
        <div className="flex h-full flex-col">
            <div className="bg-[var(--app-bg)] pt-[env(safe-area-inset-top)]">
                <div className="mx-auto w-full max-w-content flex items-center gap-2 p-3 border-b border-[var(--app-border)]">
                    <button
                        type="button"
                        onClick={goBack}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                    >
                        <BackIcon />
                    </button>
                    <div className="min-w-0 flex-1">
                        <div className="truncate font-semibold">Files</div>
                        <div className="truncate text-xs text-[var(--app-hint)]">{subtitle}</div>
                    </div>
                    <button
                        type="button"
                        onClick={handleRefresh}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                        title="Refresh"
                    >
                        <RefreshIcon />
                    </button>
                </div>
            </div>

            <div className="bg-[var(--app-bg)]">
                <form className="mx-auto w-full max-w-content p-3 border-b border-[var(--app-border)]" onSubmit={handleSearchSubmit}>
                    <div className="flex items-center gap-2 rounded-md bg-[var(--app-subtle-bg)] px-3 py-2">
                        <SearchIcon className="text-[var(--app-hint)]" />
                        <input
                            value={searchInput}
                            onChange={(event) => {
                                const nextValue = event.target.value
                                setSearchInput(nextValue)
                                if (!nextValue.trim()) {
                                    setSearchQuery('')
                                }
                            }}
                            placeholder="Search files"
                            className="w-full bg-transparent text-sm text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none"
                            autoCapitalize="none"
                            autoCorrect="off"
                        />
                        <button
                            type="submit"
                            className="rounded px-2 py-1 text-xs font-medium text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                        >
                            Search
                        </button>
                    </div>
                </form>
            </div>

            <div className="bg-[var(--app-bg)] border-b border-[var(--app-divider)]" role="tablist">
                <div className="mx-auto w-full max-w-content grid grid-cols-2">
                    <button
                        type="button"
                        role="tab"
                        aria-selected={activeTab === 'changes'}
                        onClick={() => handleTabChange('changes')}
                        className={`relative py-3 text-center text-sm font-semibold transition-colors hover:bg-[var(--app-subtle-bg)] ${activeTab === 'changes' ? 'text-[var(--app-fg)]' : 'text-[var(--app-hint)]'}`}
                    >
                        Changes
                        <span
                            className={`absolute bottom-0 left-1/2 h-0.5 w-10 -translate-x-1/2 rounded-full ${activeTab === 'changes' ? 'bg-[var(--app-link)]' : 'bg-transparent'}`}
                        />
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={activeTab === 'directories'}
                        onClick={() => handleTabChange('directories')}
                        className={`relative py-3 text-center text-sm font-semibold transition-colors hover:bg-[var(--app-subtle-bg)] ${activeTab === 'directories' ? 'text-[var(--app-fg)]' : 'text-[var(--app-hint)]'}`}
                    >
                        Directories
                        <span
                            className={`absolute bottom-0 left-1/2 h-0.5 w-10 -translate-x-1/2 rounded-full ${activeTab === 'directories' ? 'bg-[var(--app-link)]' : 'bg-transparent'}`}
                        />
                    </button>
                </div>
            </div>

            {!gitLoading && gitStatus && !searchQuery && activeTab === 'changes' ? (
                <div className="bg-[var(--app-bg)]">
                    <div className="mx-auto w-full max-w-content px-3 py-2 border-b border-[var(--app-divider)]">
                        <div className="flex items-center gap-2 text-sm">
                            <GitBranchIcon className="text-[var(--app-hint)]" />
                            <span className="font-semibold">{branchLabel}</span>
                        </div>
                        <div className="text-xs text-[var(--app-hint)]">
                            {gitStatus.totalStaged} staged, {gitStatus.totalUnstaged} unstaged
                        </div>
                    </div>
                </div>
            ) : null}

            <div className="flex-1 overflow-y-auto">
                <div className="mx-auto w-full max-w-content">
                    {showGitErrorBanner && activeTab === 'changes' ? (
                        <div className="border-b border-[var(--app-divider)] bg-amber-500/10 px-3 py-2 text-xs text-[var(--app-hint)]">
                            {gitError}
                        </div>
                    ) : null}
                    {shouldSearch ? (
                        searchResults.isLoading ? (
                            <FileListSkeleton label="Loading files…" />
                        ) : searchResults.error ? (
                            <div className="p-6 text-sm text-[var(--app-hint)]">{searchResults.error}</div>
                        ) : searchResults.files.length === 0 ? (
                            <div className="p-6 text-sm text-[var(--app-hint)]">
                                {searchQuery ? 'No files match your search.' : 'No files found in this project.'}
                            </div>
                        ) : (
                            <div className="border-t border-[var(--app-divider)]">
                                {searchResults.files.map((file, index) => (
                                    <SearchResultRow
                                        key={`${file.fullPath}-${index}`}
                                        file={file}
                                        onOpen={() => handleOpenFile(file.fullPath)}
                                        showDivider={index < searchResults.files.length - 1}
                                    />
                                ))}
                            </div>
                        )
                    ) : activeTab === 'directories' ? (
                        <DirectoryTree
                            api={api}
                            sessionId={sessionId}
                            rootLabel={rootLabel}
                            onOpenFile={(path) => handleOpenFile(path)}
                        />
                    ) : gitLoading ? (
                        <FileListSkeleton label="Loading Git status…" />
                    ) : (
                        <div>
                            {gitStatus?.stagedFiles.length ? (
                                <div>
                                    <div className="border-b border-[var(--app-divider)] bg-[var(--app-bg)] px-3 py-2 text-xs font-semibold text-[var(--app-git-staged-color)]">
                                        Staged Changes ({gitStatus.stagedFiles.length})
                                    </div>
                                    <GitChangesTree
                                        files={gitStatus.stagedFiles}
                                        onOpenFile={(file) => handleOpenFile(file.fullPath, file.isStaged)}
                                    />
                                </div>
                            ) : null}

                            {gitStatus?.unstagedFiles.length ? (
                                <div>
                                    <div className="border-b border-[var(--app-divider)] bg-[var(--app-bg)] px-3 py-2 text-xs font-semibold text-[var(--app-git-unstaged-color)]">
                                        Unstaged Changes ({gitStatus.unstagedFiles.length})
                                    </div>
                                    <GitChangesTree
                                        files={gitStatus.unstagedFiles}
                                        onOpenFile={(file) => handleOpenFile(file.fullPath, file.isStaged)}
                                    />
                                </div>
                            ) : null}

                            {!gitStatus ? (
                                <div className="p-6 text-sm text-[var(--app-hint)]">
                                    Git status unavailable. Use Directories to browse all files, or search.
                                </div>
                            ) : null}

                            {gitStatus && gitStatus.stagedFiles.length === 0 && gitStatus.unstagedFiles.length === 0 ? (
                                <div className="p-6 text-sm text-[var(--app-hint)]">
                                    No changes detected. Use Directories to browse all files, or search.
                                </div>
                            ) : null}
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}

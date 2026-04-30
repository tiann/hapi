import { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent } from 'react'
import type { ApiClient } from '@/api/client'
import type { EditorDirectoryResponse } from '@/types/api'
import { FileIcon } from '@/components/FileIcon'
import { useProjectDirectory } from '@/hooks/queries/useProjectDirectory'

type TreeEntry = NonNullable<EditorDirectoryResponse['entries']>[number]

function joinPath(base: string, name: string): string {
    return base.endsWith('/') ? `${base}${name}` : `${base}/${name}`
}

function getParentPath(path: string): string {
    const trimmed = path.replace(/\/+$/, '')
    const index = trimmed.lastIndexOf('/')
    if (index <= 0) return '/'
    return trimmed.slice(0, index)
}

function getAncestorDirectories(filePath: string, rootPath: string): string[] {
    const ancestors: string[] = []
    let current = getParentPath(filePath)
    const normalizedRoot = rootPath.replace(/\/+$/, '') || rootPath

    while (current && current !== '/' && current.startsWith(normalizedRoot)) {
        ancestors.push(current)
        if (current === normalizedRoot) break
        current = getParentPath(current)
    }

    return ancestors
}

function validateNewFileName(value: string): string | null {
    const trimmed = value.trim()
    if (!trimmed) return 'File name is required'
    if (trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed)) {
        return 'Use a relative path inside this folder'
    }
    const segments = trimmed.split(/[\\/]+/)
    if (segments.some((segment) => segment === '..')) {
        return 'Parent directory segments are not allowed'
    }
    return null
}

function NewFileInput(props: {
    parentPath: string
    indent: number
    onCreateFile?: (parentPath: string, fileName: string) => Promise<{ success: boolean; path?: string; error?: string } | unknown>
    onCancel?: () => void
}) {
    const inputRef = useRef<HTMLInputElement | null>(null)
    const [value, setValue] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [isCreating, setIsCreating] = useState(false)

    useEffect(() => {
        inputRef.current?.focus()
    }, [])

    const submit = useCallback(async () => {
        const trimmed = value.trim()
        const validationError = validateNewFileName(trimmed)
        if (validationError) {
            setError(validationError)
            return
        }
        if (!props.onCreateFile) {
            props.onCancel?.()
            return
        }

        setIsCreating(true)
        setError(null)
        try {
            const result = await props.onCreateFile(props.parentPath, trimmed)
            if (result && typeof result === 'object' && 'success' in result && result.success === false) {
                const message = 'error' in result && typeof result.error === 'string'
                    ? result.error
                    : 'Failed to create file'
                setError(message)
                return
            }
        } catch (error) {
            setError(error instanceof Error ? error.message : 'Failed to create file')
        } finally {
            setIsCreating(false)
        }
    }, [props, value])

    const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') {
            event.preventDefault()
            void submit()
        } else if (event.key === 'Escape') {
            event.preventDefault()
            props.onCancel?.()
        }
    }

    const handleBlur = (_event: FocusEvent<HTMLInputElement>) => {
        if (!isCreating) {
            props.onCancel?.()
        }
    }

    return (
        <div className="px-2 py-1" style={{ paddingLeft: props.indent }}>
            <input
                ref={inputRef}
                aria-label="New file name"
                value={value}
                disabled={isCreating}
                onChange={(event) => setValue(event.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={handleBlur}
                placeholder="new-file.ts"
                className="w-full rounded border border-[#6366f1] bg-[var(--app-bg)] px-2 py-1 text-xs text-[var(--app-fg)] outline-none"
            />
            {error ? <div className="mt-1 text-[10px] text-red-500">{error}</div> : null}
        </div>
    )
}

function ChevronIcon(props: { collapsed: boolean }) {
    return (
        <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`transition-transform duration-150 ${props.collapsed ? '' : 'rotate-90'}`}
            aria-hidden="true"
        >
            <polyline points="9 18 15 12 9 6" />
        </svg>
    )
}

function FolderIcon(props: { open?: boolean }) {
    return (
        <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-[var(--app-link)]"
            aria-hidden="true"
        >
            {props.open ? (
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2H3V7Z" />
            ) : (
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            )}
        </svg>
    )
}

function GitStatusDot(props: { status?: string }) {
    if (!props.status || props.status === 'unmodified') return null
    const color: Record<string, string> = {
        modified: '#f59e0b',
        added: '#22c55e',
        deleted: '#ef4444',
        renamed: '#818cf8',
        untracked: '#f59e0b',
    }
    return (
        <span
            className="inline-block w-1.5 h-1.5 rounded-full ml-1 shrink-0"
            style={{ backgroundColor: color[props.status] ?? '#f59e0b' }}
            title={props.status}
        />
    )
}

function DirectoryErrorRow(props: { indent: number; message: string }) {
    return (
        <div
            className="text-[10px] text-red-500 px-2 py-1"
            style={{ paddingLeft: props.indent }}
        >
            {props.message}
        </div>
    )
}

function DirectoryNode(props: {
    api: ApiClient | null
    machineId: string
    path: string
    name: string
    depth: number
    onOpenFile: (filePath: string) => void
    onContextMenu: (filePath: string, x: number, y: number) => void
    activeFilePath?: string | null
    expanded: Set<string>
    onToggle: (path: string) => void
    refreshSeq: number
    newFileTargetPath?: string | null
    onCreateFile?: (parentPath: string, fileName: string) => Promise<{ success: boolean; path?: string; error?: string } | unknown>
    onCancelNewFile?: () => void
}) {
    const isExpanded = props.expanded.has(props.path)
    const { entries, error, isLoading, refetch } = useProjectDirectory(
        props.api,
        props.machineId,
        isExpanded ? props.path : null,
        { refetchInterval: isExpanded ? 5_000 : false }
    )
    const childDepth = props.depth + 1
    const indent = 8 + props.depth * 16
    const childIndent = indent + 16

    const dirs = useMemo(() => entries.filter((entry) => entry.type === 'directory'), [entries])
    const files = useMemo(() => entries.filter((entry) => entry.type === 'file'), [entries])
    const shouldShowNewFileInput = props.newFileTargetPath === props.path
        || files.some((entry) => joinPath(props.path, entry.name) === props.newFileTargetPath)

    useEffect(() => {
        if (props.refreshSeq > 0 && isExpanded) {
            void refetch()
        }
    }, [isExpanded, props.refreshSeq, refetch])

    const handleContextMenu = useCallback((event: MouseEvent, filePath: string) => {
        event.preventDefault()
        event.stopPropagation()
        props.onContextMenu(filePath, event.clientX, event.clientY)
    }, [props])

    const renderDirectory = useCallback((entry: TreeEntry) => {
        const childPath = joinPath(props.path, entry.name)
        return (
            <DirectoryNode
                key={childPath}
                api={props.api}
                machineId={props.machineId}
                path={childPath}
                name={entry.name}
                depth={childDepth}
                onOpenFile={props.onOpenFile}
                onContextMenu={props.onContextMenu}
                activeFilePath={props.activeFilePath}
                expanded={props.expanded}
                onToggle={props.onToggle}
                refreshSeq={props.refreshSeq}
                newFileTargetPath={props.newFileTargetPath}
                onCreateFile={props.onCreateFile}
                onCancelNewFile={props.onCancelNewFile}
            />
        )
    }, [childDepth, props])

    const renderFile = useCallback((entry: TreeEntry) => {
        const filePath = joinPath(props.path, entry.name)
        const isActive = props.activeFilePath === filePath
        return (
            <button
                key={filePath}
                type="button"
                aria-label={`Open file ${entry.name}`}
                aria-current={isActive ? 'page' : undefined}
                onClick={() => props.onOpenFile(filePath)}
                onContextMenu={(event) => handleContextMenu(event, filePath)}
                className={`flex w-full items-center gap-1.5 pl-1 pr-2 py-1 text-left transition-colors text-xs text-[var(--app-fg)] ${
                    isActive ? 'bg-[var(--app-subtle-bg)] text-[var(--app-fg)]' : 'hover:bg-[var(--app-subtle-bg)]'
                }`}
                style={{ paddingLeft: indent + 14 }}
            >
                <FileIcon fileName={entry.name} size={14} />
                <span className="truncate flex-1">{entry.name}</span>
                <GitStatusDot status={entry.gitStatus} />
            </button>
        )
    }, [handleContextMenu, indent, props])

    return (
        <div>
            <button
                type="button"
                aria-label={`Toggle directory ${props.name}`}
                onClick={() => props.onToggle(props.path)}
                onContextMenu={(event) => handleContextMenu(event, props.path)}
                className="flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-[var(--app-subtle-bg)] transition-colors text-xs"
                style={{ paddingLeft: indent }}
            >
                <ChevronIcon collapsed={!isExpanded} />
                <FolderIcon open={isExpanded} />
                <span className="truncate flex-1 text-[var(--app-fg)]">{props.name}</span>
            </button>

            {isExpanded && (
                <div>
                    {isLoading && entries.length === 0 ? (
                        <div className="text-[10px] text-[var(--app-hint)] pl-4 py-1" style={{ paddingLeft: childIndent }}>
                            Loading...
                        </div>
                    ) : error ? (
                        <DirectoryErrorRow indent={childIndent} message={error} />
                    ) : (
                        <>
                            {shouldShowNewFileInput && (
                                <NewFileInput
                                    parentPath={props.path}
                                    indent={childIndent}
                                    onCreateFile={props.onCreateFile}
                                    onCancel={props.onCancelNewFile}
                                />
                            )}
                            {dirs.map(renderDirectory)}
                            {files.map(renderFile)}
                            {dirs.length === 0 && files.length === 0 && (
                                <div
                                    className="text-[10px] text-[var(--app-hint)] px-2 py-1"
                                    style={{ paddingLeft: childIndent }}
                                >
                                    Empty directory.
                                </div>
                            )}
                        </>
                    )}
                </div>
            )}
        </div>
    )
}

export function EditorFileTree(props: {
    api: ApiClient | null
    machineId: string | null
    projectPath: string | null
    onOpenFile: (filePath: string) => void
    onContextMenu: (filePath: string, x: number, y: number) => void
    activeFilePath?: string | null
    newFileTargetPath?: string | null
    onCreateFile?: (parentPath: string, fileName: string) => Promise<{ success: boolean; path?: string; error?: string } | unknown>
    onCancelNewFile?: () => void
}) {
    const [expanded, setExpanded] = useState<Set<string>>(() => (
        props.projectPath ? new Set([props.projectPath]) : new Set()
    ))
    const [refreshSeq, setRefreshSeq] = useState(0)

    useEffect(() => {
        setExpanded(props.projectPath ? new Set([props.projectPath]) : new Set())
    }, [props.projectPath])

    useEffect(() => {
        if (!props.newFileTargetPath) return
        setExpanded((prev) => {
            const next = new Set(prev)
            next.add(props.newFileTargetPath!)
            next.add(getParentPath(props.newFileTargetPath!))
            return next
        })
    }, [props.newFileTargetPath])

    useEffect(() => {
        if (!props.activeFilePath || !props.projectPath) return
        setExpanded((prev) => {
            const next = new Set(prev)
            for (const ancestor of getAncestorDirectories(props.activeFilePath!, props.projectPath!)) {
                next.add(ancestor)
            }
            return next
        })
    }, [props.activeFilePath, props.projectPath])

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

    if (!props.machineId || !props.projectPath) {
        return (
            <div className="flex items-center justify-center h-full text-xs text-[var(--app-hint)] p-4 text-center">
                Select a machine and project to browse files
            </div>
        )
    }

    const projectName = props.projectPath.split('/').filter(Boolean).pop() || props.projectPath

    return (
        <div className="flex flex-col h-full">
            <div className="px-3 py-2 text-xs font-semibold text-[var(--app-fg)] border-b border-[var(--app-border)] shrink-0 flex items-center gap-1.5">
                <FolderIcon open />
                <span className="truncate">{projectName}</span>
                <button
                    type="button"
                    aria-label="Refresh files"
                    className="ml-auto rounded px-1.5 py-0.5 text-[10px] font-normal text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                    onClick={() => setRefreshSeq((value) => value + 1)}
                    title="Refresh files"
                >
                    ↻
                </button>
            </div>
            <div className="flex-1 overflow-y-auto py-1">
                <DirectoryNode
                    api={props.api}
                    machineId={props.machineId}
                    path={props.projectPath}
                    name={projectName}
                    depth={0}
                    onOpenFile={props.onOpenFile}
                    onContextMenu={props.onContextMenu}
                    activeFilePath={props.activeFilePath}
                    expanded={expanded}
                    onToggle={handleToggle}
                    refreshSeq={refreshSeq}
                    newFileTargetPath={props.newFileTargetPath}
                    onCreateFile={props.onCreateFile}
                    onCancelNewFile={props.onCancelNewFile}
                />
            </div>
        </div>
    )
}

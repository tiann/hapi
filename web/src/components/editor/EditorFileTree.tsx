import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react'
import type { ApiClient } from '@/api/client'
import type { EditorDirectoryResponse } from '@/types/api'
import { FileIcon } from '@/components/FileIcon'
import { useProjectDirectory } from '@/hooks/queries/useProjectDirectory'

type TreeEntry = NonNullable<EditorDirectoryResponse['entries']>[number]

function joinPath(base: string, name: string): string {
    return base.endsWith('/') ? `${base}${name}` : `${base}/${name}`
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
    expanded: Set<string>
    onToggle: (path: string) => void
}) {
    const isExpanded = props.expanded.has(props.path)
    const { entries, error, isLoading } = useProjectDirectory(props.api, props.machineId, isExpanded ? props.path : null)
    const childDepth = props.depth + 1
    const indent = 8 + props.depth * 16
    const childIndent = indent + 16

    const dirs = useMemo(() => entries.filter((entry) => entry.type === 'directory'), [entries])
    const files = useMemo(() => entries.filter((entry) => entry.type === 'file'), [entries])

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
                expanded={props.expanded}
                onToggle={props.onToggle}
            />
        )
    }, [childDepth, props])

    const renderFile = useCallback((entry: TreeEntry) => {
        const filePath = joinPath(props.path, entry.name)
        return (
            <button
                key={filePath}
                type="button"
                aria-label={`Open file ${entry.name}`}
                onClick={() => props.onOpenFile(filePath)}
                onContextMenu={(event) => handleContextMenu(event, filePath)}
                className="flex w-full items-center gap-1.5 pl-1 pr-2 py-1 text-left hover:bg-[var(--app-subtle-bg)] transition-colors text-xs text-[var(--app-fg)]"
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
}) {
    const [expanded, setExpanded] = useState<Set<string>>(() => (
        props.projectPath ? new Set([props.projectPath]) : new Set()
    ))

    useEffect(() => {
        setExpanded(props.projectPath ? new Set([props.projectPath]) : new Set())
    }, [props.projectPath])

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
                    expanded={expanded}
                    onToggle={handleToggle}
                />
            </div>
        </div>
    )
}

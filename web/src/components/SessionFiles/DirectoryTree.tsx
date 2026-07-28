import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ApiClient } from '@/api/client'
import { FileIcon } from '@/components/FileIcon'
import { useSessionDirectory } from '@/hooks/queries/useSessionDirectory'
import { formatDirectoryError } from '@/lib/files-i18n'
import { useTranslation } from '@/lib/use-translation'
import { useToast } from '@/lib/toast-context'
import { downloadBase64File } from '@/lib/file-download'
import { formatFileMetadata } from '@/lib/file-metadata'
import { sortDirectoryEntries, type DirectorySort } from '@/lib/directory-sort'

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

function DownloadIcon(props: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
    )
}

function DirectorySkeleton(props: { depth: number; rows?: number }) {
    const rows = props.rows ?? 4
    const indent = 12 + props.depth * 14

    return (
        <div className="animate-pulse">
            {Array.from({ length: rows }).map((_, index) => (
                <div
                    key={`dir-skel-${props.depth}-${index}`}
                    className="flex items-center gap-3 px-3 py-2"
                    style={{ paddingLeft: indent }}
                >
                    <div className="h-5 w-5 rounded bg-[var(--app-subtle-bg)]" />
                    <div className="h-3 w-40 rounded bg-[var(--app-subtle-bg)]" />
                </div>
            ))}
        </div>
    )
}

function DirectoryErrorRow(props: { depth: number; message: string }) {
    const indent = 12 + props.depth * 14
    return (
        <div
            className="px-3 py-2 text-xs text-[var(--app-hint)] bg-amber-500/10"
            style={{ paddingLeft: indent }}
        >
            {props.message}
        </div>
    )
}

function DirectoryNode(props: {
    api: ApiClient | null
    sessionId: string
    path: string
    label: string
    depth: number
    onOpenFile: (path: string) => void
    expanded: Set<string>
    onToggle: (path: string) => void
    sort: DirectorySort
}) {
    const { t, locale } = useTranslation()
    const toast = useToast()
    const [downloadingPath, setDownloadingPath] = useState<string | null>(null)
    const isExpanded = props.expanded.has(props.path)
    const { entries, error, isLoading } = useSessionDirectory(props.api, props.sessionId, props.path, {
        enabled: isExpanded
    })

    const sortedEntries = useMemo(
        () => sortDirectoryEntries(entries, props.sort, locale),
        [entries, locale, props.sort],
    )
    const directories = useMemo(() => sortedEntries.filter((entry) => entry.type === 'directory'), [sortedEntries])
    const files = useMemo(() => sortedEntries.filter((entry) => entry.type === 'file'), [sortedEntries])
    const childDepth = props.depth + 1

    const indent = 12 + props.depth * 14
    const childIndent = 12 + childDepth * 14

    const handleDownload = async (filePath: string, fileName: string) => {
        if (!props.api || downloadingPath) return
        setDownloadingPath(filePath)
        try {
            const result = await props.api.readSessionFile(props.sessionId, filePath)
            if (!result.success || result.content === undefined) {
                throw new Error(result.error ?? t('files.directories.download.error.default'))
            }
            downloadBase64File(fileName, result.content)
        } catch (error) {
            toast.addToast({
                title: t('files.directories.download.error.title'),
                body: error instanceof Error ? error.message : t('files.directories.download.error.default'),
                sessionId: props.sessionId,
                url: `/sessions/${props.sessionId}/files?tab=directories`,
            })
        } finally {
            setDownloadingPath(null)
        }
    }

    return (
        <div>
            <button
                type="button"
                onClick={() => props.onToggle(props.path)}
                className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-[var(--app-subtle-bg)] transition-colors"
                style={{ paddingLeft: indent }}
            >
                <ChevronIcon collapsed={!isExpanded} className="text-[var(--app-hint)]" />
                <FolderIcon className="text-[var(--app-link)]" />
                <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{props.label}</div>
                </div>
            </button>

            {isExpanded ? (
                isLoading ? (
                    <DirectorySkeleton depth={childDepth} />
                ) : error ? (
                    <DirectoryErrorRow depth={childDepth} message={formatDirectoryError(error, t)} />
                ) : (
                    <div>
                        {directories.map((entry) => {
                            const childPath = props.path ? `${props.path}/${entry.name}` : entry.name
                            return (
                                <DirectoryNode
                                    key={childPath}
                                    api={props.api}
                                    sessionId={props.sessionId}
                                    path={childPath}
                                    label={entry.name}
                                    depth={childDepth}
                                    onOpenFile={props.onOpenFile}
                                    expanded={props.expanded}
                                    onToggle={props.onToggle}
                                    sort={props.sort}
                                />
                            )
                        })}

                        {files.map((entry) => {
                            const filePath = props.path ? `${props.path}/${entry.name}` : entry.name
                            const metadata = formatFileMetadata(entry.size, entry.modified, locale)
                            const isDownloading = downloadingPath === filePath
                            return (
                                <div
                                    key={filePath}
                                    className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-[var(--app-subtle-bg)] transition-colors"
                                    style={{ paddingLeft: childIndent }}
                                >
                                    <span className="h-4 w-4" />
                                    <FileIcon fileName={entry.name} size={22} />
                                    <button type="button" onClick={() => props.onOpenFile(filePath)} className="min-w-0 flex-1 text-left">
                                        <div className="truncate font-medium">{entry.name}</div>
                                        {metadata ? <div className="truncate text-xs text-[var(--app-hint)]">{metadata}</div> : null}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => void handleDownload(filePath, entry.name)}
                                        disabled={Boolean(downloadingPath)}
                                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)] disabled:cursor-wait disabled:opacity-50"
                                        title={t('files.directories.download')}
                                        aria-label={t('files.directories.downloadNamed', { name: entry.name })}
                                    >
                                        <DownloadIcon className={`h-4 w-4 ${isDownloading ? 'animate-pulse' : ''}`} />
                                    </button>
                                </div>
                            )
                        })}

                        {directories.length === 0 && files.length === 0 ? (
                            <div
                                className="px-3 py-2 text-sm text-[var(--app-hint)]"
                                style={{ paddingLeft: childIndent }}
                            >
                                {t('files.directories.empty')}
                            </div>
                        ) : null}
                    </div>
                )
            ) : null}
        </div>
    )
}

const STORAGE_KEY_PREFIX = 'hapi-dir-expanded-'

function readExpanded(sessionId: string): Set<string> {
    try {
        const raw = sessionStorage.getItem(STORAGE_KEY_PREFIX + sessionId)
        if (raw) {
            const parsed = JSON.parse(raw)
            if (Array.isArray(parsed)) return new Set(parsed as string[])
        }
    } catch {
        // ignore
    }
    return new Set([''])
}

function writeExpanded(sessionId: string, expanded: Set<string>) {
    try {
        sessionStorage.setItem(STORAGE_KEY_PREFIX + sessionId, JSON.stringify([...expanded]))
    } catch {
        // ignore
    }
}

export function DirectoryTree(props: {
    api: ApiClient | null
    sessionId: string
    rootLabel: string
    onOpenFile: (path: string) => void
    sort: DirectorySort
}) {
    const [expanded, setExpanded] = useState<Set<string>>(() => readExpanded(props.sessionId))

    useEffect(() => {
        writeExpanded(props.sessionId, expanded)
    }, [props.sessionId, expanded])

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
        <div className="border-t border-[var(--app-divider)]">
            <DirectoryNode
                api={props.api}
                sessionId={props.sessionId}
                path=""
                label={props.rootLabel}
                depth={0}
                onOpenFile={props.onOpenFile}
                expanded={expanded}
                onToggle={handleToggle}
                sort={props.sort}
            />
        </div>
    )
}


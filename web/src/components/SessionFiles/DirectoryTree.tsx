import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { queryKeys } from '@/lib/query-keys'
import { FileIcon } from '@/components/FileIcon'
import { useSessionDirectory } from '@/hooks/queries/useSessionDirectory'
import { useFileMenuTrigger } from '@/hooks/useFileMenuTrigger'
import type { AnchoredMenuPoint } from '@/hooks/useAnchoredMenu'
import { formatDirectoryError } from '@/lib/files-i18n'
import { useTranslation } from '@/lib/use-translation'
import { useToast } from '@/lib/toast-context'
import { downloadBase64File } from '@/lib/file-download'
import { formatFileMetadata } from '@/lib/file-metadata'
import { randomId } from '@/lib/randomId'
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

function PlusCircleIcon(props: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <circle cx="12" cy="12" r="9" />
            <line x1="12" y1="8" x2="12" y2="16" />
            <line x1="8" y1="12" x2="16" y2="12" />
        </svg>
    )
}

const ADD_TO_COMPOSER_CLASS = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-link)]'

function AddToComposerButton(props: { name: string; onClick: () => void; className?: string }) {
    const { t } = useTranslation()
    return (
        <button
            type="button"
            onClick={props.onClick}
            className={`${ADD_TO_COMPOSER_CLASS} ${props.className ?? ''}`}
            title={t('file.menu.addToComposer')}
            aria-label={t('files.directories.addToComposerNamed', { name: props.name })}
        >
            <PlusCircleIcon className="h-4 w-4" />
        </button>
    )
}

function UploadIcon(props: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
    )
}

function TrashIcon(props: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            <path d="M10 11v6" />
            <path d="M14 11v6" />
            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
        </svg>
    )
}

const ROW_ACTION_CLASS = 'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)] disabled:cursor-wait disabled:opacity-50'
const ROW_DELETE_CLASS = 'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-red-500/10 hover:text-red-600 disabled:cursor-wait disabled:opacity-50'

function parentDirectory(path: string): string {
    const index = path.lastIndexOf('/')
    return index === -1 ? '' : path.slice(0, index)
}

type PendingUpload = {
    id: string
    dir: string
    name: string
    size: number
    loaded: number
}

type WorkspaceFileActions = {
    uploadTo: (dir: string, label: string) => void
    requestDelete: (path: string, kind: 'file' | 'directory') => void
    /** Directory currently receiving an upload, if any. */
    uploadingDir: string | null
    /** Files being uploaded, shown in their target folder until they land. */
    pendingUploads: PendingUpload[]
}

type PendingConfirm = {
    title: string
    description: string
    confirmLabel: string
    confirmingLabel: string
    onConfirm: () => Promise<void>
    onCancel?: () => void
}

/** Smaller than the attachment chunk so the per-row progress bar moves smoothly. */
const WORKSPACE_UPLOAD_CHUNK_BYTES = 1024 * 1024

/**
 * Upload/delete against the session workspace on the runner's machine.
 * Picked files appear in their target folder straight away with a progress
 * bar; each lands as a normal row once the listing refreshes, or disappears
 * on failure. A name clash asks before replacing; deletes always ask first.
 */
function useWorkspaceFileActions(props: {
    api: ApiClient | null
    sessionId: string
    onExpand: (path: string) => void
}): { actions: WorkspaceFileActions; elements: ReactNode } {
    const { t } = useTranslation()
    const toast = useToast()
    const queryClient = useQueryClient()
    const inputRef = useRef<HTMLInputElement>(null)
    const targetRef = useRef<{ dir: string; label: string } | null>(null)
    const [uploadingDir, setUploadingDir] = useState<string | null>(null)
    const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([])
    const [confirm, setConfirm] = useState<PendingConfirm | null>(null)
    const [confirmPending, setConfirmPending] = useState(false)
    // Upload batches and confirmations are mutually exclusive: a replace
    // prompt raised mid-batch must never overwrite (or be closed by) a delete
    // prompt, so deletes wait for the batch and uploads wait for the dialog.
    const uploadingRef = useRef(false)
    const confirmOpenRef = useRef(false)
    confirmOpenRef.current = confirm !== null

    const refreshDirectory = useCallback(async (dir: string) => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.gitStatus(props.sessionId) })
        await queryClient.invalidateQueries({ queryKey: queryKeys.sessionDirectory(props.sessionId, dir) })
    }, [props.sessionId, queryClient])

    const updatePending = useCallback((id: string, loaded: number) => {
        setPendingUploads((prev) => prev.map((item) => item.id === id ? { ...item, loaded } : item))
    }, [])
    const removePending = useCallback((id: string) => {
        setPendingUploads((prev) => prev.filter((item) => item.id !== id))
    }, [])

    // Toasts here only inform: clicking one must not navigate to the chat
    // (that would close the files panel), so no session/url target.
    const notify = useCallback((title: string, body: string) => {
        toast.addToast({ title, body, sessionId: '', url: '' })
    }, [toast])

    const askToReplace = useCallback((name: string, dirLabel: string) => new Promise<boolean>((resolve) => {
        let settled = false
        const settle = (value: boolean) => {
            if (settled) return
            settled = true
            resolve(value)
        }
        setConfirm({
            title: t('files.directories.overwrite.title'),
            description: t('files.directories.overwrite.description', { name, dir: dirLabel }),
            confirmLabel: t('files.directories.overwrite.confirm'),
            confirmingLabel: t('files.directories.overwrite.confirming'),
            onConfirm: async () => settle(true),
            onCancel: () => settle(false),
        })
    }), [t])

    const uploadOne = useCallback(async (
        file: File,
        dir: string,
        overwrite: boolean,
        onProgress: (loaded: number) => void,
    ): Promise<'ok' | 'exists'> => {
        const api = props.api
        if (!api) throw new Error('Not connected')
        const uploadId = randomId()
        let offset = 0
        try {
            do {
                const end = Math.min(offset + WORKSPACE_UPLOAD_CHUNK_BYTES, file.size)
                const result = await api.uploadWorkspaceFileChunk(props.sessionId, {
                    dir,
                    name: file.name,
                    uploadId,
                    offset,
                    final: end >= file.size,
                    overwrite,
                }, file.slice(offset, end))
                if (!result.success) {
                    if (result.code === 'exists') return 'exists'
                    throw new Error(result.error ?? t('files.directories.upload.error.title'))
                }
                offset = end
                onProgress(offset)
            } while (offset < file.size)
            return 'ok'
        } catch (error) {
            if (offset > 0) {
                await api.abortWorkspaceUpload(props.sessionId, { dir, name: file.name, uploadId }).catch(() => {})
            }
            throw error
        }
    }, [props.api, props.sessionId, t])

    const handleFiles = useCallback(async (files: File[]) => {
        const target = targetRef.current
        if (!target || files.length === 0 || uploadingRef.current) return
        uploadingRef.current = true
        setUploadingDir(target.dir)
        props.onExpand(target.dir)
        const queued = files.map((file) => ({
            file,
            pending: { id: randomId(), dir: target.dir, name: file.name, size: file.size, loaded: 0 },
        }))
        setPendingUploads((prev) => [...prev, ...queued.map((item) => item.pending)])

        const uploaded: string[] = []
        try {
            for (const { file, pending } of queued) {
                const onProgress = (loaded: number) => updatePending(pending.id, loaded)
                try {
                    let outcome = await uploadOne(file, target.dir, false, onProgress)
                    if (outcome === 'exists') {
                        if (!await askToReplace(file.name, target.label)) {
                            removePending(pending.id)
                            continue
                        }
                        outcome = await uploadOne(file, target.dir, true, onProgress)
                    }
                    // Keep the progress row until the refreshed listing shows
                    // the real file, so the row never blinks out and back.
                    await refreshDirectory(target.dir).catch(() => {})
                    removePending(pending.id)
                    uploaded.push(file.name)
                } catch (error) {
                    removePending(pending.id)
                    notify(
                        t('files.directories.upload.failedNamed', { name: file.name }),
                        error instanceof Error ? error.message : String(error),
                    )
                }
            }
        } finally {
            setPendingUploads((prev) => prev.filter((item) => !queued.some((q) => q.pending.id === item.id)))
            uploadingRef.current = false
            setUploadingDir(null)
        }

        if (uploaded.length > 0) {
            notify(
                t('files.directories.upload.successTitle'),
                uploaded.length === 1
                    ? t('files.directories.upload.doneNamed', { name: uploaded[0], dir: target.label })
                    : t('files.directories.upload.done', { count: uploaded.length, dir: target.label }),
            )
        }
    }, [askToReplace, notify, props, refreshDirectory, removePending, t, updatePending, uploadOne])

    const uploadTo = useCallback((dir: string, label: string) => {
        if (uploadingDir !== null || uploadingRef.current || confirmOpenRef.current) return
        targetRef.current = { dir, label }
        inputRef.current?.click()
    }, [uploadingDir])

    const requestDelete = useCallback((path: string, kind: 'file' | 'directory') => {
        if (uploadingRef.current || confirmOpenRef.current) return
        setConfirm({
            title: t(kind === 'directory' ? 'files.directories.delete.folderTitle' : 'files.directories.delete.fileTitle'),
            description: t(
                kind === 'directory' ? 'files.directories.delete.folderDescription' : 'files.directories.delete.fileDescription',
                { path }
            ),
            confirmLabel: t('files.directories.delete.confirm'),
            confirmingLabel: t('files.directories.delete.confirming'),
            onConfirm: async () => {
                if (!props.api) throw new Error('Not connected')
                const result = await props.api.deleteWorkspacePath(props.sessionId, { path, kind })
                if (result.success || result.code === 'kind_mismatch') {
                    void refreshDirectory(parentDirectory(path))
                }
                if (!result.success) {
                    throw new Error(result.error ?? t('files.directories.delete.error.default'))
                }
                if (kind === 'directory') {
                    queryClient.removeQueries({ queryKey: queryKeys.sessionDirectory(props.sessionId, path) })
                }
            },
        })
    }, [props.api, props.sessionId, queryClient, refreshDirectory, t])

    const closeConfirm = useCallback(() => {
        confirm?.onCancel?.()
        setConfirm(null)
    }, [confirm])

    const elements = (
        <>
            <input
                ref={inputRef}
                type="file"
                multiple
                className="hidden"
                data-testid="workspace-upload-input"
                onChange={(event) => {
                    const files = Array.from(event.target.files ?? [])
                    event.target.value = ''
                    void handleFiles(files)
                }}
            />
            <ConfirmDialog
                isOpen={confirm !== null}
                onClose={closeConfirm}
                title={confirm?.title ?? ''}
                description={confirm?.description ?? ''}
                confirmLabel={confirm?.confirmLabel ?? ''}
                confirmingLabel={confirm?.confirmingLabel ?? ''}
                onConfirm={async () => {
                    if (!confirm) return
                    setConfirmPending(true)
                    try {
                        // The replace prompt settles once, so the close that
                        // follows a confirm cannot also report "cancelled".
                        await confirm.onConfirm()
                    } finally {
                        setConfirmPending(false)
                    }
                }}
                isPending={confirmPending}
                destructive
            />
        </>
    )

    return {
        actions: { uploadTo, requestDelete, uploadingDir, pendingUploads },
        elements,
    }
}

function PendingUploadRow(props: { upload: PendingUpload; indent: number }) {
    const { t } = useTranslation()
    const percent = props.upload.size === 0
        ? (props.upload.loaded > 0 ? 100 : 0)
        : Math.min(100, Math.round((props.upload.loaded / props.upload.size) * 100))
    return (
        <div
            className="relative flex w-full items-center gap-3 overflow-hidden px-3 py-2 text-left"
            style={{ paddingLeft: props.indent }}
            data-testid="pending-upload-row"
            aria-busy="true"
        >
            <div
                className="pointer-events-none absolute inset-y-0 left-0 bg-[var(--app-link)] opacity-15 transition-[width] duration-300 ease-out"
                style={{ width: `${percent}%` }}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                aria-label={props.upload.name}
            />
            <span className="relative h-7 w-7 shrink-0" />
            <span className="relative h-4 w-4" />
            <span className="relative opacity-60">
                <FileIcon fileName={props.upload.name} size={22} />
            </span>
            <div className="relative min-w-0 flex-1">
                <div className="truncate font-medium text-[var(--app-hint)]">{props.upload.name}</div>
                <div className="truncate text-xs text-[var(--app-link)]">
                    {t('files.directories.uploadingPercent', { percent })}
                </div>
            </div>
        </div>
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

type FileMenuRequestHandler = (path: string, point: AnchoredMenuPoint) => void

function DirectoryFileRow(props: {
    fileName: string
    metadata: string | null
    indent: number
    isDownloading: boolean
    downloadDisabled: boolean
    onOpen: () => void
    onDownload: () => void
    onDelete?: () => void
    deleteDisabled?: boolean
    onAddToComposer?: () => void
    onOpenMenu?: (point: AnchoredMenuPoint) => void
}) {
    const { t } = useTranslation()
    const rowHandlers = useFileMenuTrigger({
        onOpen: props.onOpen,
        onOpenMenu: props.onOpenMenu,
    })

    return (
        <div
            className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-[var(--app-subtle-bg)] transition-colors"
            style={{ paddingLeft: props.indent }}
        >
            {props.onAddToComposer ? (
                <AddToComposerButton name={props.fileName} onClick={props.onAddToComposer} />
            ) : null}
            <span className="h-4 w-4" />
            <FileIcon fileName={props.fileName} size={22} />
            <button
                type="button"
                {...rowHandlers}
                className="min-w-0 flex-1 text-left"
            >
                <div className="truncate font-medium">{props.fileName}</div>
                {props.metadata ? <div className="truncate text-xs text-[var(--app-hint)]">{props.metadata}</div> : null}
            </button>
            <button
                type="button"
                onClick={props.onDownload}
                disabled={props.downloadDisabled}
                className={ROW_ACTION_CLASS}
                title={t('files.directories.download')}
                aria-label={t('files.directories.downloadNamed', { name: props.fileName })}
            >
                <DownloadIcon className={`h-4 w-4 ${props.isDownloading ? 'animate-pulse' : ''}`} />
            </button>
            {props.onDelete ? (
                <button
                    type="button"
                    onClick={props.onDelete}
                    disabled={props.deleteDisabled}
                    className={ROW_DELETE_CLASS}
                    title={t('files.directories.delete')}
                    aria-label={t('files.directories.deleteNamed', { name: props.fileName })}
                >
                    <TrashIcon className="h-4 w-4" />
                </button>
            ) : null}
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
    onRequestFileMenu?: FileMenuRequestHandler
    expanded: Set<string>
    onToggle: (path: string) => void
    sort: DirectorySort
    actions?: WorkspaceFileActions
    onAddToComposer?: (path: string) => void
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
    const pendingHere = useMemo(
        () => (props.actions?.pendingUploads ?? []).filter((upload) => upload.dir === props.path),
        [props.actions?.pendingUploads, props.path],
    )
    // A replacing upload stands in for the existing row until it lands.
    const visibleFiles = useMemo(() => {
        if (pendingHere.length === 0) return files
        const pendingNames = new Set(pendingHere.map((upload) => upload.name))
        return files.filter((entry) => !pendingNames.has(entry.name))
    }, [files, pendingHere])
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
            <div
                className="flex w-full items-center gap-1 pr-3 hover:bg-[var(--app-subtle-bg)] transition-colors"
                style={{ paddingLeft: indent }}
            >
                {props.onAddToComposer ? (
                    props.depth > 0 ? (
                        <AddToComposerButton
                            name={props.label}
                            onClick={() => props.onAddToComposer!(`${props.path}/`)}
                            className="mr-2"
                        />
                    ) : (
                        // Root: keep the column aligned; the workspace itself is not a reference.
                        <span className="mr-2 h-7 w-7 shrink-0" />
                    )
                ) : null}
                <button
                    type="button"
                    onClick={() => props.onToggle(props.path)}
                    className="flex min-w-0 flex-1 items-center gap-3 py-2 pr-2 text-left"
                    aria-expanded={isExpanded}
                >
                    <ChevronIcon collapsed={!isExpanded} className="shrink-0 text-[var(--app-hint)]" />
                    <FolderIcon className="shrink-0 text-[var(--app-link)]" />
                    <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{props.label}</div>
                    </div>
                </button>
                {props.actions ? (
                    <>
                        <button
                            type="button"
                            onClick={() => props.actions!.uploadTo(props.path, props.label)}
                            disabled={props.actions.uploadingDir !== null}
                            className={ROW_ACTION_CLASS}
                            title={t('files.directories.upload')}
                            aria-label={t('files.directories.uploadNamed', { name: props.label })}
                        >
                            <UploadIcon className={`h-4 w-4 ${props.actions.uploadingDir === props.path ? 'animate-pulse' : ''}`} />
                        </button>
                        {props.depth > 0 ? (
                            <button
                                type="button"
                                onClick={() => props.actions!.requestDelete(props.path, 'directory')}
                                disabled={props.actions.uploadingDir !== null}
                                className={ROW_DELETE_CLASS}
                                title={t('files.directories.delete')}
                                aria-label={t('files.directories.deleteNamed', { name: props.label })}
                            >
                                <TrashIcon className="h-4 w-4" />
                            </button>
                        ) : (
                            <span className="h-9 w-9 shrink-0" />
                        )}
                    </>
                ) : null}
            </div>

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
                                    onRequestFileMenu={props.onRequestFileMenu}
                                    expanded={props.expanded}
                                    onToggle={props.onToggle}
                                    sort={props.sort}
                                    actions={props.actions}
                                    onAddToComposer={props.onAddToComposer}
                                />
                            )
                        })}

                        {pendingHere.map((upload) => (
                            <PendingUploadRow key={upload.id} upload={upload} indent={childIndent} />
                        ))}

                        {visibleFiles.map((entry) => {
                            const filePath = props.path ? `${props.path}/${entry.name}` : entry.name
                            const metadata = formatFileMetadata(entry.size, entry.modified, locale)
                            const isDownloading = downloadingPath === filePath
                            return (
                                <DirectoryFileRow
                                    key={filePath}
                                    fileName={entry.name}
                                    metadata={metadata}
                                    indent={childIndent}
                                    isDownloading={isDownloading}
                                    downloadDisabled={Boolean(downloadingPath)}
                                    onOpen={() => props.onOpenFile(filePath)}
                                    onDownload={() => void handleDownload(filePath, entry.name)}
                                    onDelete={props.actions
                                        ? () => props.actions!.requestDelete(filePath, 'file')
                                        : undefined}
                                    deleteDisabled={props.actions?.uploadingDir != null}
                                    onAddToComposer={props.onAddToComposer
                                        ? () => props.onAddToComposer!(filePath)
                                        : undefined}
                                    onOpenMenu={props.onRequestFileMenu
                                        ? (point) => props.onRequestFileMenu!(filePath, point)
                                        : undefined}
                                />
                            )
                        })}

                        {directories.length === 0 && files.length === 0 && pendingHere.length === 0 ? (
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
    onRequestFileMenu?: FileMenuRequestHandler
    sort: DirectorySort
    /** Show upload/delete actions (default true). */
    allowFileManagement?: boolean
    /** Insert a workspace-relative path (folders end in `/`) into the composer. */
    onAddToComposer?: (path: string) => void
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

    const expand = useCallback((path: string) => {
        setExpanded((prev) => {
            if (prev.has(path)) return prev
            const next = new Set(prev)
            next.add(path)
            return next
        })
    }, [])
    const fileActions = useWorkspaceFileActions({
        api: props.api,
        sessionId: props.sessionId,
        onExpand: expand,
    })

    return (
        <div className="border-t border-[var(--app-divider)]">
            <DirectoryNode
                api={props.api}
                sessionId={props.sessionId}
                path=""
                label={props.rootLabel}
                depth={0}
                onOpenFile={props.onOpenFile}
                onRequestFileMenu={props.onRequestFileMenu}
                expanded={expanded}
                onToggle={handleToggle}
                sort={props.sort}
                actions={props.allowFileManagement === false ? undefined : fileActions.actions}
                onAddToComposer={props.onAddToComposer}
            />
            {fileActions.elements}
        </div>
    )
}


import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type {
    ReadRecycleBinEntryResponse,
    RecycleBinEntry,
    RecycleBinRestoreConflict,
} from '@/types/api'
import { FileIcon } from '@/components/FileIcon'
import { Button } from '@/components/ui/button'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { formatFileMetadata } from '@/lib/file-metadata'
import { decodeBase64 } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'

const DAY_MS = 24 * 60 * 60 * 1000
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
    apng: 'image/apng',
    avif: 'image/avif',
    bmp: 'image/bmp',
    gif: 'image/gif',
    ico: 'image/x-icon',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    png: 'image/png',
    svg: 'image/svg+xml',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    webp: 'image/webp',
}

function imageMimeType(fileName: string): string | null {
    const extension = fileName.split('.').pop()?.toLowerCase()
    return extension ? IMAGE_MIME_BY_EXTENSION[extension] ?? null : null
}

function formatDate(value: number, locale: 'en' | 'zh-CN'): string {
    return new Intl.DateTimeFormat(locale, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    }).format(new Date(value))
}

function remainingDays(expiresAt: number): number {
    return Math.max(0, Math.ceil((expiresAt - Date.now()) / DAY_MS))
}

function TrashIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M3 6h18" />
            <path d="M8 6V4h8v2" />
            <path d="m19 6-1 14H6L5 6" />
            <path d="M10 11v5M14 11v5" />
        </svg>
    )
}

function PreviewIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M2.5 12s3.5-7 9.5-7 9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7z" />
            <circle cx="12" cy="12" r="2.5" />
        </svg>
    )
}

function RestoreIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M3 12a9 9 0 1 0 3-6.7" />
            <path d="M3 4v6h6" />
        </svg>
    )
}

export type RecycleBinDialogProps = {
    api: ApiClient | null
    sessionId: string
    isOpen: boolean
    onClose: () => void
    onChanged?: () => void | Promise<void>
}

type PreviewState = {
    entry: RecycleBinEntry
    result: ReadRecycleBinEntryResponse
}

export function RecycleBinDialog(props: RecycleBinDialogProps) {
    const { t, locale } = useTranslation()
    const [entries, setEntries] = useState<RecycleBinEntry[]>([])
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [pendingEntryId, setPendingEntryId] = useState<string | null>(null)
    const [pendingAction, setPendingAction] = useState<'restore' | 'purge' | 'empty' | null>(null)
    const [purgeEntry, setPurgeEntry] = useState<RecycleBinEntry | null>(null)
    const [emptyConfirmOpen, setEmptyConfirmOpen] = useState(false)
    const [emptyEntryIds, setEmptyEntryIds] = useState<string[]>([])
    const [conflictEntry, setConflictEntry] = useState<RecycleBinEntry | null>(null)
    const [preview, setPreview] = useState<PreviewState | null>(null)
    const [previewLoading, setPreviewLoading] = useState(false)

    const load = useCallback(async () => {
        if (!props.api) return
        setIsLoading(true)
        setError(null)
        try {
            const response = await props.api.listRecycleBin(props.sessionId)
            if (!response.success) {
                throw new Error(response.error ?? t('recycleBin.error.list'))
            }
            setEntries(response.entries ?? [])
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : t('recycleBin.error.list'))
        } finally {
            setIsLoading(false)
        }
    }, [props.api, props.sessionId, t])

    useEffect(() => {
        if (props.isOpen) void load()
    }, [load, props.isOpen])

    const refreshAfterChange = useCallback(async () => {
        await load()
        await props.onChanged?.()
    }, [load, props.onChanged])

    const handleRestore = useCallback(async (entry: RecycleBinEntry, conflict: RecycleBinRestoreConflict = 'fail') => {
        if (!props.api || pendingEntryId) return
        if (conflict !== 'fail') setConflictEntry(null)
        setPendingEntryId(entry.id)
        setPendingAction('restore')
        setError(null)
        try {
            const response = await props.api.restoreRecycleBinEntry(props.sessionId, entry.id, conflict)
            if (!response.success) {
                if (response.code === 'target_exists' && conflict === 'fail') {
                    setConflictEntry(entry)
                    return
                }
                throw new Error(response.error ?? t('recycleBin.error.restore'))
            }
            if (!response.cancelled) {
                await refreshAfterChange()
            }
        } catch (restoreError) {
            await load()
            setError(restoreError instanceof Error ? restoreError.message : t('recycleBin.error.restore'))
        } finally {
            setPendingEntryId(null)
            setPendingAction(null)
        }
    }, [pendingEntryId, props.api, props.sessionId, refreshAfterChange, t])

    const handlePurge = useCallback(async () => {
        if (!props.api || !purgeEntry) return
        setPendingEntryId(purgeEntry.id)
        setPendingAction('purge')
        setError(null)
        try {
            const response = await props.api.purgeRecycleBinEntry(props.sessionId, purgeEntry.id)
            if (!response.success) throw new Error(response.error ?? t('recycleBin.error.purge'))
            setPurgeEntry(null)
            await refreshAfterChange()
        } catch (purgeError) {
            await load()
            const message = purgeError instanceof Error ? purgeError.message : t('recycleBin.error.purge')
            setError(message)
            throw purgeError instanceof Error ? purgeError : new Error(message)
        } finally {
            setPendingEntryId(null)
            setPendingAction(null)
        }
    }, [props.api, props.sessionId, purgeEntry, refreshAfterChange, t])

    const handleEmpty = useCallback(async () => {
        if (!props.api) return
        setPendingAction('empty')
        setError(null)
        try {
            const response = await props.api.emptyRecycleBin(props.sessionId, emptyEntryIds)
            if (!response.success) throw new Error(response.error ?? t('recycleBin.error.empty'))
            setEmptyConfirmOpen(false)
            setEmptyEntryIds([])
            await refreshAfterChange()
        } catch (emptyError) {
            await load()
            const message = emptyError instanceof Error ? emptyError.message : t('recycleBin.error.empty')
            setError(message)
            throw emptyError instanceof Error ? emptyError : new Error(message)
        } finally {
            setPendingAction(null)
        }
    }, [emptyEntryIds, props.api, props.sessionId, refreshAfterChange, t])

    const handleOpenEmptyConfirm = useCallback(() => {
        setEmptyEntryIds(entries.map((entry) => entry.id))
        setEmptyConfirmOpen(true)
    }, [entries])

    const handlePreview = useCallback(async (entry: RecycleBinEntry) => {
        if (!props.api || pendingEntryId || previewLoading) return
        setPreviewLoading(true)
        setError(null)
        try {
            const result = await props.api.readRecycleBinEntry(props.sessionId, entry.id)
            if (!result.success && !result.content) {
                throw new Error(result.error ?? t('recycleBin.error.preview'))
            }
            setPreview({ entry, result })
        } catch (previewError) {
            setError(previewError instanceof Error ? previewError.message : t('recycleBin.error.preview'))
        } finally {
            setPreviewLoading(false)
        }
    }, [pendingEntryId, previewLoading, props.api, props.sessionId, t])

    const previewContent = useMemo(() => {
        if (preview?.result.content === undefined) return null
        return decodeBase64(preview.result.content)
    }, [preview])

    return (
        <>
            <Dialog open={props.isOpen} onOpenChange={(open) => { if (!open) props.onClose() }}>
                <DialogContent className="max-h-[min(85vh,720px)] max-w-xl overflow-y-auto">
                    <DialogHeader className="pr-0 text-center">
                        <DialogTitle className="min-h-6 px-10 text-center leading-6">
                            {t('recycleBin.title')}
                        </DialogTitle>
                    </DialogHeader>

                    {entries.length > 0 ? (
                        <div className="mt-2 flex items-center justify-between gap-2">
                            <span className="text-xs text-[var(--app-hint)]">
                                {t('recycleBin.itemCount', { count: entries.length })}
                            </span>
                            <Button
                                type="button"
                                variant="destructive"
                                size="sm"
                                disabled={pendingAction !== null}
                                onClick={handleOpenEmptyConfirm}
                            >
                                <TrashIcon className="mr-1.5 h-3.5 w-3.5" />
                                {t('recycleBin.empty')}
                            </Button>
                        </div>
                    ) : null}

                    {error ? (
                        <div className="mt-3 rounded-md bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">
                            {error}
                        </div>
                    ) : null}

                    {isLoading ? (
                        <div className="py-10 text-center text-sm text-[var(--app-hint)]">{t('recycleBin.loading')}</div>
                    ) : entries.length === 0 ? (
                        <div className="py-10 text-center text-sm text-[var(--app-hint)]">{t('recycleBin.emptyState')}</div>
                    ) : (
                        <div className="mt-3 space-y-2">
                            {entries.map((entry) => {
                                const busy = pendingEntryId === entry.id
                                return (
                                    <div key={entry.id} className="rounded-lg border border-[var(--app-border)] p-3">
                                        <div className="flex min-w-0 items-start gap-2">
                                            <FileIcon fileName={entry.name} size={20} />
                                            <div className="min-w-0 flex-1">
                                                <div className="truncate text-sm font-medium" title={entry.name}>{entry.name}</div>
                                                <div className="break-all text-xs text-[var(--app-hint)]" title={entry.originalPath}>{entry.originalPath}</div>
                                                <div className="mt-1 text-[11px] text-[var(--app-hint)]">
                                                    {formatFileMetadata(entry.size, entry.deletedAt, locale)}
                                                    {' · '}
                                                    {t('recycleBin.expires', { date: formatDate(entry.expiresAt, locale), days: remainingDays(entry.expiresAt) })}
                                                </div>
                                            </div>
                                        </div>
                                        <div className="mt-2 grid grid-cols-3 gap-1 md:flex md:flex-nowrap md:justify-end md:gap-2">
                                            <Button type="button" variant="outline" size="sm" className="w-full min-w-0 gap-1 px-1 md:w-auto md:gap-0 md:px-3" disabled={busy || pendingAction !== null} onClick={() => void handlePreview(entry)}>
                                                <PreviewIcon className="h-3.5 w-3.5 md:mr-1.5" />
                                                {t('recycleBin.preview')}
                                            </Button>
                                            <Button type="button" variant="outline" size="sm" className="w-full min-w-0 gap-1 px-1 md:w-auto md:gap-0 md:px-3" disabled={busy || pendingAction !== null} onClick={() => void handleRestore(entry)}>
                                                <RestoreIcon className="h-3.5 w-3.5 md:mr-1.5" />
                                                {busy && pendingAction === 'restore' ? t('recycleBin.restoring') : t('recycleBin.restore')}
                                            </Button>
                                            <Button type="button" variant="destructive" size="sm" className="w-full min-w-0 gap-1 px-1 md:w-auto md:gap-0 md:px-3" disabled={busy || pendingAction !== null} onClick={() => setPurgeEntry(entry)}>
                                                <TrashIcon className="h-3.5 w-3.5 md:mr-1.5" />
                                                {t('recycleBin.purge')}
                                            </Button>
                                        </div>
                                    </div>
                                )
                            })}
                        </div>
                    )}
                </DialogContent>
            </Dialog>

            <ConfirmDialog
                isOpen={purgeEntry !== null}
                onClose={() => setPurgeEntry(null)}
                title={t('recycleBin.purgeConfirmTitle')}
                description={purgeEntry ? t('recycleBin.purgeConfirmDescription', { name: purgeEntry.name, path: purgeEntry.originalPath }) : ''}
                confirmLabel={t('recycleBin.purgeConfirm')}
                confirmingLabel={t('recycleBin.purgeConfirming')}
                onConfirm={handlePurge}
                isPending={pendingAction === 'purge'}
                destructive
                centerTitle
            />

            <ConfirmDialog
                isOpen={emptyConfirmOpen}
                onClose={() => {
                    setEmptyConfirmOpen(false)
                    setEmptyEntryIds([])
                }}
                title={t('recycleBin.emptyConfirmTitle')}
                description={t('recycleBin.emptyConfirmDescription', { count: emptyEntryIds.length })}
                confirmLabel={t('recycleBin.emptyConfirm')}
                confirmingLabel={t('recycleBin.emptyConfirming')}
                onConfirm={handleEmpty}
                isPending={pendingAction === 'empty'}
                destructive
                centerTitle
            />

            <Dialog open={preview !== null || previewLoading} onOpenChange={(open) => { if (!open && !previewLoading) setPreview(null) }}>
                <DialogContent className="max-h-[min(85vh,720px)] max-w-3xl overflow-y-auto">
                    <DialogHeader className="text-left">
                        <DialogTitle>{preview?.entry.name ?? t('recycleBin.preview')}</DialogTitle>
                        <DialogDescription>{preview?.entry.originalPath ?? t('recycleBin.preview')}</DialogDescription>
                    </DialogHeader>
                    {previewLoading ? (
                        <div className="py-10 text-center text-sm text-[var(--app-hint)]">{t('recycleBin.previewLoading')}</div>
                    ) : preview?.result.success && preview.result.content !== undefined ? (
                        imageMimeType(preview.entry.name) ? (
                            <img
                                src={`data:${imageMimeType(preview.entry.name)};base64,${preview.result.content}`}
                                alt={preview.entry.name}
                                className="max-h-[65vh] w-full object-contain"
                            />
                        ) : previewContent?.ok ? (
                            <pre className="max-h-[65vh] overflow-auto rounded-md bg-[var(--app-code-bg)] p-3 text-xs font-mono whitespace-pre-wrap">
                                {previewContent.text}
                            </pre>
                        ) : (
                            <div className="py-10 text-center text-sm text-[var(--app-hint)]">{t('recycleBin.previewUnavailable')}</div>
                        )
                    ) : (
                        <div className="py-10 text-center text-sm text-[var(--app-hint)]">
                            {preview?.result.error ?? t('recycleBin.previewUnavailable')}
                        </div>
                    )}
                </DialogContent>
            </Dialog>

            <Dialog open={conflictEntry !== null} onOpenChange={(open) => { if (!open) setConflictEntry(null) }}>
                <DialogContent className="max-w-sm">
                    <DialogHeader>
                        <DialogTitle>{t('recycleBin.restoreConflictTitle')}</DialogTitle>
                        <DialogDescription>
                            {conflictEntry
                                ? t('recycleBin.restoreConflictDescription', { name: conflictEntry.name, path: conflictEntry.originalPath })
                                : ''}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="mt-4 grid gap-2">
                        <Button type="button" variant="destructive" disabled={pendingAction !== null} onClick={() => conflictEntry && void handleRestore(conflictEntry, 'overwrite')}>
                            {t('recycleBin.restoreConflictOverwrite')}
                        </Button>
                        <Button type="button" variant="outline" disabled={pendingAction !== null} onClick={() => conflictEntry && void handleRestore(conflictEntry, 'new-name')}>
                            {t('recycleBin.restoreConflictNewName')}
                        </Button>
                        <Button type="button" variant="secondary" disabled={pendingAction !== null} onClick={() => setConflictEntry(null)}>
                            {t('recycleBin.restoreConflictCancel')}
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        </>
    )
}

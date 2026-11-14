import { useEffect, useMemo, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { SelectControl } from '@/components/ui/select-control'
import type { LocalSessionListItem } from '@/lib/localSessionImport'

/** Visible labels; callers map their flavor locale keys onto these. */
export type LocalSessionImportDialogLabels = {
    title: string
    description: string
    concurrentWarning?: string
    loading: string
    empty: string
    selectedCount: string
    clearAll: string
    selectAll: string
    allDirectories: string
    search: string
    imported: string
    needsAttention?: string
    messages?: string
    importing: string
    confirm: string
    cancel: string
}

const ALL_DIRECTORIES = '__all__'

/**
 * Generic import dialog: identical behavior for every flavor —
 * filter by directory and text, select multiple native sessions, import.
 */
export function LocalSessionImportDialog(props: {
    isOpen: boolean
    onClose: () => void
    sessions: LocalSessionListItem[]
    labels: LocalSessionImportDialogLabels
    currentSessionId?: string | null
    currentWorkDirectory?: string | null
    onConfirm: (sessionIds: string[]) => Promise<void>
    isPending: boolean
    isLoading: boolean
}) {
    const labels = props.labels
    const [selectedIds, setSelectedIds] = useState<string[]>([])
    const [directory, setDirectory] = useState(ALL_DIRECTORIES)
    const [query, setQuery] = useState('')
    const wasOpenRef = useRef(false)
    const directoryChosenRef = useRef(false)

    const directories = useMemo(() => Array.from(new Set(props.sessions
        .map((session) => session.cwd?.trim())
        .filter((value): value is string => Boolean(value)))).sort(), [props.sessions])
    const filtered = useMemo(() => {
        const normalized = query.trim().toLowerCase()
        return props.sessions.filter((session) => {
            if (directory !== ALL_DIRECTORIES && session.cwd !== directory) return false
            if (!normalized) return true
            return [session.title, session.lastUserMessage, session.cwd, session.id, session.model]
                .filter((value): value is string => typeof value === 'string')
                .some((value) => value.toLowerCase().includes(normalized))
        })
    }, [directory, props.sessions, query])

    useEffect(() => {
        if (!props.isOpen) {
            wasOpenRef.current = false
            return
        }
        // Initialize once per open transition: a sessions refresh while the
        // dialog is open changes `directories` and must not wipe in-progress
        // picks.
        if (wasOpenRef.current) return
        wasOpenRef.current = true
        directoryChosenRef.current = false
        setSelectedIds(props.currentSessionId ? [props.currentSessionId] : [])
        setDirectory(ALL_DIRECTORIES)
        setQuery('')
    }, [props.currentSessionId, props.isOpen])

    useEffect(() => {
        // The default directory filter needs the scanned directories: the
        // dialog usually opens while the scan is still running, so pick it
        // once the first scan completes (the current work directory when it
        // has sessions, all directories otherwise) and never override a
        // filter the user already changed.
        if (!props.isOpen || props.isLoading || directoryChosenRef.current) return
        directoryChosenRef.current = true
        const cwd = props.currentWorkDirectory?.trim()
        setDirectory(cwd && directories.includes(cwd) ? cwd : ALL_DIRECTORIES)
    }, [directories, props.currentWorkDirectory, props.isLoading, props.isOpen])

    const chooseDirectory = (value: string) => {
        directoryChosenRef.current = true
        setDirectory(value)
    }

    const toggle = (id: string) => {
        if (props.isPending || props.isLoading) return
        setSelectedIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id])
    }

    return (
        <Dialog open={props.isOpen} onOpenChange={(open) => !open && props.onClose()}>
            <DialogContent className="max-w-xl">
                <DialogHeader className="text-left">
                    <DialogTitle>{labels.title}</DialogTitle>
                    <DialogDescription>{labels.description}</DialogDescription>
                </DialogHeader>
                <div className="mt-3 space-y-3">
                    {labels.concurrentWarning ? (
                        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                            {labels.concurrentWarning}
                        </div>
                    ) : null}
                    <div className="flex items-center justify-between text-xs text-[var(--app-hint)]">
                        <span>{labels.selectedCount.replace('{n}', String(selectedIds.length))}</span>
                        <div className="flex gap-2">
                            <Button type="button" variant="secondary" size="sm" disabled={selectedIds.length === 0 || props.isPending} onClick={() => setSelectedIds([])}>
                                {labels.clearAll}
                            </Button>
                            <Button type="button" variant="secondary" size="sm" disabled={filtered.length === 0 || props.isPending} onClick={() => setSelectedIds(filtered.map((session) => session.id))}>
                                {labels.selectAll}
                            </Button>
                        </div>
                    </div>
                    {props.sessions.length > 0 ? (
                        <div className="grid gap-2 sm:grid-cols-2">
                            <SelectControl value={directory} disabled={props.isPending} onChange={(event) => chooseDirectory(event.target.value)}>
                                <option value={ALL_DIRECTORIES}>{labels.allDirectories}</option>
                                {directories.map((value) => <option key={value} value={value}>{value}</option>)}
                            </SelectControl>
                            <input
                                type="search"
                                className="h-9 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 text-sm text-[var(--app-fg)]"
                                value={query}
                                disabled={props.isPending}
                                placeholder={labels.search}
                                onChange={(event) => setQuery(event.target.value)}
                            />
                        </div>
                    ) : null}
                    <div className="max-h-[50vh] overflow-y-auto rounded-lg border border-[var(--app-border)]">
                        {props.isLoading ? (
                            <div className="px-4 py-8 text-center text-sm text-[var(--app-hint)]">{labels.loading}</div>
                        ) : filtered.length === 0 ? (
                            <div className="px-4 py-8 text-center text-sm text-[var(--app-hint)]">{labels.empty}</div>
                        ) : (
                            <div className="divide-y divide-[var(--app-border)]">
                                {filtered.map((session) => {
                                    const checked = selectedIds.includes(session.id)
                                    return (
                                        <label key={session.id} className="flex cursor-pointer items-start gap-3 px-3 py-2 hover:bg-[var(--app-subtle-bg)]">
                                            <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--app-link)]" checked={checked} onChange={() => toggle(session.id)} />
                                            <span className="min-w-0 flex-1">
                                                <span className="flex items-center gap-2 text-sm font-medium text-[var(--app-fg)]">
                                                    <span className="truncate">{session.title}</span>
                                                    {session.hapiSessionId ? <span className="rounded bg-[var(--app-subtle-bg)] px-1.5 py-0.5 text-[10px] text-[var(--app-hint)]">{labels.imported}</span> : null}
                                                    {session.importState === 'diverged' || session.importState === 'failed' ? (
                                                        labels.needsAttention ? <span className="text-[10px] text-red-600">{labels.needsAttention}</span> : null
                                                    ) : null}
                                                </span>
                                                <span className="mt-0.5 block truncate text-xs text-[var(--app-hint)]">{session.lastUserMessage ?? session.cwd ?? session.id}</span>
                                                <span className="mt-0.5 block text-[10px] text-[var(--app-hint)]">
                                                    {new Date(session.modifiedAt).toLocaleString()}
                                                    {session.messageCount !== undefined && labels.messages ? ` · ${session.messageCount} ${labels.messages}` : ''}
                                                </span>
                                            </span>
                                        </label>
                                    )
                                })}
                            </div>
                        )}
                    </div>
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="secondary" onClick={props.onClose} disabled={props.isPending}>{labels.cancel}</Button>
                        <Button type="button" onClick={() => void props.onConfirm(selectedIds)} disabled={selectedIds.length === 0 || props.isPending || props.isLoading}>
                            {props.isPending ? labels.importing : labels.confirm}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    )
}
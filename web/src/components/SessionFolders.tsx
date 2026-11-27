import { useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import type { SessionFolder } from '@hapi/protocol/apiTypes'
import { apiErrorMessage } from '@/api/client'
import { ArrowLeftIcon, FolderIcon, PlusCircleIcon, TrashIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useTranslation } from '@/lib/use-translation'

type FolderNavigationProps = {
    folder: SessionFolder | undefined
    children: SessionFolder[]
    onOpen: (folderId: string | null) => void
    onCreate: () => void
    onDelete: (folder: SessionFolder) => void
}

const rowButton = 'flex min-h-9 min-w-0 items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]'

export function SessionFoldersNavigation({ folder, children, onOpen, onCreate, onDelete }: FolderNavigationProps) {
    const { t } = useTranslation()
    const focusAfterNavigation = useRef(false)
    const backButton = useRef<HTMLButtonElement>(null)
    const createButton = useRef<HTMLButtonElement>(null)
    useLayoutEffect(() => {
        if (!focusAfterNavigation.current) return
        focusAfterNavigation.current = false
        const target = backButton.current ?? createButton.current
        target?.focus()
    }, [folder?.id])

    const open = (folderId: string | null) => {
        focusAfterNavigation.current = true
        onOpen(folderId)
    }

    return (
        <nav className="flex flex-col gap-0.5" aria-label={t('sessions.folders.label')}>
            <div className="flex min-w-0 items-center gap-1">
                {folder ? (
                    <>
                        <button
                            type="button"
                            ref={backButton}
                            aria-label={t('sessions.folders.back')}
                            className={rowButton}
                            onClick={() => open(folder.parentId)}
                        >
                            <ArrowLeftIcon />
                        </button>
                        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={folder.name}>{folder.name}</span>
                    </>
                ) : null}
                <button type="button" ref={createButton} className={rowButton} onClick={onCreate}>
                    <PlusCircleIcon className="h-4 w-4 shrink-0 text-[var(--app-hint)]" />
                    <span>{t(folder ? 'sessions.folders.newSubfolder' : 'sessions.folders.new')}</span>
                </button>
                {folder ? (
                    <button
                        type="button"
                        className={rowButton}
                        aria-label={t('sessions.folders.delete')}
                        title={t('sessions.folders.delete')}
                        onClick={() => onDelete(folder)}
                    >
                        <TrashIcon />
                    </button>
                ) : null}
            </div>
            {children.map(child => (
                <button
                    key={child.id}
                    type="button"
                    className={rowButton}
                    title={child.name}
                    onClick={() => open(child.id)}
                >
                    <FolderIcon className="h-4 w-4 shrink-0 text-[var(--app-hint)]" />
                    <span className="min-w-0 truncate font-medium">{child.name}</span>
                </button>
            ))}
        </nav>
    )
}

type FolderDialogProps = {
    onClose: () => void
} & ({
    mode: 'create'
    isSubfolder: boolean
    onSubmit: (name: string) => Promise<void>
} | {
    mode: 'move'
    folderId: string | null
    folders: SessionFolder[]
    onSubmit: (folderId: string | null) => Promise<void>
})

function getFolderOptions(folders: SessionFolder[], noFolderLabel: string) {
    const kidsByParent = new Map<string | null, SessionFolder[]>()
    for (const folder of folders) {
        const kids = kidsByParent.get(folder.parentId) ?? []
        kids.push(folder)
        kidsByParent.set(folder.parentId, kids)
    }

    const options: { id: string; path: string }[] = []
    const append = (parentId: string | null, parentPath: string) => {
        for (const folder of kidsByParent.get(parentId) ?? []) {
            const name = folder.name === noFolderLabel || /[\/"]/.test(folder.name) ? JSON.stringify(folder.name) : folder.name
            const path = parentPath ? `${parentPath} / ${name}` : name
            options.push({ id: folder.id, path })
            append(folder.id, path)
        }
    }
    append(null, '')
    return options
}

export function SessionFolderDialog(props: FolderDialogProps) {
    const { t } = useTranslation()
    const id = useId()
    const [value, setValue] = useState(props.mode === 'move' ? props.folderId ?? '' : '')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const title = props.mode === 'move'
        ? t('sessions.folders.moveTo')
        : t(props.isSubfolder ? 'sessions.folders.newSubfolder' : 'sessions.folders.new')
    const invalid = props.mode === 'create' ? !value.trim() : value === (props.folderId ?? '')
    const inputClass = 'w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-base text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]'

    const submit = async (event: FormEvent) => {
        event.preventDefault()
        if (busy || invalid) return
        setBusy(true)
        setError(null)
        try {
            if (props.mode === 'create') await props.onSubmit(value.trim())
            else await props.onSubmit(value || null)
            props.onClose()
        } catch (err) {
            setError(apiErrorMessage(err, t('dialog.error.default')))
        } finally {
            setBusy(false)
        }
    }

    return (
        <Dialog open onOpenChange={open => { if (!open && !busy) props.onClose() }}>
            <DialogContent className="max-w-sm" aria-describedby={undefined}>
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                </DialogHeader>
                <form className="flex flex-col gap-3" onSubmit={submit}>
                    {props.mode === 'create' ? (
                        <>
                            <label htmlFor={id} className="sr-only">{t('sessions.folders.name')}</label>
                            <input
                                id={id}
                                className={inputClass}
                                placeholder={t('sessions.folders.name')}
                                value={value}
                                maxLength={100}
                                disabled={busy}
                                onChange={event => setValue(event.target.value)}
                            />
                        </>
                    ) : (
                        <>
                            <label htmlFor={id} className="sr-only">{t('sessions.folders.label')}</label>
                            <select
                                id={id}
                                className={inputClass}
                                value={value}
                                disabled={busy}
                                onChange={event => setValue(event.target.value)}
                            >
                                <option value="">{t('sessions.folders.none')}</option>
                                {getFolderOptions(props.folders, t('sessions.folders.none')).map(option => (
                                    <option key={option.id} value={option.id}>{option.path}</option>
                                ))}
                            </select>
                        </>
                    )}
                    {error ? <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="secondary" disabled={busy} onClick={props.onClose}>
                            {t('button.cancel')}
                        </Button>
                        <Button type="submit" disabled={busy || invalid}>
                            {t(props.mode === 'create' ? 'sessions.folders.create' : 'sessions.folders.move')}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    )
}

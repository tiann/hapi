import { useState, useEffect, useRef } from 'react'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/use-translation'

type RenameSessionDialogProps = {
    isOpen: boolean
    onClose: () => void
    currentName: string
    currentTitleLocked?: boolean
    sessionId?: string
    onRename: (newName: string | undefined, titleLocked?: boolean) => Promise<void>
    onSuggestTitle?: () => Promise<string>
    onUpdateSummary?: (text: string, titleLocked?: boolean) => Promise<void>
    isPending: boolean
}

export function RenameSessionDialog(props: RenameSessionDialogProps) {
    const { t } = useTranslation()
    const { isOpen, onClose, currentName, currentTitleLocked = false, sessionId, onRename, onSuggestTitle, onUpdateSummary, isPending } = props
    const [name, setName] = useState(currentName)
    const [titleLocked, setTitleLocked] = useState(currentTitleLocked)
    const [error, setError] = useState<string | null>(null)
    const [draftSource, setDraftSource] = useState<'manual' | 'generated'>('manual')
    const [draftEdited, setDraftEdited] = useState(false)
    const [isGenerating, setIsGenerating] = useState(false)
    const [isSaving, setIsSaving] = useState(false)
    const generationRef = useRef(0)
    const busy = isPending || isGenerating || isSaving
    const openedRef = useRef(false)
    const sessionRef = useRef(sessionId)

    const handleClose = () => {
        generationRef.current += 1
        setIsGenerating(false)
        onClose()
    }

    useEffect(() => {
        if (!isOpen) {
            generationRef.current += 1
            openedRef.current = false
            setIsGenerating(false)
            return
        }
        // Incoming agent/SSE changes must not reset an open user draft.
        if (!openedRef.current || sessionRef.current !== sessionId) {
            generationRef.current += 1
            openedRef.current = true
            sessionRef.current = sessionId
            setName(currentName)
            setTitleLocked(currentTitleLocked)
            setError(null)
            setDraftSource('manual')
            setDraftEdited(false)
            setIsGenerating(false)
        }
    }, [isOpen, currentName, currentTitleLocked, sessionId])

    const handleGenerate = async () => {
        if (!onSuggestTitle) return

        const generation = ++generationRef.current
        setError(null)
        setIsGenerating(true)
        try {
            const suggested = (await onSuggestTitle()).trim()
            if (generation !== generationRef.current) return
            if (!suggested) throw new Error('Empty title suggestion')
            setName(suggested)
            setDraftSource('generated')
        } catch {
            if (generation === generationRef.current) {
                setError(t('dialog.rename.generateError'))
            }
        } finally {
            if (generation === generationRef.current) {
                setIsGenerating(false)
            }
        }
    }

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        if (busy) return
        const trimmed = name.trim()
        const lockChanged = titleLocked !== currentTitleLocked
        const untouchedTitle = !draftEdited && draftSource === 'manual'
        if (!trimmed || (untouchedTitle && !lockChanged)) {
            handleClose()
            return
        }
        setError(null)
        setIsSaving(true)
        const saveGeneration = generationRef.current
        try {
            if (untouchedTitle && lockChanged) {
                // Preserve summary/name ownership when only the lock changes.
                await onRename(undefined, titleLocked)
            } else if (draftSource === 'generated' && onUpdateSummary) {
                await onUpdateSummary(trimmed, titleLocked)
            } else {
                await onRename(trimmed, titleLocked)
            }
            if (saveGeneration === generationRef.current) handleClose()
        } catch {
            if (saveGeneration === generationRef.current) setError(t('dialog.rename.error'))
        } finally {
            setIsSaving(false)
        }
    }

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            handleClose()
        }
    }

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
            <DialogContent className="max-w-sm">
                <DialogHeader className="pr-0">
                    <DialogTitle className="min-h-6 px-10 text-center leading-6">
                        {t('dialog.rename.title')}
                    </DialogTitle>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-4">
                    <div className="relative">
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => {
                                setName(e.target.value)
                                setDraftSource('manual')
                                setDraftEdited(true)
                            }}
                            onKeyDown={handleKeyDown}
                            placeholder={t('dialog.rename.placeholder')}
                            className="w-full pl-3 pr-12 py-2.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-2 focus:ring-[var(--app-button)] focus:border-transparent"
                            disabled={busy}
                            maxLength={255}
                        />
                        <button
                            type="button"
                            aria-label={t('dialog.rename.titleLock')}
                            aria-pressed={titleLocked}
                            title={t(titleLocked ? 'dialog.rename.unlockTitle' : 'dialog.rename.lockTitle')}
                            onClick={() => setTitleLocked(!titleLocked)}
                            disabled={busy}
                            className="absolute right-0 top-0 flex h-full w-11 items-center justify-center rounded-r-lg text-[var(--app-hint)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-button)] disabled:opacity-50"
                        >
                            <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <rect x="4" y="11" width="16" height="10" rx="2" />
                                {titleLocked ? <path d="M8 11V7a4 4 0 0 1 8 0v4" /> : <path d="M8 11V7a4 4 0 0 1 7.8-1" />}
                            </svg>
                        </button>
                    </div>

                    {error ? (
                        <div className="rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
                            {error}
                        </div>
                    ) : null}

                    <div className="flex items-center justify-between gap-2">
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={handleClose}
                            disabled={busy}
                        >
                            {t('button.cancel')}
                        </Button>
                        <div className="flex gap-2">
                            {onSuggestTitle ? (
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={() => void handleGenerate()}
                                    disabled={busy}
                                >
                                    {isGenerating ? t('dialog.rename.generating') : t('dialog.rename.generate')}
                                </Button>
                            ) : null}
                            <Button
                                type="submit"
                                disabled={busy || !name.trim()}
                            >
                                {isPending ? t('dialog.rename.saving') : t('button.save')}
                            </Button>
                        </div>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    )
}

import { useState, useEffect, useRef } from 'react'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ApiError } from '@/api/client'
import { useTranslation } from '@/lib/use-translation'

type RenameSessionDialogProps = {
    isOpen: boolean
    onClose: () => void
    currentName: string
    onRename: (newName: string) => Promise<void>
    onSuggestTitle?: () => Promise<string>
    onUpdateSummary?: (text: string, clearName?: boolean) => Promise<void>
    isPending: boolean
}

function extractTitleSuggestionErrorDetail(error: ApiError): string | null {
    if (!error.body) return null

    let parsed: unknown
    try {
        parsed = JSON.parse(error.body) as unknown
    } catch {
        return null
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const message = (parsed as { error?: unknown }).error
    if (typeof message !== 'string') return null

    const detail = message
        .replace(/\s+/g, ' ')
        .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
        .replace(/([?&](?:api[-_ ]?key|token|secret|password)=)[^&\s]+/gi, '$1[redacted]')
        .replace(/\b((?:api[-_ ]?key|token|secret|password)(?:\s+provided)?)\b\s*[:=]\s*["']?[^,\s}"']+/gi, '$1: [credential redacted]')
        .trim()

    if (!detail) return null
    return detail.length > 240 ? `${detail.slice(0, 239)}…` : detail
}

export function RenameSessionDialog(props: RenameSessionDialogProps) {
    const { t } = useTranslation()
    const { isOpen, onClose, currentName, onRename, onSuggestTitle, onUpdateSummary, isPending } = props
    const [name, setName] = useState(currentName)
    const [error, setError] = useState<string | null>(null)
    const [draftSource, setDraftSource] = useState<'manual' | 'generated'>('manual')
    const [draftEdited, setDraftEdited] = useState(false)
    const [isGenerating, setIsGenerating] = useState(false)
    const inputRef = useRef<HTMLInputElement>(null)
    const generationRef = useRef(0)
    const busy = isPending || isGenerating

    const handleClose = () => {
        generationRef.current += 1
        setIsGenerating(false)
        onClose()
    }

    useEffect(() => {
        generationRef.current += 1
        if (!isOpen) {
            setIsGenerating(false)
            return
        }

        if (isOpen) {
            setName(currentName)
            setError(null)
            setDraftSource('manual')
            setDraftEdited(false)
            setIsGenerating(false)
            setTimeout(() => {
                inputRef.current?.focus()
                inputRef.current?.select()
            }, 100)
        }
    }, [isOpen, currentName])

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
        } catch (error) {
            if (generation === generationRef.current) {
                if (error instanceof ApiError && error.code === 'unavailable') {
                    setError(t('dialog.rename.generateUnavailable'))
                } else {
                    const detail = error instanceof ApiError
                        ? extractTitleSuggestionErrorDetail(error)
                        : null
                    setError(detail
                        ? t('dialog.rename.generateErrorWithReason', { reason: detail })
                        : t('dialog.rename.generateError'))
                }
            }
        } finally {
            if (generation === generationRef.current) {
                setIsGenerating(false)
            }
        }
    }

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        const trimmed = name.trim()
        if (!trimmed || (!draftEdited && draftSource === 'manual' && trimmed === currentName)) {
            handleClose()
            return
        }
        setError(null)
        try {
            if (draftSource === 'generated' && onUpdateSummary) {
                await onUpdateSummary(trimmed, true)
            } else {
                await onRename(trimmed)
            }
            handleClose()
        } catch {
            setError(t('dialog.rename.error'))
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
                    <input
                        ref={inputRef}
                        type="text"
                        value={name}
                        onChange={(e) => {
                            setName(e.target.value)
                            setDraftSource('manual')
                            setDraftEdited(true)
                        }}
                        onKeyDown={handleKeyDown}
                        placeholder={t('dialog.rename.placeholder')}
                        className="w-full px-3 py-2.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-2 focus:ring-[var(--app-button)] focus:border-transparent"
                        disabled={busy}
                        maxLength={255}
                    />

                    {error ? (
                        <div className="rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
                            {error}
                        </div>
                    ) : null}

                    <div className="flex items-center gap-2">
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
                        <div className="ml-auto flex gap-2">
                            <Button
                                type="button"
                                variant="secondary"
                                onClick={handleClose}
                                disabled={busy}
                            >
                                {t('button.cancel')}
                            </Button>
                            <Button
                                type="submit"
                                disabled={busy || !name.trim()}
                            >
                                {isGenerating ? t('button.save') : isPending ? t('dialog.rename.saving') : t('button.save')}
                            </Button>
                        </div>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    )
}

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
import { useFue } from '@/lib/use-fue'
import { FueCallout, FueDot } from '@/components/Fue'

type RenameSessionDialogProps = {
    isOpen: boolean
    onClose: () => void
    currentName: string
    currentManualName?: string | null
    currentTitleLocked?: boolean
    sessionId?: string
    onRename: (newName: string | undefined, titleLocked?: boolean) => Promise<void>
    onSuggestTitle?: () => Promise<string>
    onUpdateSummary?: (text: string, titleLocked: boolean, expectedName: string | null, expectedTitleLocked: boolean) => Promise<void>
    isPending: boolean
}

type TitleSuggestionProviderReason =
    | 'request-rejected'
    | 'authentication-failed'
    | 'access-denied'
    | 'endpoint-or-model-not-found'
    | 'request-timed-out'
    | 'rate-limited'
    | 'provider-service-unavailable'
    | 'connection-failed'
    | 'empty-response'
    | 'invalid-response'

type TitleSuggestionErrorCode = 'unavailable' | 'empty' | 'rate-limited' | 'provider'
type TitleSuggestionDiagnostics = {
    httpStatus: number
    code?: TitleSuggestionErrorCode
    reason?: TitleSuggestionProviderReason
    providerStatus?: number
}

function isHttpStatus(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
}

function getTitleSuggestionDiagnostics(error: unknown): TitleSuggestionDiagnostics | null {
    if (!(error instanceof ApiError) || !isHttpStatus(error.status)) return null
    const diagnostics: TitleSuggestionDiagnostics = { httpStatus: error.status }
    if (!error.body) return diagnostics

    // ApiError.code can fall back to the free-form `error` field. Only an
    // explicit Hub code may select specialized guidance or diagnostics.
    try {
        const body: unknown = JSON.parse(error.body)
        if (!body || typeof body !== 'object' || Array.isArray(body)) return diagnostics
        const { code, reason, providerStatus } = body as Record<string, unknown>
        if (code === 'unavailable' || code === 'empty' || code === 'rate-limited' || code === 'provider') {
            diagnostics.code = code
        }
        if (code === 'provider' && typeof reason === 'string' && Object.hasOwn(titleSuggestionProviderReasonKeys, reason)) {
            diagnostics.reason = reason as TitleSuggestionProviderReason
            if (isHttpStatus(providerStatus)) diagnostics.providerStatus = providerStatus
        }
    } catch {
        // Unrecognized bodies have no additional diagnostics.
    }
    return diagnostics
}

const titleSuggestionProviderReasonKeys: Record<TitleSuggestionProviderReason, string> = {
    'request-rejected': 'dialog.rename.providerReason.requestRejected',
    'authentication-failed': 'dialog.rename.providerReason.authenticationFailed',
    'access-denied': 'dialog.rename.providerReason.accessDenied',
    'endpoint-or-model-not-found': 'dialog.rename.providerReason.endpointOrModelNotFound',
    'request-timed-out': 'dialog.rename.providerReason.requestTimedOut',
    'rate-limited': 'dialog.rename.providerReason.rateLimited',
    'provider-service-unavailable': 'dialog.rename.providerReason.serviceUnavailable',
    'connection-failed': 'dialog.rename.providerReason.connectionFailed',
    'empty-response': 'dialog.rename.providerReason.emptyResponse',
    'invalid-response': 'dialog.rename.providerReason.invalidResponse'
}

function formatTitleSuggestionErrorDetail(
    detail: { reason: TitleSuggestionProviderReason; providerStatus?: number },
    t: (key: string, params?: Record<string, string | number>) => string
): string {
    const reason = t(titleSuggestionProviderReasonKeys[detail.reason])
    if (detail.providerStatus !== undefined) {
        return t('dialog.rename.generateProviderErrorWithStatus', {
            status: detail.providerStatus,
            reason
        })
    }
    return t('dialog.rename.generateProviderError', { reason })
}

export function RenameSessionDialog(props: RenameSessionDialogProps) {
    const { t } = useTranslation()
    const { isOpen, onClose, currentName, currentManualName = null, currentTitleLocked = false, sessionId, onRename, onSuggestTitle, onUpdateSummary, isPending } = props
    const [name, setName] = useState(currentName)
    const [titleLocked, setTitleLocked] = useState(currentTitleLocked)
    const [error, setError] = useState<string | null>(null)
    const [draftSource, setDraftSource] = useState<'manual' | 'generated'>('manual')
    const [draftEdited, setDraftEdited] = useState(false)
    const [isGenerating, setIsGenerating] = useState(false)
    const [isSaving, setIsSaving] = useState(false)
    const [diagnostics, setDiagnostics] = useState<TitleSuggestionDiagnostics | null>(null)
    const [showDiagnostics, setShowDiagnostics] = useState(false)
    const inputRef = useRef<HTMLInputElement>(null)
    const generationRef = useRef(0)
    const busy = isPending || isGenerating || isSaving
    const openedRef = useRef(false)
    const sessionRef = useRef(sessionId)
    const openedTitle = useRef({ name: currentManualName, titleLocked: currentTitleLocked })
    const titleLockButtonRef = useRef<HTMLButtonElement>(null)
    const titleLockFue = useFue('session-title-lock')

    const handleClose = () => {
        generationRef.current += 1
        setIsGenerating(false)
        setShowDiagnostics(false)
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
            openedTitle.current = { name: currentManualName, titleLocked: currentTitleLocked }
            setName(currentName)
            setTitleLocked(currentTitleLocked)
            setError(null)
            setDiagnostics(null)
            setShowDiagnostics(false)
            setDraftSource('manual')
            setDraftEdited(false)
            setIsGenerating(false)
        }
    }, [isOpen, currentName, currentManualName, currentTitleLocked, sessionId])

    const handleGenerate = async () => {
        if (!onSuggestTitle) return

        const generation = ++generationRef.current
        setError(null)
        setDiagnostics(null)
        setShowDiagnostics(false)
        setIsGenerating(true)
        try {
            const suggested = (await onSuggestTitle()).trim()
            if (generation !== generationRef.current) return
            if (!suggested) throw new Error('Empty title suggestion')
            setName(suggested)
            setDraftSource('generated')
        } catch (error) {
            if (generation === generationRef.current) {
                const detail = getTitleSuggestionDiagnostics(error)
                setDiagnostics(detail)
                if (detail?.code === 'empty') {
                    setError(t('dialog.rename.generateEmpty'))
                } else if (detail?.code === 'unavailable') {
                    setError(t('dialog.rename.generateUnavailable'))
                } else {
                    setError(detail?.reason
                        ? t('dialog.rename.generateErrorWithReason', {
                            reason: formatTitleSuggestionErrorDetail({ reason: detail.reason, providerStatus: detail.providerStatus }, t)
                        })
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
        if (busy) return
        const trimmed = name.trim()
        const lockChanged = titleLocked !== currentTitleLocked
        const untouchedTitle = !draftEdited && draftSource === 'manual'
        if (!trimmed || (untouchedTitle && !lockChanged)) {
            handleClose()
            return
        }
        setError(null)
        setDiagnostics(null)
        setShowDiagnostics(false)
        setIsSaving(true)
        const saveGeneration = generationRef.current
        try {
            if (untouchedTitle && lockChanged) {
                // Preserve summary/name ownership when only the lock changes.
                await onRename(undefined, titleLocked)
            } else if (draftSource === 'generated' && onUpdateSummary) {
                await onUpdateSummary(trimmed, titleLocked, openedTitle.current.name, openedTitle.current.titleLocked)
            } else {
                await onRename(trimmed, titleLocked)
            }
            if (saveGeneration === generationRef.current) handleClose()
        } catch (error) {
            if (saveGeneration === generationRef.current) {
                setError(t(error instanceof ApiError && error.status === 409 && draftSource === 'generated'
                    ? 'dialog.rename.concurrentTitle'
                    : 'dialog.rename.error'))
            }
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
                            ref={titleLockButtonRef}
                            type="button"
                            aria-label={t('dialog.rename.titleLock')}
                            aria-pressed={titleLocked}
                            title={t(titleLocked ? 'dialog.rename.unlockTitle' : 'dialog.rename.lockTitle')}
                            onClick={() => {
                                titleLockFue.engage()
                                setTitleLocked(!titleLocked)
                            }}
                            disabled={busy}
                            className="absolute right-0 top-0 flex h-full w-11 items-center justify-center rounded-r-lg text-[var(--app-hint)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-button)] disabled:opacity-50"
                        >
                            <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <rect x="4" y="11" width="16" height="10" rx="2" />
                                {titleLocked ? <path d="M8 11V7a4 4 0 0 1 8 0v4" /> : <path d="M8 11V7a4 4 0 0 1 7.8-1" />}
                            </svg>
                            {titleLockFue.status !== 'acknowledged' ? (
                                <FueDot
                                    pulsing={titleLockFue.status === 'unseen'}
                                    ariaLabel={t('fue.newFeatureDot')}
                                />
                            ) : null}
                        </button>
                        {titleLockFue.status === 'engaging' ? (
                            <FueCallout
                                title={t('dialog.rename.titleLock.fueTitle')}
                                body={t('dialog.rename.titleLock.fueBody')}
                                onDismiss={titleLockFue.dismiss}
                                dismissLabel={t('fue.gotIt')}
                                closeAriaLabel={t('fue.closeAriaLabel')}
                                anchorRef={titleLockButtonRef}
                            />
                        ) : null}
                    </div>

                    {error ? (
                        <div className="rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
                            <div className="leading-5">
                                <span>{error}</span>
                                {diagnostics ? (
                                    <>
                                        {' '}
                                        <button
                                            type="button"
                                            aria-controls="title-suggestion-diagnostics"
                                            aria-expanded={showDiagnostics}
                                            className="inline-flex whitespace-nowrap align-baseline underline underline-offset-2"
                                            onClick={() => setShowDiagnostics((visible) => !visible)}
                                        >
                                            {showDiagnostics
                                                ? t('dialog.rename.hideDiagnostics')
                                                : t('dialog.rename.showDiagnostics')}
                                        </button>
                                    </>
                                ) : null}
                                {showDiagnostics && diagnostics ? (
                                    <pre
                                        id="title-suggestion-diagnostics"
                                        data-testid="title-suggestion-diagnostics"
                                        className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-black/10 p-2 font-mono text-xs"
                                    >
                                        {[
                                            `HTTP ${diagnostics.httpStatus}`,
                                            diagnostics.code && t('dialog.rename.diagnosticCode', { code: diagnostics.code }),
                                            diagnostics.providerStatus !== undefined && t('dialog.rename.diagnosticProviderStatus', { status: diagnostics.providerStatus }),
                                            diagnostics.reason && t('dialog.rename.diagnosticReason', { reason: diagnostics.reason })
                                        ].filter(Boolean).join('\n')}
                                    </pre>
                                ) : null}
                            </div>
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
                                {isSaving ? t('dialog.rename.saving') : t('button.save')}
                            </Button>
                        </div>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    )
}

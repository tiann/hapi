import { useEffect, useRef, useState } from 'react'
import { BLOCKED_ACK_REASON_MAX_CHARS } from '@hapi/protocol'
import { useTranslation } from '@/lib/use-translation'
import { cn } from '@/lib/utils'

/**
 * Presets for the common dismissals (#1717).
 *
 * The reason is mandatory, and mandatory free-text at fleet scale would either
 * get skipped or get filled with "x". One tap writes a real, machine-comparable
 * rationale into the ledger; the free-text box stays for the cases that
 * deserve one.
 */
const PRESET_KEYS = [
    'sessions.unblock.preset.handled',
    'sessions.unblock.preset.notBlocked',
    'sessions.unblock.preset.abandoned',
    'sessions.unblock.preset.superseded',
] as const

export function UnblockReasonDialog(props: {
    isOpen: boolean
    sessionTitle: string
    blockedLabel: string | null
    blockedNote: string | null
    isPending?: boolean
    onClose: () => void
    onConfirm: (reason: string) => Promise<unknown>
}) {
    const { t } = useTranslation()
    const [reason, setReason] = useState('')
    const [error, setError] = useState<string | null>(null)
    const inputRef = useRef<HTMLTextAreaElement>(null)

    useEffect(() => {
        if (props.isOpen) {
            setReason('')
            setError(null)
        }
    }, [props.isOpen])

    if (!props.isOpen) return null

    const trimmed = reason.trim()

    const submit = async () => {
        if (trimmed.length === 0) {
            setError(t('sessions.unblock.reasonRequired'))
            inputRef.current?.focus()
            return
        }
        try {
            await props.onConfirm(trimmed.slice(0, BLOCKED_ACK_REASON_MAX_CHARS))
            props.onClose()
        } catch (err) {
            setError(err instanceof Error ? err.message : t('dialog.error.default'))
        }
    }

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            role="presentation"
            onClick={props.onClose}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-label={t('sessions.unblock.title')}
                data-testid="unblock-reason-dialog"
                className="w-full max-w-md rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-4 shadow-lg"
                onClick={(event) => event.stopPropagation()}
            >
                <div className="text-sm font-semibold text-[var(--app-fg)]">
                    {t('sessions.unblock.title')}
                </div>
                <div className="mt-1 truncate text-xs text-[var(--app-hint)]" title={props.sessionTitle}>
                    {props.sessionTitle}
                </div>

                {props.blockedLabel ? (
                    <div className="mt-2 rounded-lg border border-[var(--app-badge-warning-border)] bg-[var(--app-badge-warning-bg)] px-2 py-1.5 text-xs text-[var(--app-badge-warning-text)]">
                        <span className="font-semibold uppercase tracking-wide">{props.blockedLabel}</span>
                        {props.blockedNote ? <span className="ml-1.5 opacity-90">{props.blockedNote}</span> : null}
                    </div>
                ) : null}

                <p className="mt-3 text-xs text-[var(--app-hint)]">
                    {t('sessions.unblock.description')}
                </p>

                <div className="mt-2 flex flex-wrap gap-1.5">
                    {PRESET_KEYS.map((key) => {
                        const label = t(key)
                        const selected = trimmed === label
                        return (
                            <button
                                key={key}
                                type="button"
                                onClick={() => { setReason(label); setError(null) }}
                                className={cn(
                                    'rounded-full border px-2.5 py-1 text-xs transition-colors',
                                    selected
                                        ? 'border-[var(--app-link)] bg-[var(--app-subtle-bg)] text-[var(--app-fg)]'
                                        : 'border-[var(--app-border)] text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]'
                                )}
                            >
                                {label}
                            </button>
                        )
                    })}
                </div>

                <textarea
                    ref={inputRef}
                    value={reason}
                    onChange={(event) => { setReason(event.target.value); setError(null) }}
                    onKeyDown={(event) => {
                        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                            event.preventDefault()
                            void submit()
                        }
                    }}
                    rows={3}
                    maxLength={BLOCKED_ACK_REASON_MAX_CHARS}
                    autoFocus
                    placeholder={t('sessions.unblock.placeholder')}
                    aria-label={t('sessions.unblock.reasonLabel')}
                    className="mt-2 w-full resize-none rounded-lg border border-[var(--app-border)] bg-[var(--app-input-bg,transparent)] p-2 text-sm text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)]"
                />

                {error ? (
                    <div role="alert" className="mt-1 text-xs text-[var(--app-badge-error-text)]">{error}</div>
                ) : null}

                <div className="mt-3 flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={props.onClose}
                        className="rounded-lg px-3 py-1.5 text-sm text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]"
                    >
                        {t('button.cancel')}
                    </button>
                    <button
                        type="button"
                        onClick={() => void submit()}
                        disabled={props.isPending}
                        data-testid="unblock-confirm"
                        className="rounded-lg bg-[var(--app-link)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
                    >
                        {t('sessions.unblock.confirm')}
                    </button>
                </div>
            </div>
        </div>
    )
}

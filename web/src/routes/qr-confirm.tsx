import { useCallback, useState } from 'react'
import { useParams, useSearch } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { Spinner } from '@/components/Spinner'

export default function QrConfirmPage() {
    const { t } = useTranslation()
    const { api, token, baseUrl } = useAppContext()
    const { qrId } = useParams({ from: '/qr/$qrId' })
    const search = useSearch({ from: '/qr/$qrId' })
    const secret = (search as { s?: string }).s

    const [status, setStatus] = useState<'idle' | 'confirming' | 'confirmed' | 'error'>('idle')
    const [error, setError] = useState<string | null>(null)

    const handleConfirm = useCallback(async () => {
        setStatus('confirming')
        setError(null)

        try {
            const res = await fetch(
                new URL(`/api/qr/${qrId}/confirm`, baseUrl).toString(),
                {
                    method: 'POST',
                    headers: {
                        'authorization': `Bearer ${token}`,
                        'content-type': 'application/json',
                    },
                }
            )

            if (!res.ok) {
                const body = await res.json().catch(() => ({ error: 'Unknown error' })) as { error?: string }
                setError(body.error ?? t('qr.confirm.error'))
                setStatus('error')
                return
            }

            setStatus('confirmed')
        } catch {
            setError(t('qr.confirm.error'))
            setStatus('error')
        }
    }, [api, token, qrId, t])

    return (
        <div className="h-full flex items-center justify-center p-4">
            <div className="w-full max-w-sm space-y-6 text-center">
                {status === 'confirmed' ? (
                    <div className="space-y-3">
                        <div className="text-4xl">&#x2713;</div>
                        <div className="text-lg font-semibold">{t('qr.confirm.success')}</div>
                        <div className="text-sm text-[var(--app-hint)]">
                            {t('qr.confirm.successHint')}
                        </div>
                    </div>
                ) : (
                    <>
                        <div className="space-y-2">
                            <div className="text-lg font-semibold">{t('qr.confirm.title')}</div>
                            <div className="text-sm text-[var(--app-hint)]">
                                {t('qr.confirm.description')}
                            </div>
                        </div>

                        {!secret && (
                            <div className="text-sm text-red-500">
                                {t('qr.confirm.invalidLink')}
                            </div>
                        )}

                        {error && (
                            <div className="text-sm text-red-500">{error}</div>
                        )}

                        <div className="flex gap-3">
                            <button
                                type="button"
                                onClick={() => window.close()}
                                className="flex-1 py-2.5 rounded-lg border border-[var(--app-border)] text-sm font-medium hover:bg-[var(--app-subtle-bg)] transition-colors"
                            >
                                {t('qr.confirm.deny')}
                            </button>
                            <button
                                type="button"
                                onClick={handleConfirm}
                                disabled={status === 'confirming' || !secret}
                                className="flex-1 py-2.5 rounded-lg bg-[var(--app-button)] text-[var(--app-button-text)] text-sm font-medium disabled:opacity-50 hover:opacity-90 transition-opacity inline-flex items-center justify-center gap-2"
                            >
                                {status === 'confirming' ? (
                                    <>
                                        <Spinner size="sm" label={null} className="text-[var(--app-button-text)]" />
                                        {t('qr.confirm.confirming')}
                                    </>
                                ) : (
                                    t('qr.confirm.allow')
                                )}
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>
    )
}

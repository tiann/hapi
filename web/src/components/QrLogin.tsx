import { useCallback, useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { Spinner } from '@/components/Spinner'
import { useTranslation } from '@/lib/use-translation'

type QrLoginProps = {
    baseUrl: string
    onLogin: (token: string) => void
    onCancel: () => void
}

type QrSession = {
    id: string
    secret: string
}

type PollResult =
    | { status: 'pending' }
    | { status: 'expired' }
    | { status: 'confirmed'; accessToken: string }

const POLL_INTERVAL = 2000
const QR_TTL_SECONDS = 300 // 5 minutes

export function QrLogin({ baseUrl, onLogin, onCancel }: QrLoginProps) {
    const { t } = useTranslation()
    const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
    const [session, setSession] = useState<QrSession | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [remainingSeconds, setRemainingSeconds] = useState(QR_TTL_SECONDS)
    const abortRef = useRef<AbortController | null>(null)
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
    const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)

    const buildApiUrl = useCallback((path: string) => {
        try {
            return new URL(path, baseUrl).toString()
        } catch {
            return path
        }
    }, [baseUrl])

    const createSession = useCallback(async () => {
        setError(null)
        setQrDataUrl(null)
        setSession(null)
        setRemainingSeconds(QR_TTL_SECONDS)

        try {
            const res = await fetch(buildApiUrl('/api/qr'), { method: 'POST' })
            if (!res.ok) {
                setError(t('qr.error.createFailed'))
                return
            }
            const data = await res.json() as QrSession

            // Build the QR URL: use web app origin (not hub baseUrl) since /qr/:id is a frontend route
            const qrUrl = new URL(`/qr/${data.id}`, window.location.origin)
            qrUrl.searchParams.set('s', data.secret)

            const dataUrl = await QRCode.toDataURL(qrUrl.toString(), {
                width: 256,
                margin: 2,
                color: { dark: '#000000', light: '#ffffff' },
            })

            setSession(data)
            setQrDataUrl(dataUrl)
        } catch {
            setError(t('qr.error.createFailed'))
        }
    }, [baseUrl, buildApiUrl, t])

    // Create session on mount
    useEffect(() => {
        void createSession()
    }, [createSession])

    // Poll for confirmation
    useEffect(() => {
        if (!session) return

        const abort = new AbortController()
        abortRef.current = abort

        const poll = async () => {
            try {
                const res = await fetch(
                    buildApiUrl(`/api/qr/${session.id}?s=${session.secret}`),
                    { signal: abort.signal }
                )
                if (!res.ok) return

                const data = await res.json() as PollResult

                if (data.status === 'confirmed') {
                    onLogin(data.accessToken)
                } else if (data.status === 'expired') {
                    setError(t('qr.error.expired'))
                    setQrDataUrl(null)
                    if (pollRef.current) clearInterval(pollRef.current)
                }
            } catch (e) {
                if (e instanceof DOMException && e.name === 'AbortError') return
            }
        }

        pollRef.current = setInterval(poll, POLL_INTERVAL)

        return () => {
            abort.abort()
            if (pollRef.current) clearInterval(pollRef.current)
        }
    }, [session, buildApiUrl, onLogin, t])

    // Countdown timer
    useEffect(() => {
        if (!session) return

        countdownRef.current = setInterval(() => {
            setRemainingSeconds((prev) => {
                if (prev <= 1) {
                    if (countdownRef.current) clearInterval(countdownRef.current)
                    setError(t('qr.error.expired'))
                    setQrDataUrl(null)
                    return 0
                }
                return prev - 1
            })
        }, 1000)

        return () => {
            if (countdownRef.current) clearInterval(countdownRef.current)
        }
    }, [session, t])

    const minutes = Math.floor(remainingSeconds / 60)
    const seconds = remainingSeconds % 60

    return (
        <div className="space-y-4">
            <div className="flex flex-col items-center gap-3">
                {qrDataUrl ? (
                    <>
                        <div className="rounded-lg overflow-hidden border border-[var(--app-border)]">
                            <img src={qrDataUrl} alt="QR Code" width={256} height={256} />
                        </div>
                        <div className="text-sm text-[var(--app-hint)] text-center">
                            {t('qr.scanPrompt')}
                        </div>
                        <div className="text-xs text-[var(--app-hint)]">
                            {t('qr.expiresIn', { m: minutes, s: String(seconds).padStart(2, '0') })}
                        </div>
                        <div className="flex items-center gap-1.5 text-xs text-[var(--app-hint)]">
                            <Spinner size="sm" label={null} />
                            {t('qr.waiting')}
                        </div>
                    </>
                ) : error ? (
                    <div className="text-center space-y-3">
                        <div className="text-sm text-red-500">{error}</div>
                        <button
                            type="button"
                            onClick={() => void createSession()}
                            className="text-sm text-[var(--app-link)] underline hover:opacity-80"
                        >
                            {t('qr.retry')}
                        </button>
                    </div>
                ) : (
                    <Spinner size="md" label={t('loading')} />
                )}
            </div>

            <button
                type="button"
                onClick={onCancel}
                className="w-full py-2 rounded-lg border border-[var(--app-border)] text-sm text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors"
            >
                {t('qr.backToToken')}
            </button>
        </div>
    )
}

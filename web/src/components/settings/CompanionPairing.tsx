import { useEffect, useMemo, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { Button } from '@/components/ui/button'

type CompanionPairingProps = {
    baseUrl: string
    accessToken: string
}

const COMPANION_DEEPLINK_SCHEME = 'hapicompanion://bind'

function buildDeeplink(hub: string, code: string): string {
    const params = new URLSearchParams({ hub, code })
    return `${COMPANION_DEEPLINK_SCHEME}?${params.toString()}`
}

export function CompanionPairing({ baseUrl, accessToken }: CompanionPairingProps) {
    const [revealed, setRevealed] = useState(false)
    const [copied, setCopied] = useState(false)
    const canvasRef = useRef<HTMLCanvasElement | null>(null)

    const deeplink = useMemo(() => {
        const hub = (baseUrl || '').trim()
        const code = (accessToken || '').trim()
        if (!hub || !code) return ''
        return buildDeeplink(hub, code)
    }, [baseUrl, accessToken])

    useEffect(() => {
        if (!revealed || !deeplink || !canvasRef.current) return
        let cancelled = false
        QRCode.toCanvas(canvasRef.current, deeplink, {
            errorCorrectionLevel: 'M',
            margin: 2,
            scale: 6,
            color: {
                dark: '#000000',
                light: '#ffffff'
            }
        }).catch(() => {
            // QR rendering failures are non-fatal; the textual link below still works.
        })
        return () => {
            cancelled = true
            void cancelled
        }
    }, [deeplink, revealed])

    const handleCopy = async () => {
        if (!deeplink) return
        try {
            await navigator.clipboard.writeText(deeplink)
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
        } catch {
            // Clipboard may be unavailable (e.g. insecure context); user can long-press the link instead.
        }
    }

    if (!deeplink) {
        return (
            <p className="text-sm text-[var(--app-hint)]">
                Pairing requires an active session. Sign in first, then return here.
            </p>
        )
    }

    return (
        <div className="flex flex-col gap-3">
            <p className="text-sm text-[var(--app-hint)]">
                Scan from the HAPI companion app on Android (phone or Wear OS) to bind it to this hub.
                The pairing code is your access token - treat it like a password.
            </p>

            {!revealed ? (
                <Button
                    type="button"
                    variant="outline"
                    onClick={() => setRevealed(true)}
                    className="self-start"
                >
                    Show pairing QR
                </Button>
            ) : (
                <div className="flex flex-col items-center gap-3">
                    <canvas
                        ref={canvasRef}
                        className="rounded bg-white p-2"
                        aria-label="Companion pairing QR code"
                    />
                    <div className="flex flex-wrap gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            onClick={handleCopy}
                        >
                            {copied ? 'Copied!' : 'Copy link'}
                        </Button>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => setRevealed(false)}
                        >
                            Hide
                        </Button>
                    </div>
                    <p className="text-xs text-[var(--app-hint)] break-all text-center">
                        {deeplink}
                    </p>
                </div>
            )}
        </div>
    )
}

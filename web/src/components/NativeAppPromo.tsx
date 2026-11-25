import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { useNavigate } from '@tanstack/react-router'
import { CloseIcon } from '@/components/icons'
import { isTelegramApp } from '@/hooks/useTelegram'
import { useTranslation } from '@/lib/use-translation'
import {
    APP_STORE_URL,
    GOOGLE_PLAY_URL,
    NATIVE_APPS_PAGE_URL,
    detectStorePlatform,
    markPromoFirstSeen,
    useNativeAppPromo,
    type StorePlatform,
} from '@/lib/nativeAppPromo'

/** Mirrors the Tailwind `split` breakpoint: below it the app is in phone layout. */
const PHONE_LAYOUT_QUERY = '(max-width: 919px)'
/** Let the page settle before an interrupting sheet slides in. */
const MODAL_DELAY_MS = 2500

function usePhoneLayout(): boolean {
    const [matches, setMatches] = useState(() => (
        typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia(PHONE_LAYOUT_QUERY).matches
    ))
    useEffect(() => {
        if (typeof window.matchMedia !== 'function') return
        const mql = window.matchMedia(PHONE_LAYOUT_QUERY)
        const update = () => setMatches(mql.matches)
        update()
        mql.addEventListener('change', update)
        return () => mql.removeEventListener('change', update)
    }, [])
    return matches
}

function currentStorePlatform(): StorePlatform {
    return detectStorePlatform(typeof navigator === 'undefined' ? undefined : navigator)
}

function PhoneIcon(props: { className?: string }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className} aria-hidden="true">
            <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
            <path d="M12 18h.01" />
        </svg>
    )
}

function HeartIcon(props: { className?: string }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={props.className} aria-hidden="true">
            <path d="M12 21s-7.5-4.6-10-9.2C.4 8.6 2.3 4.5 6.1 4.5c2.1 0 3.4 1.1 4.2 2.3h3.4c.8-1.2 2.1-2.3 4.2-2.3 3.8 0 5.7 4.1 4.1 7.3C19.5 16.4 12 21 12 21z" />
        </svg>
    )
}

const storeButtonClass = 'flex flex-1 items-center justify-center rounded-lg bg-[var(--app-button)] px-3 py-2.5 text-sm font-medium text-[var(--app-button-text)] transition-opacity hover:opacity-90 active:opacity-80'
const secondaryStoreButtonClass = 'flex flex-1 items-center justify-center rounded-lg border border-[var(--app-border)] px-3 py-2.5 text-sm font-medium text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)]'

/** Store buttons ordered for the visitor's platform; the matching store is primary. */
function StoreButtons(props: { platform: StorePlatform; onOpen?: () => void }) {
    const { t } = useTranslation()
    const appStore = { href: APP_STORE_URL, label: t('nativeAppPromo.appStore') }
    const googlePlay = { href: GOOGLE_PLAY_URL, label: t('nativeAppPromo.googlePlay') }
    const links = props.platform === 'ios'
        ? [appStore]
        : props.platform === 'android'
            ? [googlePlay]
            : [appStore, googlePlay]
    return (
        <div className="flex gap-2">
            {links.map((link, index) => (
                <a
                    key={link.href}
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={props.onOpen}
                    className={index === 0 ? storeButtonClass : secondaryStoreButtonClass}
                >
                    {link.label}
                </a>
            ))}
        </div>
    )
}

function PromoCopy(props: { platform: StorePlatform }) {
    const { t } = useTranslation()
    return (
        <div className="space-y-2">
            <p className="text-sm text-[var(--app-fg)]">{t('nativeAppPromo.body')}</p>
            <ul className="space-y-1 text-xs text-[var(--app-hint)]">
                <li>• {t('nativeAppPromo.benefit.push')}</li>
                <li>• {props.platform === 'mac' ? t('nativeAppPromo.benefit.mac') : t('nativeAppPromo.benefit.native')}</li>
                <li>• {t('nativeAppPromo.benefit.support')}</li>
            </ul>
        </div>
    )
}

function QrCode(props: { value: string; label: string }) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null)
    useEffect(() => {
        if (!canvasRef.current) return
        QRCode.toCanvas(canvasRef.current, props.value, {
            errorCorrectionLevel: 'M',
            margin: 1,
            scale: 3,
            color: { dark: '#000000', light: '#ffffff' },
        }).catch(() => {
            // Non-fatal: the store buttons below still work.
        })
    }, [props.value])
    return <canvas ref={canvasRef} role="img" aria-label={props.label} className="h-24 w-24 rounded-md" />
}

/**
 * Desktop entry point: a compact pill in the top-right header area. Clicking
 * opens a popover (QR for the phone + store links); closing the pill or
 * choosing "Don't show again" dismisses it for the current release line.
 */
export function NativeAppPromoButton(props: { className?: string }) {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { showEntry, dismiss } = useNativeAppPromo()
    const [open, setOpen] = useState(false)
    const rootRef = useRef<HTMLDivElement | null>(null)
    const platform = currentStorePlatform()

    useEffect(() => {
        if (!open) return
        const onPointerDown = (event: PointerEvent) => {
            if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
        }
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
            document.removeEventListener('pointerdown', onPointerDown)
            document.removeEventListener('keydown', onKeyDown)
        }
    }, [open])

    if (!showEntry || isTelegramApp()) return null

    return (
        <div ref={rootRef} className={`relative shrink-0 ${props.className ?? ''}`} data-testid="native-app-promo-button">
            <div className="group flex h-8 items-center rounded-full border border-[var(--app-border)] text-[var(--app-hint)] transition-colors hover:text-[var(--app-fg)]">
                <button
                    type="button"
                    onClick={() => setOpen((value) => !value)}
                    aria-haspopup="dialog"
                    aria-expanded={open}
                    className="flex h-full items-center gap-1.5 rounded-l-full pl-2.5 pr-1 text-xs font-medium"
                    title={t('nativeAppPromo.title')}
                >
                    <PhoneIcon className="h-4 w-4" />
                    <span className="hidden xl:inline">{t('nativeAppPromo.pill')}</span>
                </button>
                <button
                    type="button"
                    onClick={dismiss}
                    aria-label={t('nativeAppPromo.dismiss')}
                    title={t('nativeAppPromo.dismiss')}
                    className="flex h-full items-center rounded-r-full pl-0.5 pr-2 opacity-60 hover:opacity-100"
                >
                    <CloseIcon className="h-3 w-3" />
                </button>
            </div>

            {open ? (
                <div
                    role="dialog"
                    aria-label={t('nativeAppPromo.title')}
                    className="absolute right-0 top-10 z-50 w-80 space-y-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-dialog-bg)] p-4 shadow-2xl"
                >
                    <div className="flex items-center gap-2 text-sm font-semibold text-[var(--app-fg)]">
                        <HeartIcon className="h-4 w-4 text-[#FF3B30]" />
                        {t('nativeAppPromo.title')}
                    </div>
                    <PromoCopy platform={platform} />
                    <div className="flex items-center gap-3 rounded-lg bg-[var(--app-subtle-bg)] p-2">
                        <QrCode value={NATIVE_APPS_PAGE_URL} label={t('nativeAppPromo.qrLabel')} />
                        <p className="text-xs text-[var(--app-hint)]">{t('nativeAppPromo.qrHint')}</p>
                    </div>
                    <StoreButtons platform={platform} />
                    <div className="flex items-center justify-between text-xs">
                        <button
                            type="button"
                            className="text-[var(--app-link)] hover:underline"
                            onClick={() => {
                                setOpen(false)
                                navigate({ to: '/settings/general' })
                            }}
                        >
                            {t('nativeAppPromo.alreadyInstalled')}
                        </button>
                        <button
                            type="button"
                            className="text-[var(--app-hint)] hover:text-[var(--app-fg)]"
                            onClick={() => {
                                setOpen(false)
                                dismiss()
                            }}
                        >
                            {t('nativeAppPromo.dontShowAgain')}
                        </button>
                    </div>
                </div>
            ) : null}
        </div>
    )
}

/**
 * Phone entry point: a one-time bottom sheet. Shown only in phone layout,
 * outside Telegram, never on the first visit, and only after the page settles.
 * Any close action dismisses it for the current release line.
 */
export function NativeAppPromoSheet(props: { enabled: boolean }) {
    const { t } = useTranslation()
    const isPhone = usePhoneLayout()
    const { showModal, dismiss } = useNativeAppPromo()
    const [ready, setReady] = useState(false)
    const platform = currentStorePlatform()
    const eligible = props.enabled && isPhone && !isTelegramApp()

    useEffect(() => {
        markPromoFirstSeen()
    }, [])

    useEffect(() => {
        if (!eligible || !showModal) {
            setReady(false)
            return
        }
        const timer = window.setTimeout(() => setReady(true), MODAL_DELAY_MS)
        return () => window.clearTimeout(timer)
    }, [eligible, showModal])

    if (!eligible || !showModal || !ready) return null

    return (
        <div
            className="fixed inset-0 z-50 flex items-end justify-center bg-black/50"
            onClick={(event) => {
                if (event.target === event.currentTarget) dismiss()
            }}
            data-testid="native-app-promo-sheet"
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="native-app-promo-title"
                className="w-full max-w-lg space-y-4 rounded-t-2xl bg-[var(--app-bg)] p-5 pb-[calc(env(safe-area-inset-bottom)+1.25rem)] animate-slide-up"
            >
                <div className="flex items-start justify-between gap-3">
                    <h3 id="native-app-promo-title" className="flex items-center gap-2 text-base font-semibold text-[var(--app-fg)]">
                        <HeartIcon className="h-5 w-5 text-[#FF3B30]" />
                        {t('nativeAppPromo.title')}
                    </h3>
                    <button
                        type="button"
                        onClick={dismiss}
                        className="-mr-1 p-1 text-[var(--app-hint)] active:opacity-60"
                        aria-label={t('button.close')}
                    >
                        <CloseIcon className="h-5 w-5" />
                    </button>
                </div>
                <PromoCopy platform={platform} />
                {/* Going to the store counts as engagement: don't ask again this release line. */}
                <StoreButtons platform={platform} onOpen={dismiss} />
                <button
                    type="button"
                    onClick={dismiss}
                    className="w-full py-2 text-sm text-[var(--app-hint)] active:opacity-60"
                >
                    {t('nativeAppPromo.continueWeb')}
                </button>
            </div>
        </div>
    )
}

/** Permanent, never-dismissed entry for Settings → About. */
export function NativeAppStoreLinks() {
    return <StoreButtons platform="other" />
}

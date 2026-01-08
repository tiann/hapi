import { useState } from 'react'
import { usePWAInstall } from '@/hooks/usePWAInstall'
import { usePlatform } from '@/hooks/usePlatform'
import { CloseIcon, ShareIcon, PlusCircleIcon } from '@/components/icons'
import { useTranslation } from '@/lib/use-translation'

export function InstallPrompt() {
    const { t } = useTranslation()
    const { canInstall, canInstallIOS, promptInstall, dismissInstall, isStandalone } = usePWAInstall()
    const { isTelegram, haptic } = usePlatform()
    const [showIOSGuide, setShowIOSGuide] = useState(false)

    if (isTelegram || isStandalone) {
        return null
    }

    // iOS Safari install guide
    if (canInstallIOS) {
        if (showIOSGuide) {
            return (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-end justify-center">
                    <div className="w-full max-w-lg bg-[var(--app-bg)] rounded-t-2xl p-5 pb-8 space-y-4 animate-slide-up">
                        <div className="flex items-center justify-between">
                            <h3 className="text-base font-semibold text-[var(--app-fg)]">
                                {t('install.title')}
                            </h3>
                            <button
                                onClick={() => setShowIOSGuide(false)}
                                className="p-1 -mr-1 text-[var(--app-hint)] active:opacity-60"
                                aria-label="Close"
                            >
                                <CloseIcon className="w-5 h-5" />
                            </button>
                        </div>

                        <div className="space-y-3">
                            <div className="flex items-start gap-3">
                                <div className="shrink-0 w-8 h-8 rounded-full bg-[var(--app-fg)] text-[var(--app-bg)] flex items-center justify-center text-sm font-medium">
                                    1
                                </div>
                                <div className="flex-1 pt-1">
                                    <p className="text-sm text-[var(--app-fg)]">
                                        Tap the <ShareIcon className="inline w-5 h-5 align-text-bottom" /> Share button in the toolbar
                                    </p>
                                </div>
                            </div>

                            <div className="flex items-start gap-3">
                                <div className="shrink-0 w-8 h-8 rounded-full bg-[var(--app-fg)] text-[var(--app-bg)] flex items-center justify-center text-sm font-medium">
                                    2
                                </div>
                                <div className="flex-1 pt-1">
                                    <p className="text-sm text-[var(--app-fg)]">
                                        Scroll down and tap <PlusCircleIcon className="inline w-5 h-5 align-text-bottom" /> <strong>Add to Home Screen</strong>
                                    </p>
                                </div>
                            </div>

                            <div className="flex items-start gap-3">
                                <div className="shrink-0 w-8 h-8 rounded-full bg-[var(--app-fg)] text-[var(--app-bg)] flex items-center justify-center text-sm font-medium">
                                    3
                                </div>
                                <div className="flex-1 pt-1">
                                    <p className="text-sm text-[var(--app-fg)]">
                                        Tap <strong>Add</strong> in the top right corner
                                    </p>
                                </div>
                            </div>
                        </div>

                        <button
                            onClick={() => {
                                setShowIOSGuide(false)
                                dismissInstall()
                            }}
                            className="w-full py-3 text-sm text-[var(--app-hint)] active:opacity-60"
                        >
                            {t('button.dismiss')}
                        </button>
                    </div>
                </div>
            )
        }

        return (
            <div className="fixed bottom-4 left-4 right-4 bg-[var(--app-secondary-bg)] border border-[var(--app-border)] rounded-lg p-4 shadow-lg z-50">
                <div className="flex items-center justify-between gap-3">
                    <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-[var(--app-fg)]">
                            {t('install.title')}
                        </p>
                        <p className="text-xs text-[var(--app-hint)] mt-0.5">
                            {t('install.description')}
                        </p>
                    </div>
                    <button
                        onClick={() => {
                            haptic.impact('light')
                            setShowIOSGuide(true)
                        }}
                        className="shrink-0 px-4 py-2 bg-[var(--app-fg)] text-[var(--app-bg)] rounded-lg text-sm font-medium active:opacity-80"
                    >
                        {t('install.button')}
                    </button>
                    <button
                        onClick={() => {
                            haptic.impact('light')
                            dismissInstall()
                        }}
                        className="shrink-0 p-2 text-[var(--app-hint)] active:opacity-60"
                        aria-label="Dismiss"
                    >
                        <CloseIcon className="w-4 h-4" />
                    </button>
                </div>
            </div>
        )
    }

    // Chrome/Edge install prompt
    if (!canInstall) {
        return null
    }

    const handleInstall = async () => {
        haptic.impact('light')
        const success = await promptInstall()
        if (success) {
            haptic.notification('success')
        }
    }

    return (
        <div className="fixed bottom-4 left-4 right-4 bg-[var(--app-secondary-bg)] border border-[var(--app-border)] rounded-lg p-4 shadow-lg z-50">
            <div className="flex items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-[var(--app-fg)]">
                        {t('install.title')}
                    </p>
                    <p className="text-xs text-[var(--app-hint)] mt-0.5">
                        {t('install.description')}
                    </p>
                </div>
                <button
                    onClick={handleInstall}
                    className="shrink-0 px-4 py-2 bg-[var(--app-fg)] text-[var(--app-bg)] rounded-lg text-sm font-medium active:opacity-80"
                >
                    {t('install.button')}
                </button>
                <button
                    onClick={() => {
                        haptic.impact('light')
                        dismissInstall()
                    }}
                    className="shrink-0 p-2 text-[var(--app-hint)] active:opacity-60"
                    aria-label="Dismiss"
                >
                    <CloseIcon className="w-4 h-4" />
                </button>
            </div>
        </div>
    )
}

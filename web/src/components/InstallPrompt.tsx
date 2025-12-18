import { usePWAInstall } from '@/hooks/usePWAInstall'
import { usePlatform } from '@/hooks/usePlatform'

export function InstallPrompt() {
    const { canInstall, promptInstall, isStandalone } = usePWAInstall()
    const { isTelegram, haptic } = usePlatform()

    if (isTelegram || isStandalone || !canInstall) {
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
                        Install Happy App
                    </p>
                    <p className="text-xs text-[var(--app-hint)] mt-0.5">
                        Add to home screen for the best experience
                    </p>
                </div>
                <button
                    onClick={handleInstall}
                    className="shrink-0 px-4 py-2 bg-[var(--app-button)] text-[var(--app-button-text)] rounded-lg text-sm font-medium active:opacity-80"
                >
                    Install
                </button>
            </div>
        </div>
    )
}

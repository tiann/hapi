import { useCallback, useEffect, useState } from 'react'

interface BeforeInstallPromptEvent extends Event {
    prompt: () => Promise<void>
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

type InstallState = 'idle' | 'available' | 'installing' | 'installed'

const INSTALL_DISMISSED_KEY = 'pwa_install_dismissed'

function isIOSSafari(): boolean {
    if (typeof window === 'undefined') return false
    const ua = window.navigator.userAgent
    const isIOS = /iPad|iPhone|iPod/.test(ua)
    const isWebkit = /WebKit/.test(ua)
    const isChrome = /CriOS/.test(ua)
    const isFirefox = /FxiOS/.test(ua)
    // iOS Safari is WebKit-based but not Chrome or Firefox
    return isIOS && isWebkit && !isChrome && !isFirefox
}

function getInstallDismissed(): boolean {
    try {
        return localStorage.getItem(INSTALL_DISMISSED_KEY) === 'true'
    } catch {
        return false
    }
}

function setInstallDismissed(): void {
    try {
        localStorage.setItem(INSTALL_DISMISSED_KEY, 'true')
    } catch {
        // Ignore storage errors
    }
}

export function usePWAInstall(): {
    installState: InstallState
    canInstall: boolean
    canInstallIOS: boolean
    isStandalone: boolean
    isIOS: boolean
    promptInstall: () => Promise<boolean>
    dismissInstall: () => void
} {
    const [installState, setInstallState] = useState<InstallState>('idle')
    const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)
    const [dismissed, setDismissed] = useState(() => getInstallDismissed())

    const isIOS = typeof window !== 'undefined' && isIOSSafari()

    const isStandalone =
        typeof window !== 'undefined' &&
        (window.matchMedia('(display-mode: standalone)').matches ||
            (window.navigator as Navigator & { standalone?: boolean }).standalone === true)

    useEffect(() => {
        if (isStandalone) {
            setInstallState('installed')
            return
        }

        const handleBeforeInstallPrompt = (e: Event) => {
            e.preventDefault()
            setDeferredPrompt(e as BeforeInstallPromptEvent)
            setInstallState('available')
        }

        const handleAppInstalled = () => {
            setInstallState('installed')
            setDeferredPrompt(null)
        }

        window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
        window.addEventListener('appinstalled', handleAppInstalled)

        return () => {
            window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
            window.removeEventListener('appinstalled', handleAppInstalled)
        }
    }, [isStandalone])

    const promptInstall = useCallback(async (): Promise<boolean> => {
        if (!deferredPrompt) {
            return false
        }

        // Clear immediately to prevent re-entrancy while userChoice is pending
        const prompt = deferredPrompt
        setDeferredPrompt(null)
        setInstallState('installing')

        try {
            await prompt.prompt()
            const { outcome } = await prompt.userChoice

            if (outcome === 'accepted') {
                setInstallState('installed')
                return true
            } else {
                // User dismissed, wait for a new beforeinstallprompt event
                setInstallState('idle')
                return false
            }
        } catch {
            setInstallState('idle')
            return false
        }
    }, [deferredPrompt])

    const dismissInstall = useCallback(() => {
        setDismissed(true)
        setInstallDismissed()
    }, [])

    return {
        installState,
        canInstall: installState === 'available',
        canInstallIOS: isIOS && !isStandalone && !dismissed,
        isStandalone,
        isIOS,
        promptInstall,
        dismissInstall
    }
}

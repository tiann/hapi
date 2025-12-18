import { useCallback, useEffect, useState } from 'react'

interface BeforeInstallPromptEvent extends Event {
    prompt: () => Promise<void>
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

type InstallState = 'idle' | 'available' | 'installing' | 'installed'

export function usePWAInstall(): {
    installState: InstallState
    canInstall: boolean
    isStandalone: boolean
    promptInstall: () => Promise<boolean>
} {
    const [installState, setInstallState] = useState<InstallState>('idle')
    const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)

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

    return {
        installState,
        canInstall: installState === 'available',
        isStandalone,
        promptInstall
    }
}

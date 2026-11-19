import { useCallback, useEffect, useRef, useState } from 'react'
import { registerSW } from 'virtual:pwa-register'
import { cleanupClientStaticCachesOnVersionChange } from '@/lib/swStaticCache'

export const PWA_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000
export const PWA_UPDATE_RELOAD_FALLBACK_MS = 2000

export async function requestPwaUpdateReload(
    updateSW: ((reloadPage?: boolean) => Promise<void>) | null | undefined,
    options: {
        reloadPage?: () => void
        setTimeoutFn?: typeof setTimeout
        clearTimeoutFn?: typeof clearTimeout
    } = {},
): Promise<void> {
    const reloadPage = options.reloadPage ?? (() => window.location.reload())
    const setTimeoutFn = options.setTimeoutFn ?? setTimeout
    const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout

    if (!updateSW) {
        reloadPage()
        return
    }

    let reloaded = false
    const doReload = () => {
        if (reloaded) {
            return
        }
        reloaded = true
        reloadPage()
    }

    const onControllerChange = () => {
        navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
        doReload()
    }

    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)

    let fallbackTimer: ReturnType<typeof setTimeout> | undefined

    try {
        await updateSW(true)
    } catch (error) {
        console.error('PWA update failed', error)
        navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
        if (fallbackTimer !== undefined) {
            clearTimeoutFn(fallbackTimer)
        }
        doReload()
        return
    }

    fallbackTimer = setTimeoutFn(() => {
        navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
        doReload()
    }, PWA_UPDATE_RELOAD_FALLBACK_MS)
}

export function setupRegistrationUpdateChecks(
    registration: ServiceWorkerRegistration,
): () => void {
    const intervalId = window.setInterval(() => {
        void registration.update()
    }, PWA_UPDATE_CHECK_INTERVAL_MS)

    const handleVisibilityChange = () => {
        if (document.visibilityState === 'visible') {
            void registration.update()
        }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
        window.clearInterval(intervalId)
        document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
}

export function usePwaUpdate() {
    const [needRefresh, setNeedRefresh] = useState(false)
    const updateSWRef = useRef<((reloadPage?: boolean) => Promise<void>) | null>(null)
    const registrationRef = useRef<ServiceWorkerRegistration | null>(null)
    const pendingUpdateCheckRef = useRef(false)
    const cleanupRef = useRef<(() => void) | null>(null)

    useEffect(() => {
        if (typeof window !== 'undefined') {
            const appVersion = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0'
            void cleanupClientStaticCachesOnVersionChange({
                appVersion,
                storage: window.localStorage,
                cacheStorage: window.caches,
            })
        }

        const updateSW = registerSW({
            onNeedRefresh() {
                setNeedRefresh(true)
            },
            onOfflineReady() {
                console.log('App ready for offline use')
            },
            onRegistered(registration) {
                cleanupRef.current?.()
                cleanupRef.current = null
                registrationRef.current = registration ?? null

                if (!registration) {
                    return
                }

                if (pendingUpdateCheckRef.current) {
                    pendingUpdateCheckRef.current = false
                    void registration.update().catch(() => {})
                }

                cleanupRef.current = setupRegistrationUpdateChecks(registration)
            },
            onRegisterError(error) {
                console.error('SW registration error:', error)
            },
        })

        updateSWRef.current = updateSW

        return () => {
            cleanupRef.current?.()
            cleanupRef.current = null
            registrationRef.current = null
            pendingUpdateCheckRef.current = false
            updateSWRef.current = null
        }
    }, [])

    const reload = useCallback(() => {
        void requestPwaUpdateReload(updateSWRef.current)
    }, [])

    const checkForUpdates = useCallback(() => {
        const registration = registrationRef.current
        if (registration) {
            pendingUpdateCheckRef.current = false
            void registration.update().catch(() => {})
            return
        }

        pendingUpdateCheckRef.current = true
        if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof navigator.serviceWorker.getRegistration === 'function') {
            void navigator.serviceWorker.getRegistration()
                .then((existing) => {
                    if (existing) {
                        pendingUpdateCheckRef.current = false
                        return existing.update()
                    }
                    return undefined
                })
                .catch(() => {})
        }
    }, [])

    return { needRefresh, reload, checkForUpdates }
}

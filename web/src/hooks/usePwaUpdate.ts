import { useCallback, useEffect, useRef, useState } from 'react'
import { registerSW } from 'virtual:pwa-register'
import {
    cleanupClientStaticCachesOnVersionChange,
    getSafeCacheStorage,
    getSafeLocalStorage,
} from '@/lib/swStaticCache'

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
    const pendingUpdateResolversRef = useRef<Array<(ok: boolean) => void>>([])
    const cleanupRef = useRef<(() => void) | null>(null)

    useEffect(() => {
        if (typeof window !== 'undefined') {
            const appVersion = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0'
            let scope: string | undefined
            try {
                scope = new URL(import.meta.env.BASE_URL || '/', window.location.origin).href
            } catch {
                scope = undefined
            }
            const serviceWorker = typeof navigator !== 'undefined' && 'serviceWorker' in navigator
                ? navigator.serviceWorker
                : null
            void cleanupClientStaticCachesOnVersionChange({
                appVersion,
                scope,
                storage: getSafeLocalStorage(),
                cacheStorage: getSafeCacheStorage(),
                serviceWorker,
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

                const resolvers = pendingUpdateResolversRef.current.splice(0)
                if (!registration) {
                    for (const resolve of resolvers) resolve(false)
                    return
                }

                if (resolvers.length > 0) {
                    void registration.update()
                        .then(() => {
                            for (const resolve of resolvers) resolve(true)
                        })
                        .catch(() => {
                            for (const resolve of resolvers) resolve(false)
                        })
                }

                cleanupRef.current = setupRegistrationUpdateChecks(registration)
            },
            onRegisterError(error) {
                console.error('SW registration error:', error)
                for (const resolve of pendingUpdateResolversRef.current.splice(0)) {
                    resolve(false)
                }
            },
        })

        updateSWRef.current = updateSW

        return () => {
            cleanupRef.current?.()
            cleanupRef.current = null
            registrationRef.current = null
            for (const resolve of pendingUpdateResolversRef.current.splice(0)) {
                resolve(false)
            }
            updateSWRef.current = null
        }
    }, [])

    const reload = useCallback(() => {
        void requestPwaUpdateReload(updateSWRef.current)
    }, [])

    const checkForUpdates = useCallback(async (): Promise<boolean> => {
        if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
            return false
        }

        const registration = registrationRef.current
        if (registration) {
            try {
                await registration.update()
                return true
            } catch {
                return false
            }
        }

        if (typeof navigator.serviceWorker.getRegistration === 'function') {
            try {
                const existing = await navigator.serviceWorker.getRegistration()
                const resolved = existing ?? registrationRef.current
                if (resolved) {
                    registrationRef.current = resolved
                    await resolved.update()
                    return true
                }
            } catch {
                return false
            }
        }

        if (registrationRef.current) {
            try {
                await registrationRef.current.update()
                return true
            } catch {
                return false
            }
        }

        return await new Promise<boolean>((resolve) => {
            pendingUpdateResolversRef.current.push(resolve)
        })
    }, [])

    return { needRefresh, reload, checkForUpdates }
}

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    PWA_UPDATE_CHECK_INTERVAL_MS,
    PWA_UPDATE_RELOAD_FALLBACK_MS,
    requestPwaUpdateReload,
    setupRegistrationUpdateChecks,
    usePwaUpdate,
} from '@/hooks/usePwaUpdate'
import { getSyntaxGrammarsCacheName } from '@/lib/swStaticCache'

const registerSWMock = vi.fn()
const serviceWorkerListeners = new Map<string, Set<EventListener>>()

vi.mock('virtual:pwa-register', () => ({
    registerSW: (options: Parameters<typeof registerSWMock>[0]) => registerSWMock(options),
}))

const originalCachesDescriptor = Object.getOwnPropertyDescriptor(window, 'caches')
const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')

beforeEach(() => {
    serviceWorkerListeners.clear()
    if (originalLocalStorageDescriptor) {
        Object.defineProperty(window, 'localStorage', originalLocalStorageDescriptor)
    }
    window.localStorage.clear()
    if (originalCachesDescriptor) {
        Object.defineProperty(window, 'caches', originalCachesDescriptor)
    } else {
        delete (window as { caches?: CacheStorage }).caches
    }
    Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: {
            controller: null,
            getRegistration: vi.fn(async () => undefined),
            addEventListener: (type: string, listener: EventListener) => {
                const bucket = serviceWorkerListeners.get(type) ?? new Set<EventListener>()
                bucket.add(listener)
                serviceWorkerListeners.set(type, bucket)
            },
            removeEventListener: (type: string, listener: EventListener) => {
                serviceWorkerListeners.get(type)?.delete(listener)
            },
        },
    })
})

describe('setupRegistrationUpdateChecks', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('checks for updates on an hourly interval', () => {
        const registration = {
            update: vi.fn().mockResolvedValue(undefined),
        } as unknown as ServiceWorkerRegistration

        const cleanup = setupRegistrationUpdateChecks(registration)

        vi.advanceTimersByTime(PWA_UPDATE_CHECK_INTERVAL_MS)
        expect(registration.update).toHaveBeenCalledTimes(1)

        vi.advanceTimersByTime(PWA_UPDATE_CHECK_INTERVAL_MS)
        expect(registration.update).toHaveBeenCalledTimes(2)

        cleanup()
    })

    it('checks for updates when the tab becomes visible', () => {
        const registration = {
            update: vi.fn().mockResolvedValue(undefined),
        } as unknown as ServiceWorkerRegistration

        const cleanup = setupRegistrationUpdateChecks(registration)

        Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            value: 'hidden',
        })
        document.dispatchEvent(new Event('visibilitychange'))
        expect(registration.update).not.toHaveBeenCalled()

        Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            value: 'visible',
        })
        document.dispatchEvent(new Event('visibilitychange'))
        expect(registration.update).toHaveBeenCalledTimes(1)

        cleanup()
    })

    it('removes listeners and clears the interval on cleanup', () => {
        const registration = {
            update: vi.fn().mockResolvedValue(undefined),
        } as unknown as ServiceWorkerRegistration
        const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener')
        const clearIntervalSpy = vi.spyOn(window, 'clearInterval')

        const cleanup = setupRegistrationUpdateChecks(registration)
        cleanup()

        expect(removeEventListenerSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
        expect(clearIntervalSpy).toHaveBeenCalled()
    })
})

describe('requestPwaUpdateReload', () => {
    it('reloads immediately when updateSW is unavailable', async () => {
        const reloadPage = vi.fn()

        await requestPwaUpdateReload(null, { reloadPage })

        expect(reloadPage).toHaveBeenCalledTimes(1)
    })

    it('calls updateSW and reloads on controllerchange', async () => {
        const updateSW = vi.fn().mockImplementation(async () => {
            for (const listener of serviceWorkerListeners.get('controllerchange') ?? []) {
                listener(new Event('controllerchange'))
            }
        })
        const reloadPage = vi.fn()

        await requestPwaUpdateReload(updateSW, { reloadPage })

        expect(updateSW).toHaveBeenCalledWith(true)
        expect(reloadPage).toHaveBeenCalledTimes(1)
    })

    it('falls back to reload when controllerchange never fires', async () => {
        vi.useFakeTimers()

        const updateSW = vi.fn().mockResolvedValue(undefined)
        const reloadPage = vi.fn()

        const pending = requestPwaUpdateReload(updateSW, {
            reloadPage,
            setTimeoutFn: vi.fn((callback, delay) => {
                expect(delay).toBe(PWA_UPDATE_RELOAD_FALLBACK_MS)
                return setTimeout(callback, delay)
            }) as unknown as typeof setTimeout,
        })

        await pending
        vi.runAllTimers()

        expect(updateSW).toHaveBeenCalledWith(true)
        expect(reloadPage).toHaveBeenCalledTimes(1)

        vi.useRealTimers()
    })
})

describe('usePwaUpdate', () => {
    let capturedOptions: {
        onNeedRefresh?: () => void
        onRegistered?: (registration: ServiceWorkerRegistration | undefined) => void
        onRegisterError?: (error: unknown) => void
    } = {}
    const updateSW = vi.fn().mockResolvedValue(undefined)

    beforeEach(() => {
        capturedOptions = {}
        registerSWMock.mockClear()
        updateSW.mockClear()
        registerSWMock.mockImplementation((options) => {
            capturedOptions = options
            return updateSW
        })
    })

    it('registers the service worker and exposes refresh state', () => {
        const { result } = renderHook(() => usePwaUpdate())

        expect(registerSWMock).toHaveBeenCalledTimes(1)
        expect(result.current.needRefresh).toBe(false)

        act(() => {
            capturedOptions.onNeedRefresh?.()
        })

        expect(result.current.needRefresh).toBe(true)
    })

    it('reloads through updateSW when reload is called', async () => {
        const updateSW = vi.fn().mockImplementation(async () => {
            for (const listener of serviceWorkerListeners.get('controllerchange') ?? []) {
                listener(new Event('controllerchange'))
            }
        })
        registerSWMock.mockImplementation((options) => {
            capturedOptions = options
            return updateSW
        })

        const { result } = renderHook(() => usePwaUpdate())

        await act(async () => {
            result.current.reload()
        })

        expect(updateSW).toHaveBeenCalledWith(true)
    })

    it('keeps needRefresh true until a successful reload clears the page', () => {
        const { result } = renderHook(() => usePwaUpdate())

        act(() => {
            capturedOptions.onNeedRefresh?.()
        })

        expect(result.current.needRefresh).toBe(true)

        act(() => {
            result.current.reload()
        })

        expect(updateSW).toHaveBeenCalledWith(true)
        expect(result.current.needRefresh).toBe(true)
    })

    it('wires registration update checks from onRegistered', () => {
        vi.useFakeTimers()

        const registration = {
            update: vi.fn().mockResolvedValue(undefined),
        } as unknown as ServiceWorkerRegistration

        renderHook(() => usePwaUpdate())

        act(() => {
            capturedOptions.onRegistered?.(registration)
        })

        vi.advanceTimersByTime(PWA_UPDATE_CHECK_INTERVAL_MS)
        expect(registration.update).toHaveBeenCalledTimes(1)

        vi.useRealTimers()
    })

    it('cleans outdated client static caches on startup when app version changes and triggers registration.update on checkForUpdates', async () => {
        const scope = new URL(import.meta.env.BASE_URL || '/', window.location.origin).href
        const oldCache = getSyntaxGrammarsCacheName('0.36.4-deadbeef', scope)
        const currentCache = getSyntaxGrammarsCacheName(`${__APP_VERSION__}-keep1234`, scope)
        window.localStorage.setItem('hapi:static-cache-version', '0.36.4')
        const deleteMock = vi.fn(async () => true)
        const keysMock = vi.fn(async () => [
            'syntax-grammars',
            oldCache,
            currentCache,
            'api-sessions',
        ])
        const legacyEntryDeleteMock = vi.fn(async () => true)
        const openMock = vi.fn(async () => ({
            keys: vi.fn(async () => [{ url: `${scope}assets/shiki-old.js` }]),
            delete: legacyEntryDeleteMock,
        }))
        Object.defineProperty(window, 'caches', {
            configurable: true,
            value: {
                keys: keysMock,
                delete: deleteMock,
                open: openMock,
            },
        })

        const registration = {
            update: vi.fn().mockResolvedValue(undefined),
        } as unknown as ServiceWorkerRegistration

        const { result } = renderHook(() => usePwaUpdate())

        await act(async () => {
            capturedOptions.onRegistered?.(registration)
            await Promise.resolve()
        })

        expect(legacyEntryDeleteMock).toHaveBeenCalledWith({ url: `${scope}assets/shiki-old.js` })
        expect(deleteMock).not.toHaveBeenCalledWith('syntax-grammars')
        expect(deleteMock).toHaveBeenCalledWith(oldCache)
        expect(deleteMock).not.toHaveBeenCalledWith(currentCache)
        expect(deleteMock).not.toHaveBeenCalledWith('api-sessions')
        expect(window.localStorage.getItem('hapi:static-cache-version')).toBe(__APP_VERSION__)

        await act(async () => {
            await expect(result.current.checkForUpdates()).resolves.toBe(true)
        })
        expect(registration.update).toHaveBeenCalledTimes(1)
    })

    it.each([['redundant', false], ['installed', true]])('waits for worker state %s', async (state, expected) => {
        const worker = Object.assign(new EventTarget(), { state: 'installing' })
        const registration = { installing: worker, update: vi.fn().mockResolvedValue(undefined) }
        const { result } = renderHook(() => usePwaUpdate())
        act(() => capturedOptions.onRegistered?.(registration as unknown as ServiceWorkerRegistration))
        const check = result.current.checkForUpdates()
        await Promise.resolve()
        worker.state = String(state)
        worker.dispatchEvent(new Event('statechange'))
        await expect(check).resolves.toBe(expected)
    })

    it('returns false from checkForUpdates when registration.update rejects', async () => {
        const registration = {
            update: vi.fn().mockRejectedValue(new Error('503')),
        } as unknown as ServiceWorkerRegistration

        const { result } = renderHook(() => usePwaUpdate())

        act(() => {
            capturedOptions.onRegistered?.(registration)
        })

        await act(async () => {
            await expect(result.current.checkForUpdates()).resolves.toBe(false)
        })
    })

    it('flushes a pending checkForUpdates call once onRegistered receives the registration', async () => {
        const registration = {
            update: vi.fn().mockResolvedValue(undefined),
        } as unknown as ServiceWorkerRegistration

        const { result } = renderHook(() => usePwaUpdate())

        let pendingPromise!: Promise<boolean>
        await act(async () => {
            pendingPromise = result.current.checkForUpdates()
            await Promise.resolve()
        })
        expect(registration.update).not.toHaveBeenCalled()

        await act(async () => {
            capturedOptions.onRegistered?.(registration)
            await expect(pendingPromise).resolves.toBe(true)
        })
        expect(registration.update).toHaveBeenCalledTimes(1)
    })

    it('settles an in-flight checkForUpdates with false when registration fails before the check queues and retries registration on a later check', async () => {
        let resolveLookup!: (value: ServiceWorkerRegistration | undefined) => void
        Object.defineProperty(navigator, 'serviceWorker', {
            configurable: true,
            value: {
                controller: null,
                getRegistration: vi.fn(() => new Promise<ServiceWorkerRegistration | undefined>((resolve) => {
                    resolveLookup = resolve
                })),
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
            },
        })

        const { result } = renderHook(() => usePwaUpdate())
        expect(registerSWMock).toHaveBeenCalledTimes(1)

        const firstCheck = result.current.checkForUpdates()
        act(() => {
            capturedOptions.onRegisterError?.(new Error('transient sw error'))
        })
        resolveLookup(undefined)
        await expect(firstCheck).resolves.toBe(false)
        expect(registerSWMock).toHaveBeenCalledTimes(1)

        // Later health-triggered check retries registration after the transient failure
        const registration = {
            update: vi.fn().mockResolvedValue(undefined),
        } as unknown as ServiceWorkerRegistration
        ;(navigator.serviceWorker.getRegistration as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)

        let secondCheck!: Promise<boolean>
        await act(async () => {
            secondCheck = result.current.checkForUpdates()
            await Promise.resolve()
        })
        expect(registerSWMock).toHaveBeenCalledTimes(2)

        await act(async () => {
            capturedOptions.onRegistered?.(registration)
            await expect(secondCheck).resolves.toBe(true)
        })
        expect(registration.update).toHaveBeenCalledTimes(1)
    })

    it('still registers the service worker when window.localStorage getter throws SecurityError', () => {
        Object.defineProperty(window, 'localStorage', {
            configurable: true,
            get() {
                throw new DOMException('Access denied', 'SecurityError')
            },
        })

        renderHook(() => usePwaUpdate())

        expect(registerSWMock).toHaveBeenCalledTimes(1)
    })

    it('delegates cache cleanup to an active controlling worker instead of deleting caches from window', async () => {
        window.localStorage.setItem('hapi:static-cache-version', '0.36.4')
        const deleteMock = vi.fn(async () => true)
        const postMessage = vi.fn()
        Object.defineProperty(window, 'caches', {
            configurable: true,
            value: {
                keys: vi.fn(async () => ['syntax-grammars-0.36.4-old']),
                delete: deleteMock,
            },
        })
        Object.defineProperty(navigator, 'serviceWorker', {
            configurable: true,
            value: {
                controller: { postMessage },
                getRegistration: vi.fn(),
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
            },
        })

        renderHook(() => usePwaUpdate())

        await act(async () => {
            await Promise.resolve()
        })

        expect(postMessage).toHaveBeenCalledWith({ type: 'CLEANUP_OUTDATED_CACHES' })
        expect(deleteMock).not.toHaveBeenCalled()
    })
})

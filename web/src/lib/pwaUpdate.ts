export interface PwaRefreshEnvironment {
    confirmReload?: (message: string) => boolean
    matchMedia?: (query: string) => Pick<MediaQueryList, 'matches'>
    navigator?: Navigator & { standalone?: boolean }
}

export interface ServiceWorkerRefreshEnvironment {
    document?: Pick<Document, 'addEventListener' | 'visibilityState'>
    setInterval?: (handler: () => void, timeout: number) => unknown
    setTimeout?: (handler: () => void, timeout: number) => unknown
}

export const SERVICE_WORKER_REFRESH_INITIAL_DELAY_MS = 30 * 1000
export const SERVICE_WORKER_REFRESH_INTERVAL_MS = 15 * 60 * 1000

function getDefaultRefreshEnvironment(): PwaRefreshEnvironment {
    return {
        confirmReload: (message) => window.confirm(message),
        matchMedia: (query) => window.matchMedia(query),
        navigator: globalThis.navigator as Navigator & { standalone?: boolean },
    }
}

function isMobileLikeEnvironment(env: PwaRefreshEnvironment): boolean {
    const displayStandalone = env.matchMedia?.('(display-mode: standalone)').matches ?? false
    const coarsePointer = env.matchMedia?.('(pointer: coarse)').matches ?? false
    const iosStandalone = env.navigator?.standalone === true
    return displayStandalone || coarsePointer || iosStandalone
}

export async function handleNeedRefresh(
    updateSW: (reloadPage?: boolean) => Promise<void>,
    env: PwaRefreshEnvironment = getDefaultRefreshEnvironment()
): Promise<void> {
    const mobileLike = isMobileLikeEnvironment(env)
    const confirmed = env.confirmReload?.(
        mobileLike
            ? 'New HAPI version available. Reload when ready?'
            : 'New version available! Reload to update?'
    ) ?? true
    if (confirmed) {
        await updateSW(true)
    }
}

export function scheduleServiceWorkerRefresh(
    registration: Pick<ServiceWorkerRegistration, 'update'>,
    env: ServiceWorkerRefreshEnvironment = {}
): void {
    const targetDocument = env.document ?? document
    const scheduleInterval = env.setInterval ?? setInterval
    const scheduleTimeout = env.setTimeout ?? setTimeout
    let pendingUpdate: unknown = null

    const triggerUpdate = () => {
        try {
            void registration.update().catch(() => undefined)
        } catch {
            // Best-effort freshness check; never break app startup on SW update errors.
        }
    }

    const scheduleUpdate = () => {
        if (pendingUpdate) {
            return
        }
        pendingUpdate = scheduleTimeout(() => {
            pendingUpdate = null
            triggerUpdate()
        }, SERVICE_WORKER_REFRESH_INITIAL_DELAY_MS)
    }

    scheduleUpdate()
    scheduleInterval(triggerUpdate, SERVICE_WORKER_REFRESH_INTERVAL_MS)
    targetDocument.addEventListener('visibilitychange', () => {
        if (targetDocument.visibilityState === 'visible') {
            scheduleUpdate()
        }
    })
}

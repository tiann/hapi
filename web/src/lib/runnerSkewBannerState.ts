const MINIMIZED_KEY = 'hapi.runnerSkew.minimized.v1'
const DISMISS_UNTIL_KEY = 'hapi.runnerSkew.dismissUntil.v1'
export const RUNNER_SKEW_TEMP_DISMISS_MS = 60 * 60_000

/** In-memory fallback when sessionStorage is full / blocked (QuotaExceededError). */
let memoryMinimized: boolean | null = null
let memoryDismissUntil: number | null = null

function readStorage(): Storage | null {
    if (typeof window === 'undefined') {
        return null
    }
    try {
        return window.sessionStorage
    } catch {
        return null
    }
}

function writeStorage(mutate: (storage: Storage) => void): void {
    const storage = readStorage()
    if (!storage) {
        return
    }
    try {
        mutate(storage)
    } catch {
        // QuotaExceededError / SecurityError — keep memory fallback only.
    }
}

export function isRunnerSkewMinimized(): boolean {
    if (memoryMinimized !== null) {
        return memoryMinimized
    }
    try {
        return readStorage()?.getItem(MINIMIZED_KEY) === '1'
    } catch {
        return false
    }
}

export function setRunnerSkewMinimized(minimized: boolean): void {
    memoryMinimized = minimized
    writeStorage((storage) => {
        if (minimized) {
            storage.setItem(MINIMIZED_KEY, '1')
        } else {
            storage.removeItem(MINIMIZED_KEY)
        }
    })
}

export function getRunnerSkewDismissUntil(): number {
    if (memoryDismissUntil !== null) {
        return memoryDismissUntil
    }
    try {
        const raw = readStorage()?.getItem(DISMISS_UNTIL_KEY)
        if (!raw) {
            return 0
        }
        const parsed = Number(raw)
        return Number.isFinite(parsed) ? parsed : 0
    } catch {
        return 0
    }
}

export function isRunnerSkewTempDismissed(now: number = Date.now()): boolean {
    return getRunnerSkewDismissUntil() > now
}

export function tempDismissRunnerSkew(now: number = Date.now()): void {
    const until = now + RUNNER_SKEW_TEMP_DISMISS_MS
    memoryDismissUntil = until
    writeStorage((storage) => {
        storage.setItem(DISMISS_UNTIL_KEY, String(until))
    })
}

export function clearRunnerSkewTempDismiss(): void {
    memoryDismissUntil = 0
    writeStorage((storage) => {
        storage.removeItem(DISMISS_UNTIL_KEY)
    })
}

/** Test helper: reset memory mirrors (sessionStorage cleared separately). */
export function resetRunnerSkewBannerMemoryForTests(): void {
    memoryMinimized = null
    memoryDismissUntil = null
}

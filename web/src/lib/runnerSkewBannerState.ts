const MINIMIZED_KEY = 'hapi.runnerSkew.minimized.v1'
const DISMISS_UNTIL_KEY = 'hapi.runnerSkew.dismissUntil.v1'
export const RUNNER_SKEW_TEMP_DISMISS_MS = 60 * 60_000

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

export function isRunnerSkewMinimized(): boolean {
    return readStorage()?.getItem(MINIMIZED_KEY) === '1'
}

export function setRunnerSkewMinimized(minimized: boolean): void {
    const storage = readStorage()
    if (!storage) {
        return
    }
    if (minimized) {
        storage.setItem(MINIMIZED_KEY, '1')
    } else {
        storage.removeItem(MINIMIZED_KEY)
    }
}

export function getRunnerSkewDismissUntil(): number {
    const raw = readStorage()?.getItem(DISMISS_UNTIL_KEY)
    if (!raw) {
        return 0
    }
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : 0
}

export function isRunnerSkewTempDismissed(now: number = Date.now()): boolean {
    return getRunnerSkewDismissUntil() > now
}

export function tempDismissRunnerSkew(now: number = Date.now()): void {
    readStorage()?.setItem(DISMISS_UNTIL_KEY, String(now + RUNNER_SKEW_TEMP_DISMISS_MS))
}

export function clearRunnerSkewTempDismiss(): void {
    readStorage()?.removeItem(DISMISS_UNTIL_KEY)
}

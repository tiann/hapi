import type { ProviderReadinessIssue } from '@hapi/protocol'

export type ProviderGuardResult<T> =
    | { ok: true; value: T }
    | { ok: false; issue: ProviderReadinessIssue }
    | { ok: false; reason: 'selection-changed' }

export async function guardProviderSelectionAcrossAsyncCheck<T>(
    getIssue: () => ProviderReadinessIssue | null,
    check: () => Promise<T>,
    getSelectionKey?: () => string
): Promise<ProviderGuardResult<T>> {
    const before = getIssue()
    if (before) return { ok: false, issue: before }
    const selectionKey = getSelectionKey?.()

    const value = await check()
    if (getSelectionKey && getSelectionKey() !== selectionKey) {
        return { ok: false, reason: 'selection-changed' }
    }
    const after = getIssue()
    return after ? { ok: false, issue: after } : { ok: true, value }
}

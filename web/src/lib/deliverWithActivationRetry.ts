import { ApiError } from '@/api/client'

/**
 * A spawned CLI's Socket.IO connection can land after the hub has already
 * acked the HTTP spawn webhook — the session row exists but isn't `active`
 * yet, so an immediate message send 409s with `session_inactive` (review
 * finding: the board-spawn briefing delivery had no retry for exactly this
 * transient race, unlike the ordinary chat composer's own reopen-offering
 * path for a *settled* inactive session). Bounded retries with a short
 * backoff cover the common case (activation lands within a second or two);
 * a session still inactive after all of them is probably genuinely stuck,
 * not mid-handshake, so the caller's own failure handling takes over.
 */
const ACTIVATION_RETRY_DELAYS_MS = [300, 700, 1500, 3000]

function isSessionInactiveError(error: unknown): boolean {
    return error instanceof ApiError && error.status === 409 && error.code === 'session_inactive'
}

export async function deliverWithActivationRetry<T>(deliver: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
        try {
            return await deliver()
        } catch (error) {
            if (!isSessionInactiveError(error) || attempt >= ACTIVATION_RETRY_DELAYS_MS.length) {
                throw error
            }
            await new Promise(resolve => setTimeout(resolve, ACTIVATION_RETRY_DELAYS_MS[attempt]))
        }
    }
}

export const TELEGRAM_AUTH_DISABLED_MESSAGE = 'Telegram authentication is disabled. Configure TELEGRAM_BOT_TOKEN.'
export type AuthConnectionFailure = { status?: number; diagnostic?: string }

/** A browser network error alone cannot identify which side is unavailable. */
export function authConnectionMessage(failure: AuthConnectionFailure, isOnline: boolean): string {
    if (!isOnline) return 'Your device is offline. Reconnect to the internet to reach the hub.'
    if (failure.diagnostic) return failure.diagnostic
    if (failure.status && failure.status >= 500) return `The hub or its gateway is temporarily unavailable (HTTP ${failure.status}).`
    if (failure.status) return `The hub endpoint returned HTTP ${failure.status}. Check the hub URL or try again.`
    return 'Cannot reach the hub. Check your connection or the hub\'s availability.'
}

/**
 * Per-notification dispatch context shared across channels in one
 * NotificationHub notify* call. FcmNotificationChannel runs first and
 * sets `nativeGate.sent` when FCM actually delivers; PushNotificationChannel
 * consults the same gate before suppressing web-push/SSE (never on stale
 * registration/health probes alone).
 */
export type NativeDeliveryGate = {
    sent: boolean
}

export type NotificationSendContext = {
    nativeGate?: NativeDeliveryGate
    /** Ready-event turn state, captured before the first channel can await network I/O. */
    readyState?: Readonly<{
        thinking: boolean
        activeTurnStartedAt?: number | null
        isSuperseded: () => boolean
        /** Opted-in channels must call this immediately before the first message POST. */
        onPostStarted?: () => void
    }>
    /** Newly detected requests in this permission debounce window, captured before dispatch. */
    permissionRequestIds?: readonly string[]
}

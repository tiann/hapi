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
}

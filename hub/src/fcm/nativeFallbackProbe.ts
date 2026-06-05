import type { Store } from '../store'

/**
 * Build a per-namespace probe used by the web-push channel to decide whether
 * to defer to the native FCM channel. The probe MUST only return true when
 * BOTH conditions hold:
 *
 *   1. FCM is actually configured on this hub start (fcmConfig is truthy),
 *      so a registered FCM channel exists to deliver the notification.
 *   2. At least one device row is registered for the namespace.
 *
 * Failing either condition means web-push must fire normally - otherwise
 * notifications go to /dev/null when, for example, an operator removes
 * `FCM_SERVICE_ACCOUNT_PATH` from the env without clearing stored device
 * registrations from the database.
 */
export function buildNativeFallbackProbe(
    store: Store,
    fcmConfig: unknown
): (namespace: string) => boolean {
    if (!fcmConfig) {
        return () => false
    }
    return (namespace: string) => store.fcm.getDevicesByNamespace(namespace).length > 0
}

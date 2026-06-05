import type { Store } from '../store'
import type { FcmService } from './fcmService'

/**
 * Build a per-namespace probe used by the web-push channel to decide whether
 * to defer to the native FCM channel. The probe MUST only return true when
 * ALL of these hold:
 *
 *   1. FCM is actually configured on this hub start (fcmConfig is truthy),
 *      so a registered FCM channel exists to deliver the notification.
 *   2. The FCM service is currently healthy (recent sends are not all
 *      failing). When credentials expire or the FCM pipeline blackholes,
 *      we let web-push run again so the operator does not get silently
 *      cut off from all notifications.
 *   3. At least one device row is registered for the namespace.
 *
 * Failing any condition means web-push must fire normally. The default
 * "happy path" remains: native is the canonical wrist-first surface and
 * web-push is suppressed to avoid duplicate OS notifications - this probe
 * only re-enables web-push when we have evidence the native pipeline is
 * not actually delivering.
 */
export function buildNativeFallbackProbe(
    store: Store,
    fcmConfig: unknown,
    fcmService?: Pick<FcmService, 'isHealthy'>
): (namespace: string) => boolean {
    if (!fcmConfig) {
        return () => false
    }
    return (namespace: string) => {
        if (fcmService && !fcmService.isHealthy()) {
            return false
        }
        return store.fcm.getDevicesByNamespace(namespace).length > 0
    }
}

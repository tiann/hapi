import type { Database } from 'bun:sqlite'

import type { NativeDevicePlatform, StoredFcmDevice } from './types'
import { getFcmDevicesByNamespace, removeFcmDeviceByToken, upsertFcmDevice } from './fcmDevices'

/**
 * Native-device registry. Despite the historical `fcm_` naming, the table
 * holds every native push registration: Android phone/wear rows (FCM
 * tokens) and iOS rows (hex APNs token + E2E `pushKey`). Callers that send
 * through a specific pipeline must pass a platform filter so FCM never sees
 * APNs tokens and vice versa.
 */
export class FcmStore {
    constructor(private readonly db: Database) {}

    upsertDevice(
        namespace: string,
        device: { token: string; platform: NativeDevicePlatform; deviceId: string; pushKey?: string }
    ): void {
        upsertFcmDevice(this.db, namespace, device)
    }

    removeDeviceByToken(namespace: string, token: string): void {
        removeFcmDeviceByToken(this.db, namespace, token)
    }

    getDevicesByNamespace(namespace: string): StoredFcmDevice[]
    getDevicesByNamespace<P extends NativeDevicePlatform>(
        namespace: string,
        platforms: readonly P[]
    ): Array<StoredFcmDevice & { platform: P }>
    getDevicesByNamespace(
        namespace: string,
        platforms?: readonly NativeDevicePlatform[]
    ): StoredFcmDevice[] {
        return getFcmDevicesByNamespace(this.db, namespace, platforms)
    }
}

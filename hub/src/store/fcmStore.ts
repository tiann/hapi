import type { Database } from 'bun:sqlite'

import type { StoredFcmDevice } from './types'
import { getFcmDevicesByNamespace, removeFcmDeviceByToken, upsertFcmDevice } from './fcmDevices'

export class FcmStore {
    constructor(private readonly db: Database) {}

    upsertDevice(
        namespace: string,
        device: { token: string; platform: 'phone' | 'wear'; deviceId: string }
    ): void {
        upsertFcmDevice(this.db, namespace, device)
    }

    removeDeviceByToken(namespace: string, token: string): void {
        removeFcmDeviceByToken(this.db, namespace, token)
    }

    getDevicesByNamespace(namespace: string): StoredFcmDevice[] {
        return getFcmDevicesByNamespace(this.db, namespace)
    }
}

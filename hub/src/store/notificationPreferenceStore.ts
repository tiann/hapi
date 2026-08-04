import type { Database } from 'bun:sqlite'

import type { NotificationPreferenceFlags, NotificationPreferences } from './notificationPreferences'
import { getPreferenceFlags, getPreferences, setPreferences } from './notificationPreferences'

export class NotificationPreferenceStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    getPreferences(namespace: string): NotificationPreferences {
        return getPreferences(this.db, namespace)
    }

    getPreferenceFlags(namespace: string): NotificationPreferenceFlags {
        return getPreferenceFlags(this.db, namespace)
    }

    setPreferences(
        namespace: string,
        partial: Partial<NotificationPreferenceFlags>
    ): NotificationPreferences {
        return setPreferences(this.db, namespace, partial)
    }
}

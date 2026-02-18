import type { Database } from 'bun:sqlite'

import type { StoredUserPreferences } from './userPreferences'
import { getUserPreferences, upsertReadyAnnouncementsPreference } from './userPreferences'

export class UserPreferencesStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    get(namespace: string): StoredUserPreferences {
        return getUserPreferences(this.db, namespace)
    }

    setReadyAnnouncements(namespace: string, readyAnnouncements: boolean): StoredUserPreferences {
        return upsertReadyAnnouncementsPreference(this.db, namespace, readyAnnouncements)
    }
}

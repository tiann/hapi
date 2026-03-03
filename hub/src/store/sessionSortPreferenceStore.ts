import type { Database } from 'bun:sqlite'
import type { SessionManualOrder, SessionSortMode } from '@hapi/protocol/types'

import type { SessionSortPreferenceUpdateResult, StoredSessionSortPreference } from './types'
import { getSessionSortPreferenceByUser, upsertSessionSortPreferenceByUser } from './sessionSortPreferences'

export class SessionSortPreferenceStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    getByUser(userId: number, namespace: string): StoredSessionSortPreference {
        return getSessionSortPreferenceByUser(this.db, userId, namespace)
    }

    upsertByUser(
        userId: number,
        namespace: string,
        preference: {
            sortMode: SessionSortMode
            manualOrder: SessionManualOrder
        },
        expectedVersion?: number
    ): SessionSortPreferenceUpdateResult {
        return upsertSessionSortPreferenceByUser(this.db, userId, namespace, preference, expectedVersion)
    }
}

import type { Database } from 'bun:sqlite'

import type { DraftData } from './drafts'
import { getDraft, setDraft, clearDraft } from './drafts'

export class DraftStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    getDraft(sessionId: string, namespace: string): DraftData | null {
        return getDraft(this.db, sessionId, namespace)
    }

    setDraft(sessionId: string, namespace: string, text: string, timestamp: number): DraftData {
        return setDraft(this.db, sessionId, namespace, text, timestamp)
    }

    clearDraft(sessionId: string, namespace: string): void {
        clearDraft(this.db, sessionId, namespace)
    }
}

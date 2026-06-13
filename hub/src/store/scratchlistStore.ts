import type { Database } from 'bun:sqlite'

import type { StoredScratchlistEntry } from './types'
import {
    countScratchlistEntries,
    createScratchlistEntry,
    deleteScratchlistEntry,
    getScratchlistEntry,
    listScratchlistEntries,
    updateScratchlistEntry,
    type CreateScratchlistResult
} from './scratchlist'

export class ScratchlistStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    list(sessionId: string): StoredScratchlistEntry[] {
        return listScratchlistEntries(this.db, sessionId)
    }

    count(sessionId: string): number {
        return countScratchlistEntries(this.db, sessionId)
    }

    get(sessionId: string, entryId: string): StoredScratchlistEntry | null {
        return getScratchlistEntry(this.db, sessionId, entryId)
    }

    create(
        sessionId: string,
        text: string,
        options?: { entryId?: string; createdAt?: number }
    ): CreateScratchlistResult {
        return createScratchlistEntry(this.db, sessionId, text, options)
    }

    update(
        sessionId: string,
        entryId: string,
        text: string
    ): StoredScratchlistEntry | null {
        return updateScratchlistEntry(this.db, sessionId, entryId, text)
    }

    delete(sessionId: string, entryId: string): boolean {
        return deleteScratchlistEntry(this.db, sessionId, entryId)
    }
}

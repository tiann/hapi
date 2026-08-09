import type { Database } from 'bun:sqlite'
import type {
    WorkGraphEvent,
    WorkGraphEventCreate,
    WorkGraphEventLink,
    WorkGraphEventLinkCreate
} from '@hapi/protocol'
import {
    getWorkGraphEventByNamespace,
    insertWorkGraphEvent,
    insertWorkGraphEventLink,
    listWorkGraphEventLinksForEvent,
    listWorkGraphEventsByRelatedSession,
    type InsertWorkGraphEventResult
} from './workGraph'

export class WorkGraphStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    insertEvent(
        namespace: string,
        input: WorkGraphEventCreate,
        options?: { id?: string; ts?: number }
    ): InsertWorkGraphEventResult {
        return insertWorkGraphEvent(this.db, namespace, input, options)
    }

    getEvent(eventId: string, namespace: string): WorkGraphEvent | null {
        return getWorkGraphEventByNamespace(this.db, eventId, namespace)
    }

    listByRelatedSession(
        namespace: string,
        relatedSessionId: string,
        options?: { limit?: number }
    ): WorkGraphEvent[] {
        return listWorkGraphEventsByRelatedSession(this.db, namespace, relatedSessionId, options)
    }

    insertLink(namespace: string, input: WorkGraphEventLinkCreate): WorkGraphEventLink {
        return insertWorkGraphEventLink(this.db, namespace, input)
    }

    listLinksForEvent(namespace: string, eventId: string): WorkGraphEventLink[] {
        return listWorkGraphEventLinksForEvent(this.db, namespace, eventId)
    }
}
